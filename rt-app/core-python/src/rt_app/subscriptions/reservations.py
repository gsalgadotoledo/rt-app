"""Credit reservations (reserve and settle): pure helpers (port of ``reservations.ts``).

A reservation holds credits of one product until it is settled (the real usage is charged),
released, or expires (``expiresAt``). Holds live on the account row (``reservations``, a list in
creation order) and as receipts ``SUB_RESERVATION#<userId>/<key>``. The service methods are
``Subscriptions.reserve``, ``settle``, ``release``, ``preflight`` and ``usage_summary``. Contract:
``spec/contracts/subscriptions-reservations.contract.yaml``; design:
``docs/polyglot/subscriptions-reservations.md``.
"""
from __future__ import annotations

import math
import re
from collections.abc import Mapping
from typing import Any, Final

from .. import _js
from .._jsnum import js_string, js_trim
from ..errors import HttpError

#: Default hold time: 15 minutes.
RESERVATION_TTL_MS: Final = 15 * 60_000
MIN_RESERVATION_TTL_MS: Final = 1_000
MAX_RESERVATION_TTL_MS: Final = 86_400_000
#: Active reservations per user (bounds the account row and the release transaction).
MAX_ACTIVE_RESERVATIONS: Final = 25

_KEY = re.compile(r"[A-Za-z0-9_.:-]{1,128}")


def reservations(user_id: str) -> str:
    """Row partition of reservation receipts."""
    return "SUB_RESERVATION#" + user_id


def reservation_key(value: Any) -> str:
    """Keys allow ":" and "." so a "<turnId>:<step>" key needs no encoding."""
    if not isinstance(value, str) or not _KEY.fullmatch(value):
        raise HttpError(400, "Invalid reservation key")
    return value


def reservation_ttl(value: Any) -> Any:
    """``ttlMs ?? 15 min``: a safe integer between 1 s and 24 h."""
    if value is None:
        return RESERVATION_TTL_MS
    if not _js.is_safe_integer(value) or value < MIN_RESERVATION_TTL_MS or value > MAX_RESERVATION_TTL_MS:
        raise HttpError(400, "Invalid reservation TTL")
    return value


def reservation_reason(value: Any) -> str | None:
    """Optional statement text: ``String(value).trim()``, 1 to 300 UTF-16 units when given."""
    if value is None:
        return None
    reason = js_trim(js_string(value))
    if not reason or _js.utf16_length(reason) > 300:
        raise HttpError(400, "A short reason is required")
    return reason


def threshold_of(percent: float) -> int:
    """Highest threshold reached by a usage percentage: 0, 80, 95 or 100."""
    return 100 if percent >= 100 else 95 if percent >= 95 else 80 if percent >= 80 else 0


def window_usage(kind: str, used: Any, reserved: Any, limit: Any, reset_at: Any) -> dict[str, Any]:
    """One usage window; percent = floor((used + reserved) * 100 / limit), 100 when limit is 0."""
    percent = math.floor((used + reserved) * 100 / limit) if limit > 0 else 100
    return {
        "kind": kind,
        "used": used,
        "reserved": reserved,
        "limit": limit,
        "remaining": max(0, limit - used - reserved),
        "percent": percent,
        "threshold": threshold_of(percent),
        "resetAt": reset_at,
    }


def active_holds(holds: Any, now: float) -> list[Mapping[str, Any]]:
    """Holds that still count at ``now`` (``now < expiresAt``)."""
    return [h for h in holds or [] if now < h["expiresAt"]]


def settle_usage(usage: Any) -> dict[str, Any]:
    """Normalized settle usage: ``{credits}`` or ``{inputTokens, outputTokens}``."""

    def integer(value: Any, maximum: float) -> Any:
        if not _js.is_safe_integer(value) or value < 0 or value > maximum:
            raise HttpError(400, "Invalid numeric setting")
        return value

    if isinstance(usage, Mapping) and usage.get("credits") is not None:
        return {"credits": integer(usage["credits"], 1e9)}
    if isinstance(usage, Mapping) and usage.get("inputTokens") is not None:
        output = usage.get("outputTokens")
        return {"inputTokens": integer(usage["inputTokens"], 1e10), "outputTokens": integer(0 if output is None else output, 1e10)}
    raise HttpError(400, "Give credits or token usage")


def same_usage(a: Any, b: Any) -> bool:
    """Same settle usage (a replay) or not (409)."""
    fields = ("credits", "inputTokens", "outputTokens")
    return all((a or {}).get(f) == (b or {}).get(f) for f in fields)


__all__ = [
    "RESERVATION_TTL_MS",
    "MIN_RESERVATION_TTL_MS",
    "MAX_RESERVATION_TTL_MS",
    "MAX_ACTIVE_RESERVATIONS",
    "reservations",
    "reservation_key",
    "reservation_ttl",
    "reservation_reason",
    "threshold_of",
    "window_usage",
    "active_holds",
    "settle_usage",
    "same_usage",
]
