"""The Subscriptions service (port of the ``Subscriptions`` class in
``packages/subscriptions/src/index.ts``): settings and plan catalog with versions, accounts, plan
changes through a ``BillingProvider``, credit consumption and records with the ledger, usage
windows, overview metrics, maintenance and the HTTP feature.

Data is plain JSON (dicts) with JavaScript semantics: float64 numbers, ``Math.round`` halves up,
``String(number)``, object spread and property order. The contracts are
``spec/contracts/subscriptions-{settings,accounts,usage,overview,api}.contract.yaml``; see
``docs/polyglot/subscriptions.md``.
"""
from __future__ import annotations

import copy
import math
import re
import time
import uuid
from collections.abc import Callable, Mapping
from datetime import datetime, timedelta, timezone
from typing import Any, Final, Literal, Protocol, runtime_checkable

from .. import _canonical, _js
from .._jsnum import js_round, js_string, js_trim, truthy, utf16_slice
from ..contracts import Clock, epoch_ms
from ..errors import Conflict, HttpError
from ..nosql import NoSQL, Row, Write
from .credits import estimate as price_request
from .credits import integer
from .currency import valid_currency, valid_minor_amount
from .ledger import apply_totals, empty_totals, js_own_keys, ledger, ledger_write, rollover
from .plans import (
    DEFAULTS,
    default_settings,
    identifier,
    next_version,
    plan_content,
    plan_id_from_name,
    validate_settings,
)

DAY: Final = 86400000
#: Body limit of the Stripe webhook endpoint (other endpoints use the 16 KiB default).
WEBHOOK_BODY_LIMIT: Final = 262_144


class _Undefined:
    """JavaScript ``undefined`` where it differs from ``null`` (missing request fields)."""

    def __repr__(self) -> str:
        return "undefined"


UNDEFINED: Final = _Undefined()

Mail = dict[str, str]
Notify = Callable[[Mail], Any]


@runtime_checkable
class BillingProvider(Protocol):
    """What the service needs from a payment provider (``LocalBilling``, Stripe…).

    Optional methods: ``validate_plan(plan, customer)`` and ``simulate(customer, status)``.
    ``publishable_key`` may be None.
    """

    mode: str

    def customer(self, user: Mapping[str, Any], key: str) -> str: ...

    def change(self, customer: str, plan: Mapping[str, Any], subscription_id: str | None, key: str) -> Any: ...

    def setup(self, customer: str, key: str) -> Any: ...

    def set_payment_method(self, customer: str, setup_id: str, subscription_id: str | None = None) -> None: ...

    def cancel(self, customer: str, subscription_id: str, key: str) -> Any: ...

    def snapshot(self, customer: str, subscription_id: str | None = None) -> Any: ...

    def verify(self, raw: str, signature: str) -> Mapping[str, Any]: ...


class CatalogPublisher(Protocol):
    """Publishes a plan version to the payment catalog: ``{stripePriceId, stripeProductId}``."""

    def publish(self, plan: Mapping[str, Any], namespace: str, previous: Mapping[str, Any] | None = None) -> Mapping[str, str]: ...


def _fail(kind: str) -> Exception:
    return TypeError("Not JSON")


def _digest(value: Any) -> str:
    """``sha256hex(JSON.stringify(value))``."""
    return _canonical.sha256_hex(_js.stringify(value))


def _same_content(a: Any, b: Any) -> bool:
    """Plan content equality (TypeScript compares digests of JSON.stringify in a fixed key order)."""
    return _canonical.canonical(a, _fail) == _canonical.canonical(b, _fail)


def _write(old: Row | None, pk: str, sk: str, data: Any) -> Write:
    """Version-guarded write of ``data`` (the same object: later mutations are written too)."""
    return {"row": {"pk": pk, "sk": sk, "version": (old["version"] if old else 0) + 1, "data": data}, "expected": old["version"] if old else None}


def _day_key(at: float) -> str:
    """``new Date(at).toISOString().slice(0, 10)``."""
    return _iso(at)[:10]


def _iso(at: float) -> str:
    moment = datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(milliseconds=at)
    return _js.iso_timestamp(moment)


def _lt(a: Any, b: Any) -> bool:
    """JavaScript ``a < b`` for numbers; undefined compares false."""
    return a is not None and b is not None and a < b


def _ge(a: Any, b: Any) -> bool:
    return a is not None and b is not None and a >= b


def _get(value: Any, name: str) -> Any:
    """``value?.[name]``."""
    return value.get(name) if isinstance(value, Mapping) else None


def _nullish(value: Any, fallback: Any) -> Any:
    """``value ?? fallback``."""
    return fallback if value is None or value is UNDEFINED else value


def _js_number(text: Any) -> float:
    """JavaScript ``Number(string)`` (query values)."""
    if not isinstance(text, str):
        return math.nan if text is None or isinstance(text, (dict, list)) else float(text)
    t = js_trim(text)
    if t == "":
        return 0.0
    if re.fullmatch(r"[+-]?Infinity", t):
        return -math.inf if t.startswith("-") else math.inf
    for prefix, base in (("0x", 16), ("0o", 8), ("0b", 2)):
        if t[:2].lower() == prefix:
            try:
                return float(int(t[2:], base)) if re.fullmatch(r"[0-9a-fA-F]+", t[2:]) else math.nan
            except ValueError:
                return math.nan
    if re.fullmatch(r"[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?", t):
        return float(t)
    return math.nan


def _js_str(value: Any) -> str:
    """``String(value)`` with undefined."""
    return "undefined" if value is UNDEFINED else js_string(value)


