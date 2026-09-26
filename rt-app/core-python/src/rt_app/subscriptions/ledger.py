"""Credit ledger, pure part (port of ``packages/subscriptions/src/ledger.ts``).

An append-only, chronological statement per user (partition ``SUB_LEDGER#<userId>``). Every entry
is written in the same transaction as the account change it describes, so the statement and the
balances never disagree. Credits are signed: + credit, - debit.

Numbers follow JavaScript (float64, ``Number`` to ``String`` in keys and seeds), so keys, seeds and
totals are identical to the TypeScript reference; see ``spec/contracts/subscriptions-ledger``.
"""
from __future__ import annotations

import copy
import hashlib
import math
from collections.abc import Callable, Mapping, Sequence
from typing import Any, Literal, NotRequired, TypedDict

from ..nosql import Write
from .._jsnum import is_number, js_string, num, number_to_string, truthy, utf8

LedgerKind = Literal["allowance", "expiry", "usage", "grant", "purchase", "plan", "adjustment", "reset"]
LedgerSource = Literal["system", "admin", "billing", "user", "api"]

#: ``used(product_id, start)``: allowance consumed in a settled window.
Used = Callable[[str, float], float]


class LedgerEntry(TypedDict):
    id: str
    at: float
    kind: LedgerKind
    source: LedgerSource
    credits: float
    reason: str
    productId: NotRequired[str]
    planId: NotRequired[str]
    actorId: NotRequired[str]
    requestId: NotRequired[str]
    #: Money paid (purchase, plan) or recorded value (admin grant), in minor units.
    amountMinor: NotRequired[float]
    currency: NotRequired[str]
    #: Split of a usage debit between the plan allowance and additional credits.
    fromAllowance: NotRequired[float]
    fromBalance: NotRequired[float]
    #: Credits available for the product right after this entry.
    available: NotRequired[float]
    details: NotRequired[dict[str, str | float | bool]]


class LedgerTotals(TypedDict):
    creditsIn: float
    creditsOut: float
    expired: float
    #: Money actually paid, per currency (purchases and paid plans).
    paidMinor: dict[str, float]
    #: Value recorded for administrative assignments, per currency. Not a charge.
    grantedValueMinor: dict[str, float]


class WindowProduct(TypedDict):
    start: float
    allowance: float
    name: str
    weekSeconds: float


class WindowState(TypedDict):
    """Last settled allowance window per product, stored on the account (``ledgerWindows``)."""

    #: Entitlement identity: a different key (plan change, admin assignment) closes all windows.
    key: str
    products: dict[str, WindowProduct]


class CurrentProduct(TypedDict):
    id: str
    name: str
    weeklyLimit: float
    weekSeconds: float
    start: float


class CurrentWindow(TypedDict):
    key: str
    #: Current period; weekly windows restart at every period boundary (e.g. 30-day renewals).
    periodStart: float
    periodMs: float
    products: list[CurrentProduct]


class Rollover(TypedDict):
    entries: list[dict[str, Any]]
    state: WindowState | None


def empty_totals() -> LedgerTotals:
    return {"creditsIn": 0, "creditsOut": 0, "expired": 0, "paidMinor": {}, "grantedValueMinor": {}}


def ledger(user_id: str) -> str:
    """Statement partition key ``SUB_LEDGER#<userId>`` (TypeScript ``LEDGER``)."""
    return "SUB_LEDGER#" + js_string(user_id)


LEDGER = ledger


def ledger_key(at: float, seed: str, sequence: float | None = None) -> str:
    """Sort key: zero-padded time, the account's write sequence, then 16 hex chars of sha256(seed).

    Chronological for ``0 <= at < 1e15`` and ``0 <= sequence < 1e10``; padding never truncates.
    """
    sequence = 0 if sequence is None else sequence
    digest = hashlib.sha256(utf8(seed)).hexdigest()[:16]
    return number_to_string(at).rjust(15, "0") + "-" + number_to_string(sequence).rjust(10, "0") + "-" + digest


def ledger_write(user_id: str, entry: Mapping[str, Any], seed: str, sequence: float | None = None) -> dict[str, Any]:
    """The entry with its id and a conditional create (a replayed key never writes twice)."""
    key = ledger_key(entry["at"], seed, sequence)
    full = {**copy.deepcopy(dict(entry)), "id": key}
    write: Write = {"row": {"pk": ledger(user_id), "sk": key, "version": 1, "data": full}, "expected": None}
    return {"entry": copy.deepcopy(full), "write": write}


def _add(a: Any, b: Any) -> Any:
    """JavaScript ``a + b`` for numbers (float64); ``None`` (undefined) gives NaN."""
    if a is None or b is None:
        return math.nan
    return num(a) + num(b)


def _neg(a: Any) -> Any:
    return math.nan if a is None else -num(a)


def apply_totals(totals: Mapping[str, Any] | None, entry: Mapping[str, Any]) -> dict[str, Any]:
    """Fold one entry into the account's running totals. The input is never mutated."""
    nxt: dict[str, Any] = copy.deepcopy(dict(totals)) if totals is not None else dict(empty_totals())
    credits = entry.get("credits")
    if entry.get("kind") == "expiry":
        nxt["expired"] = _add(nxt.get("expired"), _neg(credits))
    elif is_number(credits) and credits > 0:
        nxt["creditsIn"] = _add(nxt.get("creditsIn"), credits)
    else:
        nxt["creditsOut"] = _add(nxt.get("creditsOut"), _neg(credits))
    amount, currency = entry.get("amountMinor"), entry.get("currency")
    if truthy(amount) and truthy(currency):
        name = "grantedValueMinor" if entry.get("kind") == "grant" or entry.get("source") == "admin" else "paidMinor"
        bucket = nxt[name]
        key = js_string(currency)
        previous = bucket.get(key)
        bucket[key] = _add(0 if previous is None else previous, amount)
    return nxt


# --- allowance windows ---------------------------------------------------------------------------


def _is_array_index(key: str) -> bool:
    """A canonical array index ("0".."4294967294"): JavaScript lists these keys first."""
    return key.isascii() and key.isdigit() and (key == "0" or key[0] != "0") and int(key) < 2**32 - 1


def js_own_keys(obj: Mapping[str, Any]) -> list[str]:
    """``Object.keys`` order: array-index keys ascending numerically, then the rest in insertion order."""
    keys = list(obj)
    indexes = sorted((k for k in keys if _is_array_index(k)), key=int)
    return indexes + [k for k in keys if not _is_array_index(k)]


def used_from(table: Mapping[str, Mapping[str, float]] | None) -> Used:
    """``used`` from a table ``{productId: {"<start>": credits}}``; missing entries are 0."""

    def used(product_id: str, start: float) -> float:
        product = table.get(product_id) if isinstance(table, Mapping) else None
        value = product.get(number_to_string(start)) if isinstance(product, Mapping) else None
        return 0 if value is None else value

    return used