class Subscriptions:
    """Plans, accounts, credits and billing over a NoSQL store.

    ``provider`` is the payment provider (``LocalBilling`` locally; None disables payments),
    ``notify`` sends notification mail ``{to, subject, text}``, ``now`` is the clock (epoch ms or
    datetime; the system clock by default), ``catalog_factory(secret)`` builds the catalog
    publisher (plan publication is unavailable without it) and ``new_id`` generates audit and
    operation ids (random UUID v4 by default).
    """

    def __init__(
        self,
        store: NoSQL,
        provider: BillingProvider | None = None,
        notify: Notify | None = None,
        now: Clock | None = None,
        catalog_factory: Callable[[str | None], CatalogPublisher] | None = None,
        *,
        new_id: Callable[[], str] | None = None,
    ) -> None:
        self.store = store
        self.provider = provider
        self._notify = notify
        self._clock = now
        self._catalog_factory = catalog_factory
        self._new_id = new_id or (lambda: str(uuid.uuid4()))

    def now(self) -> float:
        return epoch_ms(self._clock)

    def feature(self) -> Any:
        """HTTP endpoints, admin entry and agent tools of this module (``rt_app.web.Feature``)."""
        from .feature import feature

        return feature(self)

    def _retry(self, fn: Callable[[], Any]) -> Any:
        for attempt in range(8):
            try:
                return fn()
            except Conflict:
                if attempt == 7:
                    raise
        raise HttpError(409, "Refresh and try again")  # unreachable, like the reference

    # --- settings and catalog -------------------------------------------------------------

    def settings(self) -> dict[str, Any]:
        row = self.store.get("SUB_CONFIG", "settings")
        data = row["data"] if row else None
        plans = data.get("plans") if data else None
        credits = data.get("credits") if data else None
        values = {
            **(data if data is not None else default_settings()),
            "plans": [{**p, "version": _nullish(p.get("version"), "0.0.1")} for p in (plans if plans is not None else copy.deepcopy(DEFAULTS["plans"]))],
            "credits": credits if credits is not None else copy.deepcopy(DEFAULTS["credits"]),
        }
        return {
            "version": row["version"] if row else 0,
            "values": values,
            "provider": self.provider.mode if self.provider else "none",
            "catalogAvailable": self._catalog_factory is not None,
            "catalogOperation": data.get("catalogOperation") if data else None,
        }

    def save_settings(self, input: Any, actor_id: str, restored: Mapping[str, str] | None = None) -> dict[str, Any]:
        """Validate and save ``{version, values}``; changed plans get a new version (see the contract)."""
        values = validate_settings(_get(input, "values"))
        old = self.store.get("SUB_CONFIG", "settings")
        if not _same_version(old["version"] if old else 0, _get(input, "version")):
            raise Conflict()
        if old and truthy(old["data"].get("catalogOperation")):
            raise HttpError(409, "Resume the pending Stripe synchronization before editing plans")
        history: list[Write] = []
        stored = old["data"].get("plans") if old else None
        previous_plans: list[Any] = stored if stored is not None else DEFAULTS["plans"]
        for prior in previous_plans:
            if not any(p["id"] == prior.get("id") for p in values["plans"]):
                raise HttpError(400, "Disable a plan instead of removing or renaming its ID")
        plans = []
        for plan in values["plans"]:
            prior = next((p for p in previous_plans if p.get("id") == plan["id"]), None)
            changed = prior is not None and (
                (restored is not None and restored.get("id") == plan["id"]) or not _same_content(plan_content(prior), plan_content(plan))
            )
            version = _nullish(prior.get("version") if prior else None, "0.0.1")
            if changed:
                history.append(_write(None, "SUB_PLAN_HISTORY#" + js_string(prior["id"]), version, copy.deepcopy(prior)))
            saved = {**plan, "stripeManaged": bool(prior and truthy(prior.get("stripeManaged"))), "version": next_version(version) if changed else version}
            saved.pop("stripePriceId", None)
            if not changed and prior and truthy(prior.get("stripePriceId")):
                saved["stripePriceId"] = prior["stripePriceId"]
            if not changed and prior and truthy(prior.get("stripeProductId")):
                saved["stripeProductId"] = prior["stripeProductId"]
            plans.append(saved)
        values["plans"] = plans
        if values["paymentRequired"] and self.provider is None:
            raise HttpError(400, "Configure a payment adapter before requiring payments")
        data = dict(values)
        namespace = old["data"].get("catalogNamespace") if old else None
        if namespace is not None:
            data["catalogNamespace"] = namespace
        audit: dict[str, Any] = {"action": "settings"}
        if restored is not None:
            audit.update({"restoredPlan": restored["id"], "restoredFrom": restored["version"]})
        audit.update({"actorId": actor_id, "at": self.now()})
        self.store.transact([_write(old, "SUB_CONFIG", "settings", data), *history, _write(None, "SUB_AUDIT", self._new_id(), audit)])
        return self.settings()

    def edit_plan(self, action: str, input: Any, actor_id: str) -> dict[str, Any]:
        """Apply one catalog action (create, update, archive, unarchive, version) through the
        same versioned settings transaction as the admin UI."""
        settings = self.settings()
        if not _same_version(settings["version"], _get(input, "version")):
            raise Conflict()
        plans = settings["values"]["plans"]
        index = next((i for i, p in enumerate(plans) if p.get("id") == _get(input, "id")), -1)
        if action == "create":
            plan = _get(input, "plan")
            if not truthy(plan) or not isinstance(_get(plan, "name"), str):
                raise HttpError(400, "plan.name is required")
            new_id = plan_id_from_name(plan["name"], [p.get("id") for p in plans])
            family = plan.get("family")
            plans.append({**plan, "id": new_id, "family": family if truthy(family) else new_id, "enabled": False})
        else:
            if index < 0:
                raise HttpError(404, "Plan not found")
            if action == "update":
                patch = _get(input, "plan")
                plans[index] = {**plans[index], **(patch if isinstance(patch, Mapping) else {}), "id": plans[index]["id"]}
            elif action in ("archive", "unarchive"):
                plans[index] = {**plans[index], "archived": action == "archive", "enabled": False}
            elif action != "version":
                raise HttpError(400, "Unknown plan action")
        # Publication is explicit: callers can inspect the saved version before touching Stripe.
        restored = {"id": _get(input, "id"), "version": _nullish(plans[index].get("version"), "0.0.1")} if action == "version" else None
        return self.save_settings(settings, actor_id, restored)

    def restore_plan(self, plan_id: str, input: Any, actor_id: str) -> dict[str, Any]:
        """Restore a history snapshot as a new version (current availability kept)."""
        from_version = _get(input, "fromVersion")
        if not isinstance(from_version, str) or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", from_version):
            raise HttpError(400, "Invalid plan version")
        previous = self.store.get("SUB_PLAN_HISTORY#" + plan_id, from_version)
        if previous is None:
            raise HttpError(404, "Plan version not found")
        settings = self.settings()
        if not _same_version(settings["version"], _get(input, "version")):
            raise Conflict()
        if not any(p.get("id") == plan_id for p in settings["values"]["plans"]):
            raise HttpError(404, "Plan not found")
        settings["values"]["plans"] = [
            {**previous["data"], "id": plan_id, "enabled": p.get("enabled"), "archived": p.get("archived")} if p.get("id") == plan_id else p
            for p in settings["values"]["plans"]
        ]
        return self.save_settings(settings, actor_id, {"id": plan_id, "version": from_version})

    def link_stripe_prices(self, links: Mapping[str, Any], actor_id: str) -> list[str]:
        """Attach Stripe ids created outside the app (e.g. Terraform) to plans; plan content and
        versions do not change. Returns the ids of the plans whose ids changed."""
        old = self.store.get("SUB_CONFIG", "settings")
        if old and truthy(old["data"].get("catalogOperation")):
            raise HttpError(409, "Resume the pending Stripe synchronization before linking prices")
        stored = old["data"].get("plans") if old else None
        plans: list[dict[str, Any]] = stored if stored is not None else copy.deepcopy(DEFAULTS["plans"])
        for plan_id in js_own_keys(links):
            ids = links[plan_id]
            if not any(p.get("id") == plan_id for p in plans):
                raise HttpError(404, "Plan not found: " + plan_id)
            product, price = _get(ids, "productId"), _get(ids, "priceId")
            if not re.fullmatch(r"prod_[A-Za-z0-9]{1,250}", _js_str(_undefined(product))) or not re.fullmatch(r"price_[A-Za-z0-9]{1,250}", _js_str(_undefined(price))):
                raise HttpError(400, "Invalid Stripe ids for " + plan_id)
        linked = [
            p
            for p in plans
            if truthy(links.get(p.get("id")))
            and (p.get("stripePriceId") != links[p["id"]]["priceId"] or p.get("stripeProductId") != links[p["id"]]["productId"])
        ]
        if not linked:
            return []
        taken = {p.get("stripePriceId") for p in plans if not truthy(links.get(p.get("id"))) and truthy(p.get("stripePriceId"))}
        if any(links[p["id"]]["priceId"] in taken for p in linked) or len({links[k]["priceId"] for k in links}) != len(links):
            raise HttpError(400, "A Stripe price can belong to one plan only")
        data = {
            **(old["data"] if old else default_settings()),
            "plans": [
                {**p, "stripeProductId": links[p["id"]]["productId"], "stripePriceId": links[p["id"]]["priceId"]} if truthy(links.get(p.get("id"))) else p
                for p in plans
            ],
        }
        ids = [p["id"] for p in linked]
        self.store.transact(
            [
                _write(old, "SUB_CONFIG", "settings", data),
                _write(None, "SUB_AUDIT", self._new_id(), {"action": "link-stripe-prices", "plans": ids, "actorId": actor_id, "at": self.now()}),
            ]
        )
        return ids

    def publish_plan(self, plan_id: str, input: Any, actor_id: str) -> dict[str, Any]:
        """Publish a saved plan to the catalog, persisting the operation first so a failure can be
        resumed (the secret key is never stored)."""
        if self._catalog_factory is None:
            raise HttpError(503, "Stripe catalog is not configured")
        secret = _get(input, "secretKey")
        publisher = self._catalog_factory(secret if truthy(secret) else None)
        row = self.store.get("SUB_CONFIG", "settings")
        if row is None:
            raise HttpError(409, "Save your plans first")
        operation = row["data"].get("catalogOperation")
        if truthy(operation) and operation.get("planId") != plan_id:
            raise HttpError(409, "Resume the pending plan synchronization first")
        if not truthy(operation):
            if not _same_version(row["version"], _get(input, "version")):
                raise Conflict()
            plan = next((p for p in row["data"].get("plans") or [] if p.get("id") == plan_id), None)
            if plan is None:
                raise HttpError(404, "Plan not found")
            last = self.store.get("SUB_CATALOG_LAST", plan_id)
            operation = {"id": self._new_id(), "planId": plan_id, "plan": plan, "previous": _get(last["data"] if last else None, "plan"), "actorId": actor_id, "at": self.now()}
            namespace = row["data"].get("catalogNamespace")
            self.store.transact(
                [_write(row, "SUB_CONFIG", "settings", {**row["data"], "catalogNamespace": namespace if namespace is not None else self._new_id(), "catalogOperation": operation})]
            )
            row = self.store.get("SUB_CONFIG", "settings")
            assert row is not None
        # The persisted snapshot is immutable until publication finishes. Secrets are never persisted.
        result = dict(publisher.publish(operation["plan"], row["data"].get("catalogNamespace"), operation.get("previous")))
        current = self.store.get("SUB_CONFIG", "settings")
        assert current is not None
        pending = current["data"].get("catalogOperation")
        if not truthy(pending):
            return self.settings()
        if pending.get("id") != operation["id"]:
            raise Conflict()
        plan = {**operation["plan"], **result, "stripeManaged": True}
        last = self.store.get("SUB_CATALOG_LAST", plan_id)
        price = self.store.get("SUB_PLAN_PRICES", result["stripePriceId"])
        config = {k: v for k, v in current["data"].items() if k != "catalogOperation"}
        config["plans"] = [plan if p.get("id") == plan_id else p for p in current["data"].get("plans") or []]
        self.store.transact(
            [
                _write(current, "SUB_CONFIG", "settings", config),
                _write(last, "SUB_CATALOG_LAST", plan_id, {"plan": plan}),
                _write(price, "SUB_PLAN_PRICES", result["stripePriceId"], {"plan": plan}),
                _write(None, "SUB_AUDIT", self._new_id(), {"action": "publish-plan", "planId": plan_id, "version": plan.get("version"), "actorId": actor_id, "at": self.now()}),
            ]
        )
        return self.settings()

    # --- accounts and entitlements -----------------------------------------------------------

    def _account(self, user_id: str) -> Row | None:
        return self.store.get("SUB_ACCOUNTS", user_id)

    def _normalized(self, data: Any) -> dict[str, Any]:
        """Renew unpaid periods and move the day/week windows forward (a copy)."""
        nxt: dict[str, Any] = copy.deepcopy(dict(data)) if isinstance(data, Mapping) else {}
        now = self.now()
        plan = nxt.get("plan")
        if nxt.get("mode") == "none" and truthy(plan) and nxt.get("status") == "active" and not truthy(nxt.get("cancelAtPeriodEnd")) and _ge(now, nxt.get("periodEnd")):
            step = plan["periodDays"] * 86400000
            periods = math.floor((now - nxt["periodStart"]) / step)
            nxt["periodStart"] += periods * step
            nxt["periodEnd"] = nxt["periodStart"] + step
            nxt["counters"] = {}
        for product in (_get(plan, "products") or []) if truthy(plan) else []:
            counters = nxt.get("counters")
            counter = counters.get(product["id"]) if isinstance(counters, Mapping) else None
            if not truthy(counter):
                if counters is None:
                    counters = nxt["counters"] = {}
                counter = counters[product["id"]] = {
                    "period": 0,
                    "day": 0,
                    "week": 0,
                    "dayStart": nxt.get("periodStart"),
                    "weekStart": nxt.get("periodStart"),
                }
            for window, seconds in (("day", product["daySeconds"]), ("week", product["weekSeconds"])):
                field = window + "Start"
                if _ge(now, _add(counter.get(field), seconds * 1000)):
                    counter[field] += math.floor((now - counter[field]) / (seconds * 1000)) * seconds * 1000
                    counter[window] = 0
        if truthy(nxt.get("adminGrant")):
            nxt["adminGrant"] = self._normalized(nxt["adminGrant"])
        return nxt

    def _effective(self, data: Mapping[str, Any]) -> Mapping[str, Any]:
        grant = data.get("adminGrant")
        if isinstance(grant, Mapping) and grant.get("status") == "active" and _lt(self.now(), grant.get("periodEnd")):
            return grant
        return data

    def _valid(self, data: Any) -> None:
        if not truthy(_get(data, "plan")) or data.get("status") != "active" or _ge(self.now(), data.get("periodEnd")):
            raise HttpError(402, "Subscription is inactive or expired")

    # --- credit ledger (helpers mutate `data` and return writes for the caller's transaction) --

    def _allowance_left(self, data: Mapping[str, Any], product_id: str) -> float:
        """Plan allowance usable now: the tightest of the day, week and period windows."""
        entitlement = self._effective(data)
        if not truthy(entitlement.get("plan")) or entitlement.get("status") != "active" or _ge(self.now(), entitlement.get("periodEnd")):
            return 0
        product = next((p for p in entitlement["plan"].get("products") or [] if p.get("id") == product_id), None)
        counter = _get(entitlement.get("counters"), product_id)
        if product is None or not truthy(counter):
            return 0
        return max(0, min(product["dailyLimit"] - counter["day"], product["weeklyLimit"] - counter["week"], product["credits"] - counter["period"]))

    def _balance(self, data: Mapping[str, Any], product_id: str) -> Any:
        return _nullish(_get(data.get("creditBalance"), product_id), 0)

    def _available(self, data: Mapping[str, Any], product_id: str) -> Any:
        """Remaining plan allowance plus additional (non-expiring) credits."""
        return self._allowance_left(data, product_id) + self._balance(data, product_id)

    def _windows(self, data: Mapping[str, Any]) -> dict[str, Any] | None:
        """Allowance windows of the active entitlement, keyed so a plan change closes the previous ones."""
        entitlement = self._effective(data)
        if not truthy(entitlement.get("plan")) or entitlement.get("status") != "active" or _ge(self.now(), entitlement.get("periodEnd")):
            return None
        plan = entitlement["plan"]
        counters = entitlement.get("counters")
        return {
            "key": ("own:" if entitlement is data else "admin:") + js_string(plan.get("id")),
            "periodStart": entitlement["periodStart"],
            "periodMs": plan["periodDays"] * 86400000,
            "products": [
                {
                    "id": p["id"],
                    "name": p["name"],
                    "weeklyLimit": p["weeklyLimit"],
                    "weekSeconds": p["weekSeconds"],
                    "start": _nullish(_get(_get(counters, p["id"]), "weekStart"), entitlement["periodStart"]),
                }
                for p in plan.get("products") or []
            ],
        }

    def _pending_windows(self, raw: Any, data: Mapping[str, Any]) -> dict[str, Any]:
        """Allowance/expiry entries owed since the last write, from the stored counters."""
        previous = _get(raw, "ledgerWindows")
        previous = previous if isinstance(previous, Mapping) else None
        admin = previous is not None and js_string(previous.get("key")).startswith("admin:")
        counters = _get(_get(raw, "adminGrant"), "counters") if admin else _get(raw, "counters")

        def used(product_id: str, start: float) -> Any:
            counter = _get(counters, product_id)
            return counter["week"] if isinstance(counter, Mapping) and counter.get("weekStart") == start else 0

        return rollover(previous, self._windows(data), used, self.now())

    def _ledger_entry(self, user_id: str, data: dict[str, Any], entry: Mapping[str, Any], seed: str) -> Write:
        """Append one statement entry and fold it into the account totals."""
        data["ledgerSequence"] = _nullish(data.get("ledgerSequence"), 0) + 1
        full = dict(entry)
        if truthy(entry.get("productId")):
            full["available"] = self._available(data, entry["productId"])
        written = ledger_write(user_id, full, seed, data["ledgerSequence"])
        data["ledgerTotals"] = apply_totals(data.get("ledgerTotals"), written["entry"])
        return written["write"]

    def _settle(self, user_id: str, raw: Any, data: dict[str, Any]) -> list[Write]:
        """Persist the window rollover (weekly allowance and expiry) before any other change."""
        pending = self._pending_windows(raw, data)
        data["ledgerWindows"] = pending["state"]
        writes = []
        for item in pending["entries"]:
            entry = {k: v for k, v in item.items() if k != "seed"}
            writes.append(self._ledger_entry(user_id, data, {**entry, "source": "system"}, item["seed"]))
        return writes

    def _stats_write(self, event: Literal["new", "canceled"]) -> Write:
        """Daily subscription statistics for the overview (new and canceled subscriptions)."""
        key = "day:" + _day_key(self.now())
        row = self.store.get("SUB_STATS", key)
        data = {"new": 0, "canceled": 0, **(row["data"] if row else {})}
        data[event] += 1
        return _write(row, "SUB_STATS", key, data)

    # --- personal endpoints --------------------------------------------------------------

    def me(self, user_id: str) -> dict[str, Any]:
        row = self._account(user_id)
        settings = self.settings()
        data = self._normalized(row["data"]) if row else {"userId": user_id, "status": "none", "counters": {}, "notifications": True}
        entitlement = self._effective(data)
        operation = data.get("billingOperation")
        safe = {k: v for k, v in data.items() if k not in ("billingOperation", "adminGrant")}
        effective = {**safe, **({} if entitlement is data else entitlement), "userId": user_id}
        pending = self.store.get("SUB_BILLING_OP#" + user_id, operation) if truthy(operation) else None
        payment_required = settings["values"]["paymentRequired"]
        usage = []
        for product in _get(entitlement.get("plan"), "products") or []:
            counter = entitlement["counters"][product["id"]]
            usage.append(
                {
                    **product,
                    "used": counter["period"],
                    "remaining": self._available(data, product["id"]),
                    "allowanceLeft": self._allowance_left(data, product["id"]),
                    "extraCredits": self._balance(data, product["id"]),
                    "dayUsed": counter["day"],
                    "weekUsed": counter["week"],
                    "dayResetAt": counter["dayStart"] + product["daySeconds"] * 1000,
                    "weekResetAt": counter["weekStart"] + product["weekSeconds"] * 1000,
                }
            )
        return {
            **effective,
            "assignedByAdmin": entitlement is not data,
            "pendingBillingRequest": {
                "requestId": operation,
                "action": _get(pending["data"].get("input"), "action"),
                "planId": _get(pending["data"].get("input"), "planId"),
            }
            if pending
            else None,
            "active": entitlement.get("status") == "active"
            and _lt(self.now(), entitlement.get("periodEnd"))
            and (not payment_required or entitlement.get("mode") == "admin" or (self.provider is not None and entitlement.get("mode") == self.provider.mode)),
            "version": row["version"] if row else 0,
            "paymentRequired": payment_required,
            "provider": self.provider.mode if self.provider else "none",
            "publishableKey": getattr(self.provider, "publishable_key", None) if self.provider else None,
            "plans": [p for p in settings["values"]["plans"] if truthy(p.get("enabled"))],
            "usage": usage,
        }

    def preferences(self, user_id: str, enabled: Any) -> dict[str, Any]:
        if not isinstance(enabled, bool):
            raise HttpError(400, "Invalid notification preference")

        def run() -> dict[str, Any]:
            row = self._account(user_id)
            self.store.transact([_write(row, "SUB_ACCOUNTS", user_id, {**(row["data"] if row else {}), "userId": user_id, "notifications": enabled})])
            return {"ok": True}

        return self._retry(run)

    def change(self, user: Mapping[str, Any], plan_id: str, key: str) -> Any:
        """Select a plan: directly in unpaid mode, through the payment provider when payments are required."""
        identifier(key)
        user_id = user["id"]
        existing = self._account(user_id)
        if existing and truthy(existing["data"].get("adminGrant")) and self._effective(existing["data"]) is not existing["data"]:
            raise HttpError(409, "An administrator-assigned plan is active. Contact your administrator to change it.")
        config = self.settings()
        plan = next((p for p in config["values"]["plans"] if p.get("id") == plan_id and truthy(p.get("enabled"))), None)
        if plan is None:
            raise HttpError(404, "Plan not found")
        paid = config["values"]["paymentRequired"]
        if paid and self.store.get("SUB_BILLING_OP#" + user_id, key) is None:
            validate = getattr(self.provider, "validate_plan", None) if self.provider else None
            if validate is not None:
                account = self._account(user_id)
                validate(plan, _get(account["data"] if account else None, "customerId"))
        if paid:

            def run(data: Mapping[str, Any], request: Mapping[str, Any]) -> Any:
                selected = request["plan"]
                assert self.provider is not None
                result = self.provider.change(data["customerId"], selected, data.get("subscriptionId"), key)
                return {**result, "requestedPlan": selected}

            return self._billing_operation(user, key, {"action": "change", "planId": plan_id, "plan": plan}, run)

        def unpaid() -> Any:
            old = self._account(user_id)
            op = self.store.get("SUB_OP#" + user_id, key)
            if op:
                if op["data"].get("planId") != plan_id:
                    raise Conflict()
                return op["data"].get("result")
            previous = old["data"] if old else None
            if previous and (truthy(previous.get("customerId")) or truthy(previous.get("subscriptionId"))):
                raise HttpError(409, "Cancel and reconcile the paid subscription before switching to unpaid mode")
            now = self.now()
            continuing = previous is not None and previous.get("status") == "active" and _lt(now, previous.get("periodEnd"))
            if continuing and _get(previous.get("plan"), "id") == plan_id:
                raise HttpError(409, "Already subscribed to this plan")
            data = self._normalized(
                {
                    **(previous or {}),
                    "userId": user_id,
                    "email": user.get("email"),
                    "plan": plan,
                    "status": "active",
                    "mode": "none",
                    "cancelAtPeriodEnd": False,
                    "periodStart": previous["periodStart"] if continuing else now,
                    "periodEnd": previous["periodEnd"] if continuing else now + plan["periodDays"] * 86400000,
                    "counters": previous.get("counters") if continuing else {},
                    "createdAt": _nullish(_get(previous, "createdAt"), now),
                    "updatedAt": now,
                }
            )
            result = {"ok": True}
            settled = self._settle(user_id, previous, data)
            plan_entry = self._ledger_entry(
                user_id,
                data,
                {
                    "at": now,
                    "kind": "plan",
                    "source": "user",
                    "credits": 0,
                    "planId": plan_id,
                    "reason": ("Plan changed to " if continuing else "Plan started: ") + js_string(plan.get("name")),
                    "requestId": key,
                },
                "plan:" + key,
            )
            self.store.transact(
                [
                    _write(old, "SUB_ACCOUNTS", user_id, data),
                    _write(None, "SUB_OP#" + user_id, key, {"planId": plan_id, "result": result}),
                    plan_entry,
                    *settled,
                    *([] if continuing else [self._stats_write("new")]),
                    _write(None, "SUB_AUDIT", self._new_id(), {"userId": user_id, "action": "plan-change", "planId": plan_id, "at": now}),
                ]
            )
            return result

        return self._retry(unpaid)

    def _billing_operation(self, user: Mapping[str, Any], key: str, input: Mapping[str, Any], run: Callable[[Mapping[str, Any], Mapping[str, Any]], Any]) -> Any:
        provider = self.provider
        if provider is None:
            raise HttpError(503, "Payments are not configured")
        identifier(key)
        user_id = user["id"]
        fingerprint = _digest({k: v for k, v in input.items() if k != "plan"})
        old = self._account(user_id)
        operation = self.store.get("SUB_BILLING_OP#" + user_id, key)
        if operation and operation["data"].get("fingerprint") != fingerprint:
            raise Conflict()
        if operation and truthy(operation["data"].get("result")):
            return operation["data"]["result"]
        pending = old["data"].get("billingOperation") if old else None
        if truthy(pending) and pending != key:
            raise HttpError(409, "Another billing operation is pending. Retry it before starting a new one.")
        if operation is None:
            self.store.transact(
                [
                    _write(None, "SUB_BILLING_OP#" + user_id, key, {"fingerprint": fingerprint, "input": dict(input), "started": self.now()}),
                    _write(old, "SUB_ACCOUNTS", user_id, {**(old["data"] if old else {}), "userId": user_id, "email": user.get("email"), "billingOperation": key}),
                ]
            )
        elif self.now() - operation["data"]["started"] > 23 * 3600000:
            raise HttpError(409, "Billing operation needs reconciliation; do not create another payment")
        old = self._account(user_id)
        if not truthy(_get(old["data"] if old else None, "customerId")):
            customer_id = provider.customer(user, "customer-" + user_id)

            def save_customer() -> None:
                row = self._account(user_id)
                assert row is not None
                mapping = self.store.get("SUB_CUSTOMERS", customer_id)
                self.store.transact(
                    [
                        _write(row, "SUB_ACCOUNTS", user_id, {**row["data"], "customerId": customer_id}),
                        *([] if mapping else [_write(None, "SUB_CUSTOMERS", customer_id, {"userId": user_id})]),
                    ]
                )

            self._retry(save_customer)
        account = self._account(user_id)
        op = self.store.get("SUB_BILLING_OP#" + user_id, key)
        assert account is not None and op is not None
        result = run(account["data"], op["data"]["input"])

        def finish() -> None:
            row = self._account(user_id)
            stored = self.store.get("SUB_BILLING_OP#" + user_id, key)
            assert row is not None and stored is not None
            if truthy(stored["data"].get("result")):
                return
            if row["data"].get("billingOperation") != key:
                raise Conflict()
            data = {**row["data"], "billingOperation": None}
            if truthy(_get(result, "subscriptionId")):
                data["subscriptionId"] = result["subscriptionId"]
            if truthy(_get(result, "requestedPlan")):
                data["pendingPlan"] = result["requestedPlan"]
            self.store.transact([_write(row, "SUB_ACCOUNTS", user_id, data), _write(stored, stored["pk"], stored["sk"], {**stored["data"], "result": result})])

        self._retry(finish)
        self.sync(user_id)
        return result

    def setup_payment(self, user: Mapping[str, Any], key: str) -> Any:
        return self._billing_operation(user, key, {"action": "setup"}, lambda data, _: self.provider.setup(data["customerId"], key))  # type: ignore[union-attr]

    def set_payment(self, user: Mapping[str, Any], setup_id: Any) -> dict[str, Any]:
        row = self._account(user["id"])
        if not truthy(_get(row["data"] if row else None, "customerId")) or self.provider is None:
            raise HttpError(400, "No billing customer")
        assert row is not None
        self.provider.set_payment_method(row["data"]["customerId"], identifier(setup_id), row["data"].get("subscriptionId"))
        return {"ok": True}

    def cancel(self, user: Mapping[str, Any], key: str) -> Any:
        user_id = user["id"]
        row = self._account(user_id)
        if row and truthy(row["data"].get("subscriptionId")) and self.provider is not None:
            provider = self.provider
            return self._billing_operation(user, key, {"action": "cancel"}, lambda data, _: provider.cancel(data["customerId"], data["subscriptionId"], key))

        def run() -> dict[str, Any]:
            row = self._account(user_id)
            if row is None or not truthy(self._effective(row["data"]).get("plan")):
                raise HttpError(404, "No subscription")
            if truthy(row["data"].get("cancelAtPeriodEnd")):
                return {"ok": True}
            data = {**row["data"], "cancelAtPeriodEnd": True}
            account = _write(row, "SUB_ACCOUNTS", user_id, data)
            entry = self._ledger_entry(
                user_id,
                data,
                {
                    "at": self.now(),
                    "kind": "plan",
                    "source": "user",
                    "credits": 0,
                    "planId": _get(row["data"].get("plan"), "id"),
                    "reason": "Subscription canceled; access continues until the period ends",
                    "requestId": key,
                },
                "cancel:" + key,
            )
            self.store.transact([account, entry, self._stats_write("canceled")])
            return {"ok": True}

        return self._retry(run)

    def sync(self, user_id: str) -> None:
        """Reconcile the account with the provider's current subscription state."""
        provider = self.provider
        if provider is None:
            return
        old = self._account(user_id)
        if old is None or not truthy(old["data"].get("customerId")):
            return
        previous = old["data"]
        snapshot = provider.snapshot(previous["customerId"], previous.get("subscriptionId"))
        if not truthy(_get(snapshot, "subscriptionId")):
            return
        # Remote retrieval precedes a conditional write: conflicting syncs are retried with a fresh snapshot.
        config = self.settings()
        if provider.mode == "local":
            plan = _nullish(previous.get("pendingPlan"), previous.get("plan"))
        else:
            price_id = snapshot.get("priceId")
            mapped = self.store.get("SUB_PLAN_PRICES", price_id) if isinstance(price_id, str) else None
            plan = _get(mapped["data"] if mapped else None, "plan")
            if plan is None:
                plan = next((p for p in config["values"]["plans"] if p.get("stripePriceId") == price_id), None)
            if plan is None:
                plan = previous.get("plan") if _get(previous.get("plan"), "stripePriceId") == price_id else None
        if not truthy(plan):
            raise HttpError(409, "Stripe price is not mapped to a configured plan")
        renewed = previous.get("periodStart") != snapshot.get("periodStart")
        data = self._normalized(
            {
                **previous,
                **snapshot,
                "plan": plan,
                "mode": provider.mode,
                "counters": {} if renewed else previous.get("counters"),
                "updatedAt": self.now(),
                "createdAt": _nullish(previous.get("createdAt"), self.now()),
            }
        )
        now = self.now()
        was_active = previous.get("status") == "active" and truthy(previous.get("plan")) and _lt(now, previous.get("periodEnd"))
        is_active = data.get("status") == "active" and _lt(now, data.get("periodEnd"))
        # A payment problem (past_due, incomplete) is neither a new subscription nor a cancellation.
        was_subscribed = truthy(previous.get("plan")) and previous.get("status") != "canceled" and _lt(now, previous.get("periodEnd"))
        writes = [*self._settle(user_id, previous, data)]
        # Billing events on the statement: paid period (start, renewal or plan change) and cancellation.
        if is_active and (renewed or _get(previous.get("plan"), "id") != plan.get("id")):
            reason = ("Plan renewed: " if renewed else "Plan changed to ") if was_active else "Plan started: "
            writes.append(
                self._ledger_entry(
                    user_id,
                    data,
                    {
                        "at": now,
                        "kind": "plan",
                        "source": "billing",
                        "credits": 0,
                        "planId": plan.get("id"),
                        "reason": reason + js_string(plan.get("name")),
                        "amountMinor": plan.get("amount"),
                        "currency": plan.get("currency"),
                    },
                    "billing:" + js_string(plan.get("id")) + ":" + js_string(data.get("periodStart")) + ":" + self._new_id(),
                )
            )
        if is_active and not was_subscribed:
            writes.append(self._stats_write("new"))
        canceled = (truthy(data.get("cancelAtPeriodEnd")) and not truthy(previous.get("cancelAtPeriodEnd"))) or (
            data.get("status") == "canceled" and previous.get("status") != "canceled" and not truthy(previous.get("cancelAtPeriodEnd"))
        )
        if canceled:
            writes.append(
                self._ledger_entry(
                    user_id,
                    data,
                    {"at": now, "kind": "plan", "source": "billing", "credits": 0, "planId": plan.get("id"), "reason": "Subscription canceled: " + js_string(plan.get("name"))},
                    "billing-cancel:" + js_string(plan.get("id")) + ":" + self._new_id(),
                )
            )
            writes.append(self._stats_write("canceled"))
        self.store.transact([_write(old, "SUB_ACCOUNTS", user_id, data), *writes])

    def billing(self, user_id: str) -> Any:
        row = self._account(user_id)
        customer = _get(row["data"] if row else None, "customerId")
        if truthy(customer) and self.provider is not None:
            assert row is not None
            return self.provider.snapshot(customer, row["data"].get("subscriptionId"))
        return {"invoices": [], "paymentMethods": [], "amountDue": 0, "totalPaid": 0, "currency": None}

    # --- credits -------------------------------------------------------------------------

    def consume(self, user_id: str, product_id: str, credits: Any, request_id: Any, meta: Mapping[str, Any] | None = None) -> dict[str, Any]:
        """Atomic pre-charge: plan allowance first, then additional credits. A stable request id
        never charges twice (``replayed``). 402 without an active entitlement, 429 without credits."""
        identifier(request_id)
        integer(credits, 1)
        meta = meta or {}

        def run() -> dict[str, Any]:
            op = self.store.get("SUB_USAGE#" + user_id, request_id)
            if op:
                if op["data"].get("productId") != product_id or op["data"].get("credits") != credits:
                    raise Conflict()
                return {**op["data"], "replayed": True}
            old = self._account(user_id)
            data = self._normalized(old["data"] if old else {})
            entitlement = self._effective(data)
            self._valid(entitlement)
            if self.settings()["values"]["paymentRequired"] and entitlement.get("mode") != "admin" and (self.provider is None or entitlement.get("mode") != self.provider.mode):
                raise HttpError(402, "A paid subscription is required")
            product = next((p for p in entitlement["plan"].get("products") or [] if p.get("id") == product_id), None)
            if product is None:
                raise HttpError(403, "Product is not included in your plan")
            settled = self._settle(user_id, old["data"] if old else None, data)
            counter = entitlement["counters"][product_id]
            balance = self._balance(data, product_id)
            from_allowance = min(credits, self._allowance_left(data, product_id))
            from_balance = credits - from_allowance
            if from_balance > balance:
                window = "day" if counter["day"] >= product["dailyLimit"] else "week" if counter["week"] >= product["weeklyLimit"] else "period"
                raise HttpError(429, f"Subscription {window} limit reached. Add credits or wait for the reset.")
            if data.get("creditBalance") is None:
                data["creditBalance"] = {}
            data["creditBalance"][product_id] = balance - from_balance
            # Window counters track the plan allowance only; additional credits live in creditBalance.
            counter["period"] += from_allowance
            counter["day"] += from_allowance
            counter["week"] += from_allowance
            data["totalConsumed"] = _nullish(data.get("totalConsumed"), 0) + credits
            at = self.now()
            receipt = {
                "requestId": request_id,
                "productId": product_id,
                "credits": credits,
                "fromAllowance": from_allowance,
                "fromBalance": from_balance,
                "at": at,
                "replayed": False,
            }
            entry: dict[str, Any] = {
                "at": at,
                "kind": _nullish(meta.get("kind"), "usage"),
                "source": _nullish(meta.get("source"), "api"),
                "credits": -credits,
                "productId": product_id,
                "reason": _nullish(meta.get("reason"), js_string(product.get("name")) + " usage"),
                "requestId": request_id,
                "fromAllowance": from_allowance,
                "fromBalance": from_balance,
            }
            if truthy(meta.get("actorId")):
                entry["actorId"] = meta["actorId"]
            if truthy(meta.get("details")):
                entry["details"] = meta["details"]
            written = self._ledger_entry(user_id, data, entry, "usage:" + request_id)
            self.store.transact(
                [
                    _write(old, "SUB_ACCOUNTS", user_id, data),
                    _write(None, "SUB_USAGE#" + user_id, request_id, receipt),
                    *settled,
                    written,
                ]
            )
            return dict(receipt)

        return self._retry(run)

    def record_credits(self, user_id: str, input: Mapping[str, Any]) -> dict[str, Any]:
        """Record a credit (+) or debit (-) on a user's statement; idempotent per requestId.

        Credits add non-expiring additional credits; debits are charged like usage (allowance
        first). ``amountMinor``/``currency`` record money paid. A missing key is JavaScript
        undefined; the fingerprint is ``JSON.stringify({...input, kind, source})`` in the input's
        key order.
        """

        def field(name: str) -> Any:
            return input.get(name, UNDEFINED)

        key = identifier(field("requestId"))
        product_id = identifier(field("productId"))
        reason = js_trim(js_string(_nullish(field("reason"), "")))
        if not reason or _js.utf16_length(reason) > 300:
            raise HttpError(400, "A short reason is required")
        credits = field("credits")
        number = credits if not isinstance(credits, bool) and isinstance(credits, (int, float)) else None
        kind = _nullish(field("kind"), "adjustment" if number is not None and number > 0 else "usage")
        if kind not in ("purchase", "adjustment", "grant", "usage"):
            raise HttpError(400, "Invalid entry type")
        if number is None or not _js.is_safe_integer(number) or number == 0 or abs(number) > 1e9:
            raise HttpError(400, "Credits must be a non-zero integer")
        source = _nullish(field("source"), "api")
        if source not in ("system", "admin", "billing", "user", "api"):
            raise HttpError(400, "Invalid source")
        money: dict[str, Any] = {}
        if field("amountMinor") is not UNDEFINED or field("currency") is not UNDEFINED:
            currency = js_string(_nullish(field("currency"), "")).lower()
            amount = integer(_undefined_none(field("amountMinor")))
            if not valid_currency(currency) or not valid_minor_amount(amount, currency):
                raise HttpError(400, "Invalid amount for currency")
            money = {"amountMinor": amount, "currency": currency}
        actor_id, details = _undefined_none(field("actorId")), _undefined_none(field("details"))
        if number < 0:
            return self.consume(user_id, product_id, -number, key, {"reason": reason, "kind": kind, "source": source, "actorId": actor_id, "details": details})
        # {...input, kind, source}: kind and source keep their position when the input has them.
        stringified: dict[str, Any] = {}
        for name, value in input.items():
            if name in ("kind", "source"):
                stringified[name] = kind if name == "kind" else source
            elif value is not UNDEFINED:
                stringified[name] = value
        stringified.setdefault("kind", kind)
        stringified.setdefault("source", source)
        fingerprint = _digest(stringified)

        def run() -> dict[str, Any]:
            prior = self.store.get("SUB_LEDGER_OP#" + user_id, key)
            if prior:
                if prior["data"].get("fingerprint") != fingerprint:
                    raise Conflict()
                return {**prior["data"]["result"], "replayed": True}
            settings = self.settings()
            if not any(x.get("id") == product_id for p in settings["values"]["plans"] for x in p.get("products") or []):
                raise HttpError(404, "Product not found")
            old = self._account(user_id)
            data = self._normalized({**(old["data"] if old else {}), "userId": user_id})
            settled = self._settle(user_id, old["data"] if old else None, data)
            if data.get("creditBalance") is None:
                data["creditBalance"] = {}
            data["creditBalance"][product_id] = integer(self._balance(data, product_id) + number, 0)
            at = self.now()
            entry: dict[str, Any] = {"at": at, "kind": kind, "source": source, "credits": number, "productId": product_id, "reason": reason, "requestId": key, **money}
            if truthy(actor_id):
                entry["actorId"] = actor_id
            if truthy(details):
                entry["details"] = details
            written = self._ledger_entry(user_id, data, entry, "record:" + key)
            result = {"requestId": key, "productId": product_id, "credits": number, "available": self._available(data, product_id), "at": at}
            self.store.transact(
                [
                    _write(old, "SUB_ACCOUNTS", user_id, data),
                    _write(None, "SUB_LEDGER_OP#" + user_id, key, {"fingerprint": fingerprint, "result": result}),
                    *settled,
                    written,
                ]
            )
            return {**result, "replayed": False}

        return self._retry(run)

    def estimate(self, input: Any) -> dict[str, Any]:
        """Price a request (rate, token counts, money value) and, with ``userId``, preview how the
        charge would split between allowance and additional credits. Never writes."""
        settings = self.settings()["values"]["credits"]
        result: dict[str, Any] = dict(price_request(settings, _get(input, "rateId"), _get(input, "inputTokens"), _get(input, "outputTokens")))
        user_id = _get(input, "userId")
        if truthy(user_id):
            product_id = identifier(_nullish(_get(input, "productId"), "api"))
            row = self._account(identifier(user_id))
            data = self._normalized(row["data"] if row else {})
            allowance = self._allowance_left(data, product_id)
            balance = self._balance(data, product_id)
            credits = result["credits"]
            from_allowance = min(credits, allowance)
            from_balance = credits - from_allowance
            result["account"] = {
                "userId": user_id,
                "productId": product_id,
                "allowanceLeft": allowance,
                "additionalCredits": balance,
                "available": allowance + balance,
                "fromAllowance": from_allowance,
                "fromBalance": from_balance,
                "allowed": from_balance <= balance and credits > 0,
                "availableAfter": max(0, allowance + balance - credits),
            }
        return result

    def consume_usage(self, user_id: str, product_id: str, usage: Any, request_id: Any) -> dict[str, Any]:
        """Estimate a model request and charge it atomically (see ``estimate`` and ``consume``)."""
        priced = self.estimate(usage)
        receipt = self.consume(
            user_id,
            product_id,
            priced["credits"],
            request_id,
            {
                "reason": js_string(priced["rate"]["name"]) + " request",
                "details": {"rateId": priced["rate"]["id"], "inputTokens": priced["inputTokens"], "outputTokens": priced["outputTokens"]},
            },
        )
        return {**receipt, "valueMinor": priced["valueMinor"], "currency": priced["currency"]}

    def ledger(self, user_id: str, cursor: str | None = None) -> dict[str, Any]:
        """Chronological credit statement plus balances and totals; entries owed by windows that
        closed since the last write are returned as ``pending`` without writing."""
        row = self._account(user_id)
        data = self._normalized(row["data"] if row else {})
        page = self.store.list(ledger(user_id), cursor)
        pending = [
            {**{k: v for k, v in entry.items() if k != "seed"}, "source": "system", "pending": True}
            for entry in self._pending_windows(row["data"] if row else None, data)["entries"]
        ]
        entitlement = self._effective(data)
        products = [p["id"] for p in _get(entitlement.get("plan"), "products") or []]
        balances = data.get("creditBalance")
        for product_id in js_own_keys(balances) if isinstance(balances, Mapping) else []:
            if product_id not in products:
                products.append(product_id)
        return {
            "entries": [r["data"] for r in page["items"]],
            "cursor": page.get("cursor"),
            "pending": [] if cursor else pending,
            "totals": {**empty_totals(), **(data.get("ledgerTotals") or {}), "consumed": _nullish(data.get("totalConsumed"), 0)},
            "balances": [
                {
                    "productId": product_id,
                    "allowanceLeft": self._allowance_left(data, product_id),
                    "additionalCredits": self._balance(data, product_id),
                    "available": self._available(data, product_id),
                }
                for product_id in products
            ],
        }

    # --- administration ------------------------------------------------------------------

    def _all(self, pk: str) -> list[Row]:
        rows: list[Row] = []
        cursor = None
        while True:
            page = self.store.list(pk, cursor)
            rows.extend(page["items"])
            cursor = page.get("cursor")
            if not cursor:
                return rows

    def overview(self, months: Any = 12) -> dict[str, Any]:
        """Customers, paying customers, projected monthly revenue per currency, new and canceled
        subscriptions today, this month and per month. Records today's snapshot."""
        integer(months, 1, 36)
        now = self.now()
        today = _day_key(now)
        month = today[:7]
        customers = paying = canceling = 0
        mrr: dict[str, Any] = {}
        by_plan: dict[str, dict[str, Any]] = {}
        for row in self._all("SUB_ACCOUNTS"):
            data = self._normalized(row["data"])
            entitlement = self._effective(data)
            if not truthy(entitlement.get("plan")) or entitlement.get("status") != "active" or _ge(now, entitlement.get("periodEnd")):
                continue
            customers += 1
            plan = entitlement["plan"]
            summary = by_plan.setdefault(js_string(plan.get("id")), {"name": plan.get("name"), "customers": 0, "paying": 0})
            summary["customers"] += 1
            if truthy(entitlement.get("cancelAtPeriodEnd")):
                canceling += 1
            # Paying: billed by the configured provider, a priced plan, and not ending this period.
            if self.provider is not None and entitlement.get("mode") == self.provider.mode and _gt(plan.get("amount"), 0):
                paying += 1
                summary["paying"] += 1
                if not truthy(entitlement.get("cancelAtPeriodEnd")):
                    currency = plan["currency"]
                    mrr[currency] = _nullish(mrr.get(currency), 0) + js_round((plan["amount"] * 30) / plan["periodDays"])
        # One snapshot per day gives the historical customer line; later reads replace today's.
        key = "snap:" + today
        snapshot = {"customers": customers, "paying": paying, "canceling": canceling, "mrrMinor": mrr, "at": now}

        def save() -> None:
            old = self.store.get("SUB_STATS", key)
            self.store.transact([_write(old, "SUB_STATS", key, snapshot)])

        self._retry(save)
        days: dict[str, dict[str, Any]] = {}
        snapshots: dict[str, Any] = {}
        for row in self._all("SUB_STATS"):
            if row["sk"].startswith("day:"):
                days[row["sk"][4:]] = {"new": _nullish(row["data"].get("new"), 0), "canceled": _nullish(row["data"].get("canceled"), 0)}
            elif row["sk"].startswith("snap:"):
                snapshots[row["sk"][5:]] = row["data"]

        def total(prefix: str, field: str) -> Any:
            return sum((v[field] for d, v in days.items() if d.startswith(prefix)), 0)

        moment = datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(milliseconds=now)
        series = []
        for i in range(int(months)):
            index = moment.year * 12 + (moment.month - 1) - (int(months) - 1 - i)
            key_month = f"{index // 12:04d}-{index % 12 + 1:02d}"
            last = max((d for d in snapshots if d.startswith(key_month)), default=None)
            series.append(
                {
                    "month": key_month,
                    "customers": snapshots[last].get("customers") if last else None,
                    "paying": snapshots[last].get("paying") if last else None,
                    "new": total(key_month, "new"),
                    "canceled": total(key_month, "canceled"),
                }
            )
        return {
            "asOf": now,
            "customers": customers,
            "paying": paying,
            "canceling": canceling,
            "mrrMinor": mrr,
            "plans": [{"planId": plan_id, **by_plan[plan_id]} for plan_id in js_own_keys(by_plan)],
            "today": {"date": today, "new": days.get(today, {}).get("new", 0), "canceled": days.get(today, {}).get("canceled", 0)},
            "month": {"month": month, "new": total(month, "new"), "canceled": total(month, "canceled")},
            "series": series,
        }

    def reset(self, user_id: str, input: Any, actor_id: str) -> dict[str, Any]:
        """Courtesy reset of usage windows (day, week, period or all), once per request id."""
        key = identifier(_get(input, "requestId"))
        scope = _get(input, "scope")
        if scope not in ("day", "week", "period", "all") or not isinstance(scope, str):
            raise HttpError(400, "Invalid reset scope")
        reason = js_trim(js_string(_nullish(_get(input, "reason"), "")))
        if not reason or _js.utf16_length(reason) > 300:
            raise HttpError(400, "A short courtesy reason is required")

        def run() -> dict[str, Any]:
            op = self.store.get("SUB_RESET#" + user_id, key)
            if op:
                if op["data"].get("scope") != scope or op["data"].get("reason") != reason:
                    raise Conflict()
                return {"ok": True}
            row = self._account(user_id)
            if row is None or not truthy(self._effective(self._normalized(row["data"])).get("plan")):
                raise HttpError(404, "No subscription")
            data = self._normalized(row["data"])
            settled = self._settle(user_id, row["data"], data)
            entries: list[Write] = []
            counters = self._effective(data).get("counters") or {}
            for product_id in js_own_keys(counters):
                counter = counters[product_id]
                before = self._allowance_left(data, product_id)
                for field in ("day", "week", "period"):
                    if scope in ("all", field):
                        counter[field] = 0
                restored = self._allowance_left(data, product_id) - before
                entries.append(
                    self._ledger_entry(
                        user_id,
                        data,
                        {
                            "at": self.now(),
                            "kind": "reset",
                            "source": "admin",
                            "credits": restored,
                            "productId": product_id,
                            "reason": f"Courtesy reset ({scope}) · {reason}",
                            "actorId": actor_id,
                            "requestId": key,
                        },
                        "reset:" + key + ":" + product_id,
                    )
                )
            audit = {"userId": user_id, "actorId": actor_id, "scope": scope, "reason": reason, "at": self.now()}
            self.store.transact(
                [
                    *settled,
                    *entries,
                    _write(row, "SUB_ACCOUNTS", user_id, {**data, "courtesyResets": _nullish(data.get("courtesyResets"), 0) + 1}),
                    _write(None, "SUB_RESET#" + user_id, key, audit),
                    _write(None, "SUB_AUDIT", self._new_id(), {**audit, "action": "courtesy-reset"}),
                ]
            )
            return {"ok": True}

        return self._retry(run)

    def grant(self, user_id: str, input: Any, actor_id: str) -> dict[str, Any]:
        """Assign a plan or additional credits without charging (administrative ledger)."""
        key = identifier(_get(input, "requestId"))
        kind = _get(input, "kind")
        if kind not in ("plan", "credits") or not isinstance(kind, str):
            raise HttpError(400, "Invalid assignment type")
        reason = js_trim(js_string(_nullish(_get(input, "reason"), "")))
        if not reason or _js.utf16_length(reason) > 300:
            raise HttpError(400, "A short reason is required")
        currency = js_string(_nullish(_get(input, "currency"), "")).lower()
        if not valid_currency(currency):
            raise HttpError(400, "Invalid currency")
        value_minor = integer(_get(input, "valueMinor"), 0)
        if not valid_minor_amount(value_minor, currency):
            raise HttpError(400, "Invalid amount for currency")
        target = identifier(_get(input, "planId") if kind == "plan" else _get(input, "productId"))
        credits = integer(_get(input, "credits"), 1) if kind == "credits" else 0
        fingerprint = _js.stringify(
            {"kind": kind, "target": target, "credits": credits, "valueMinor": value_minor, "currency": currency, "reason": reason, "actorId": actor_id}
        )

        def run() -> dict[str, Any]:
            prior = self.store.get("SUB_GRANTS#" + user_id, key)
            if prior:
                if prior["data"].get("fingerprint") != fingerprint:
                    raise Conflict()
                return {"ok": True}
            user = self.store.get("USERS", user_id)
            if user is None or truthy(user["data"].get("deletedAt")):
                raise HttpError(404, "User not found")
            settings = self.settings()
            plan = next((p for p in settings["values"]["plans"] if p.get("id") == target), None)
            if kind == "plan" and plan is None:
                raise HttpError(404, "Plan not found")
            if kind == "credits" and not any(x.get("id") == target for p in settings["values"]["plans"] for x in p.get("products") or []):
                raise HttpError(404, "Product not found")
            row = self._account(user_id)
            data = self._normalized({**(row["data"] if row else {}), "userId": user_id, "email": user["data"].get("email")})
            at = self.now()
            if kind == "plan":
                assert plan is not None
                data["adminGrant"] = {
                    "plan": plan,
                    "mode": "admin",
                    "status": "active",
                    "periodStart": at,
                    "periodEnd": at + plan["periodDays"] * 86400000,
                    "counters": {},
                    "actorId": actor_id,
                    "reason": reason,
                    "valueMinor": value_minor,
                    "currency": currency,
                }
            if truthy(data.get("adminGrant")):
                data["adminGrant"] = self._normalized(data["adminGrant"])
            if kind != "plan":
                if data.get("creditBalance") is None:
                    data["creditBalance"] = {}
                data["creditBalance"][target] = integer(self._balance(data, target) + credits, 0)
            audit = {
                "kind": kind,
                "target": target,
                "credits": credits,
                "valueMinor": value_minor,
                "currency": currency,
                "reason": reason,
                "actorId": actor_id,
                "userId": user_id,
                "at": at,
                "source": "admin",
                "fingerprint": fingerprint,
            }
            was_active = self._windows(self._normalized(row["data"] if row else {})) is not None
            settled = self._settle(user_id, row["data"] if row else None, data)
            entry: dict[str, Any] = {
                "at": at,
                "kind": "plan" if kind == "plan" else "grant",
                "source": "admin",
                "credits": credits,
                **({"planId": target} if kind == "plan" else {"productId": target}),
                "reason": ("Plan assigned by administrator: " + js_string(plan["name"]) if kind == "plan" and plan else "Credits assigned by administrator") + " · " + reason,
                "actorId": actor_id,
                "requestId": key,
            }
            if value_minor:
                entry.update({"amountMinor": value_minor, "currency": currency})
            written = self._ledger_entry(user_id, data, entry, "grant:" + key)
            self.store.transact(
                [
                    _write(row, "SUB_ACCOUNTS", user_id, data),
                    _write(None, "SUB_GRANTS#" + user_id, key, audit),
                    written,
                    *settled,
                    *([self._stats_write("new")] if kind == "plan" and not was_active else []),
                ]
            )
            return {"ok": True}

        return self._retry(run)

    def list_users(self, query: Mapping[str, Any]) -> dict[str, Any]:
        """One bounded USERS page per request, filtered by ``q`` (id, email or name)."""
        q = js_trim(js_string(_nullish(query.get("q"), ""))).lower()
        if _js.utf16_length(q) > 200:
            raise HttpError(400, "Search is too long")
        # One bounded storage page per request; the next cursor continues searching.
        page = self.store.list("USERS", query.get("cursor"))
        items = []
        for r in page["items"]:
            if truthy(r["data"].get("deletedAt")):
                continue
            if q and not any(q in js_string(_nullish(v, "")).lower() for v in (r["sk"], r["data"].get("email"), r["data"].get("name"))):
                continue
            row = self._account(r["sk"])
            base = self._normalized(row["data"] if row else {})
            data = self._effective(base)
            products = [p["id"] for p in _get(data.get("plan"), "products") or []]
            for product_id in js_own_keys(base.get("creditBalance") or {}):
                if product_id not in products:
                    products.append(product_id)
            items.append(
                {
                    "creditsAvailable": sum((self._available(base, p) for p in products), 0),
                    "userId": r["sk"],
                    "email": r["data"].get("email"),
                    "name": r["data"].get("name"),
                    "plan": _get(data.get("plan"), "name"),
                    "status": _nullish(data.get("status"), "none"),
                    "source": data.get("mode"),
                    "totalConsumed": _nullish(_get(row["data"] if row else None, "totalConsumed"), 0),
                    "courtesyResets": _nullish(_get(row["data"] if row else None, "courtesyResets"), 0),
                }
            )
        return {"items": items, "cursor": page.get("cursor")}

    def webhook(self, raw: str, signature: str) -> dict[str, Any]:
        """Verified provider events: deduplicated, synchronized and queued as notifications."""
        provider = self.provider
        if provider is None:
            raise HttpError(503, "Payments not configured")
        try:
            event = provider.verify(raw, signature)
        except Exception:
            raise HttpError(400, "Invalid webhook signature") from None
        kinds = (
            "invoice.payment_failed",
            "invoice.paid",
            "invoice.upcoming",
            "customer.subscription.created",
            "customer.subscription.updated",
            "customer.subscription.deleted",
            "customer.subscription.trial_will_end",
        )
        if not truthy(event.get("customer")) or event.get("type") not in kinds:
            return {"ok": True}
        if self.store.get("SUB_EVENTS", event["id"]):
            return {"ok": True}
        mapping = self.store.get("SUB_CUSTOMERS", event["customer"])
        if mapping is None:
            raise HttpError(409, "Customer mapping not ready")
        self.sync(mapping["data"]["userId"])
        row = self._account(mapping["data"]["userId"])
        settings = self.settings()
        notify = (
            settings["values"]["notifications"]
            and _get(row["data"] if row else None, "notifications") is not False
            and event["type"] in kinds[:3] + kinds[5:]
        )
        writes: list[Write] = [_write(None, "SUB_EVENTS", event["id"], {"type": event["type"], "at": self.now()})]
        if notify:
            writes.append(
                _write(
                    None,
                    "SUB_MAIL",
                    event["id"],
                    {
                        "userId": mapping["data"]["userId"],
                        "to": _get(row["data"] if row else None, "email"),
                        "subject": "Subscription update",
                        "text": event["type"].replace(".", " · "),
                        "sent": False,
                    },
                )
            )
        try:
            self.store.transact(writes)
        except Conflict:
            if not self.store.get("SUB_EVENTS", event["id"]):
                raise
        return {"ok": True}

    def maintenance(self) -> dict[str, Any]:
        """Renew idle unpaid accounts, settle closed windows, queue period reminders and send
        pending notices; resumable through the ``SUB_MAINTENANCE/cursor`` checkpoint."""
        settings = self.settings()
        checkpoint = self.store.get("SUB_MAINTENANCE", "cursor")
        cursor = _get(checkpoint["data"] if checkpoint else None, "accounts")
        processed = 0
        deadline = time.monotonic() + 15
        while True:
            page = self.store.list("SUB_ACCOUNTS", cursor)
            for row in page["items"]:
                d = row["data"]
                if not truthy(d.get("plan")):
                    continue
                now = self.now()
                renew = d.get("mode") == "none" and not truthy(d.get("cancelAtPeriodEnd")) and _ge(now, d.get("periodEnd"))
                if renew:
                    step = d["plan"]["periodDays"] * 86400000
                    periods = math.floor((now - d["periodStart"]) / step)
                    nxt = self._normalized(
                        {**d, "periodStart": d["periodStart"] + periods * step, "periodEnd": d["periodStart"] + (periods + 1) * step, "counters": {}}
                    )
                else:
                    nxt = self._normalized(d)
                # Record closed weekly windows (expiry and new allowance) even for idle accounts.
                settled = self._settle(row["sk"], d, nxt)
                if renew or settled:
                    try:
                        self.store.transact([_write(row, row["pk"], row["sk"], nxt), *settled])
                    except Conflict:
                        pass
                period_end = d.get("periodEnd")
                if (
                    settings["values"]["notifications"]
                    and d.get("notifications") is not False
                    and truthy(d.get("email"))
                    and period_end is not None
                    and period_end - self.now() <= settings["values"]["reminderDays"] * 86400000
                    and period_end > self.now()
                ):
                    key = _js_str(_undefined(d.get("userId"))) + "-" + js_string(period_end)
                    if not self.store.get("SUB_MAIL", key):
                        try:
                            self.store.transact(
                                [
                                    _write(
                                        None,
                                        "SUB_MAIL",
                                        key,
                                        {
                                            "userId": d.get("userId"),
                                            "to": d["email"],
                                            "subject": "Subscription period ending",
                                            "text": "Your current subscription period ends on " + _iso(period_end),
                                            "sent": False,
                                        },
                                    )
                                ]
                            )
                        except Conflict:
                            pass
            cursor = page.get("cursor")
            processed += len(page["items"])
            if not (cursor and processed < 100 and time.monotonic() < deadline):
                break
        mail_cursor = _get(checkpoint["data"] if checkpoint else None, "mail")
        if self._notify is not None and time.monotonic() < deadline:
            start = mail_cursor
            mails = self.store.list("SUB_MAIL", mail_cursor)
            mail_cursor = mails.get("cursor")
            for row in mails["items"]:
                if time.monotonic() >= deadline:
                    mail_cursor = start
                    break
                data = row["data"]
                if truthy(data.get("sent")) or _gt(data.get("lockUntil"), self.now()) or not settings["values"]["notifications"]:
                    continue
                if truthy(data.get("userId")):
                    account = self._account(data["userId"])
                    if account and account["data"].get("notifications") is False:
                        continue
                claim = _write(row, row["pk"], row["sk"], {**data, "lockUntil": self.now() + 60000})
                try:
                    self.store.transact([claim])
                except Conflict:
                    continue
                try:
                    self._notify({"to": data.get("to"), "subject": data.get("subject"), "text": data.get("text")})
                    self.store.transact([_write(claim["row"], row["pk"], row["sk"], {**claim["row"]["data"], "sent": True})])
                except Exception:
                    pass  # Leave the durable notice for a retry after the lease expires.
        try:
            self.store.transact([_write(checkpoint, "SUB_MAINTENANCE", "cursor", {"accounts": cursor or None, "mail": mail_cursor or None})])
        except Conflict:
            pass
        return {"processed": processed, "partial": bool(cursor) or bool(mail_cursor)}


def _add(a: Any, b: Any) -> Any:
    return None if a is None else a + b


def _gt(a: Any, b: Any) -> bool:
    return a is not None and b is not None and a > b


def _undefined(value: Any) -> Any:
    """Missing properties read as undefined."""
    return UNDEFINED if value is None else value


def _undefined_none(value: Any) -> Any:
    return None if value is UNDEFINED else value


def _same_version(stored: Any, given: Any) -> bool:
    """``stored === given`` for versions (numbers only; booleans are not numbers)."""
    return _js.is_number(given) and _js.is_number(stored) and stored == given


__all__ = ["Subscriptions", "BillingProvider", "CatalogPublisher", "UNDEFINED", "WEBHOOK_BODY_LIMIT", "DAY"]