def rollover(
    previous: WindowState | Mapping[str, Any] | None,
    current: CurrentWindow | Mapping[str, Any] | None,
    used: Used,
    now: float,
) -> Rollover:
    """Pure window accounting between the last settled state and the current usage windows.

    Closed windows expire their unused plan allowance; each new window grants a fresh one. Skipped
    windows (inactivity) fold into one expiry entry, so the statement stays bounded.
    """
    now = num(now)
    pending: list[dict[str, Any]] = []
    continuing = previous is not None and current is not None and previous["key"] == current["key"]
    products = previous.get("products") if previous is not None else None
    for product_id in js_own_keys(products or {}):
        assert products is not None
        window = products[product_id]
        start0 = num(window["start"])
        step = num(window["weekSeconds"]) * 1000
        nxt = None
        if continuing:
            assert current is not None
            nxt = next((p for p in current["products"] if p.get("id") == product_id), None)
        if nxt is not None and num(nxt["start"]) == start0:
            continue

        def following(start: float) -> float:
            # Same arithmetic as the usage counters: a window ends after `step` or at the period boundary.
            if current is None:
                return start + step
            period_start, period_ms = num(current["periodStart"]), num(current["periodMs"])
            period_end = period_start + (_floor((start - period_start) / period_ms) + 1) * period_ms
            return min(start + step, period_end)

        # A window closes at its natural end, or now when the entitlement changed mid-window.
        closed_at = min(following(start0), num(nxt["start"])) if nxt is not None else min(start0 + step, now)
        skipped = 0
        if nxt is not None:
            # Bounded walk over idle windows (about ten years of weekly windows at most).
            s = closed_at
            while s < num(nxt["start"]) and skipped < 520:
                skipped += 1
                s = following(s)
        allowance = num(window["allowance"])
        unused = max(0, allowance - num(used(product_id, start0)))
        expired = unused + skipped * allowance
        if expired > 0:
            name = js_string(window.get("name"))
            if skipped > 0:
                reason = f"{name}: unused allowance of {skipped + 1} weeks expired"
            elif nxt is not None:
                reason = f"{name}: unused weekly allowance expired"
            else:
                reason = f"{name}: allowance ended with the plan"
            assert previous is not None
            pending.append(
                {
                    "at": closed_at,
                    "kind": "expiry",
                    "credits": -expired,
                    "productId": product_id,
                    "reason": reason,
                    "details": {"unused": unused, "skippedWeeks": skipped},
                    # `now` distinguishes a window closed, reopened and closed again; the account
                    # version (same transaction) already prevents concurrent duplicates.
                    "seed": f"expiry:{js_string(previous['key'])}:{product_id}:{number_to_string(start0)}:{number_to_string(now)}",
                }
            )
    state: WindowState | None = None
    if current is not None:
        state = {
            "key": current["key"],
            "products": {
                js_string(p["id"]): {"start": p["start"], "allowance": p["weeklyLimit"], "name": p["name"], "weekSeconds": p["weekSeconds"]}
                for p in current["products"]
            },
        }
    for product in current["products"] if current is not None else []:
        if continuing:
            assert products is not None
            known = products.get(js_string(product["id"]))
            if known is not None and num(known["start"]) == num(product["start"]):
                continue
        start = num(product["start"])
        pending.append(
            {
                # A plan change mid-window opens the new allowance when it happens, after the old one closed.
                "at": max(start, now) if previous is not None and not continuing else start,
                "kind": "allowance",
                "credits": product["weeklyLimit"],
                "productId": product["id"],
                "reason": f"{js_string(product.get('name'))}: weekly allowance",
                "seed": f"allowance:{js_string(current['key'])}:{js_string(product['id'])}:{number_to_string(start)}:{number_to_string(now)}",  # type: ignore[index]
            }
        )
    return {"entries": _v8_order(pending), "state": state}


def _floor(x: float) -> float:
    return float(math.floor(x)) if math.isfinite(x) else x


def _v8_order(entries: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    """``entries.sort((a, b) => a.at - b.at || (a.kind === "expiry" ? -1 : 1))`` as V8 runs it.

    The comparator never returns 0, so the result is fixed by V8's TimSort: ascending by ``at``;
    within the same ``at``, expiries first in reverse generation order, then allowances in
    generation order (expiries are always generated before allowances).
    """

    def key(item: tuple[int, dict[str, Any]]) -> tuple[float, int, int]:
        index, entry = item
        expiry = entry["kind"] == "expiry"
        return (entry["at"], 0 if expiry else 1, -index if expiry else index)

    return [entry for _, entry in sorted(enumerate(entries), key=key)]


__all__ = [
    "LedgerKind",
    "LedgerSource",
    "LedgerEntry",
    "LedgerTotals",
    "WindowState",
    "CurrentWindow",
    "Rollover",
    "LEDGER",
    "ledger",
    "empty_totals",
    "ledger_key",
    "ledger_write",
    "apply_totals",
    "used_from",
    "rollover",
    "js_own_keys",
]
