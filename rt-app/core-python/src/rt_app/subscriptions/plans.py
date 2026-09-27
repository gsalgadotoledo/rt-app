"""Subscription settings: defaults, validation and plan ids (port of ``validateSettings``,
``defaults`` and ``plan-id.ts`` in ``packages/subscriptions``).

Validation raises ``HttpError(400)`` with the TypeScript messages, checked in the same order (see
``spec/contracts/subscriptions-settings.contract.yaml``). String lengths count UTF-16 code units.
"""
from __future__ import annotations

import copy
import re
import unicodedata
from collections.abc import Mapping, Sequence
from typing import Any, Final

from ..errors import HttpError
from .._jsnum import js_string, number_to_string, truthy, utf16_slice
from .._js import utf16_length
from .credits import DEFAULT_CREDITS, integer, validate_credits
from .currency import valid_currency, valid_minor_amount

_PRODUCTS = {
    "starter": {"credits": 1000, "dailyLimit": 100, "weeklyLimit": 500},
    "pro": {"credits": 10000, "dailyLimit": 1000, "weeklyLimit": 5000},
    "max": {"credits": 50000, "dailyLimit": 5000, "weeklyLimit": 25000},
}


def _product(plan: str) -> dict[str, Any]:
    limits = _PRODUCTS[plan]
    return {"id": "api", "name": "API credits", **limits, "daySeconds": 86400, "weekSeconds": 604800}


#: The default settings (``defaults`` in TypeScript); use ``default_settings()`` for a copy.
DEFAULTS: Final[Mapping[str, Any]] = {
    "paymentRequired": False,
    "notifications": True,
    "reminderDays": 3,
    "credits": DEFAULT_CREDITS,
    "plans": [
        {"id": "starter", "name": "Starter", "amount": 0, "currency": "usd", "periodDays": 30, "enabled": True, "products": [_product("starter")]},
        {"id": "pro", "name": "Pro", "amount": 2000, "currency": "usd", "periodDays": 30, "enabled": True, "products": [_product("pro")]},
        {
            "id": "max",
            "family": "max",
            "version": "0.0.1",
            "name": "Max",
            "description": "For growing teams with higher usage",
            "amount": 5000,
            "currency": "usd",
            "periodDays": 30,
            "enabled": True,
            "products": [_product("max")],
        },
    ],
}

RESERVED_METADATA: Final = ("B_version", "State", "family", "rtAppPlanId", "rtAppCatalog")
_ID = re.compile(r"[a-zA-Z0-9_-]{1,100}")
_METADATA_KEY = re.compile(r"[a-zA-Z0-9_-]{1,40}")


def default_settings() -> dict[str, Any]:
    """A fresh copy of the default settings."""
    return copy.deepcopy(dict(DEFAULTS))


def identifier(value: Any) -> str:
    """``^[a-zA-Z0-9_-]{1,100}$`` or 400 "Invalid identifier"."""
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise HttpError(400, "Invalid identifier")
    return value


def prop(value: Any, name: str) -> Any:
    """``value.name`` for a JSON value: objects have properties, other values none (null throws)."""
    if value is None:
        raise TypeError(f"Cannot read properties of null (reading '{name}')")
    return value.get(name) if isinstance(value, Mapping) else None


def _text(value: Any, limit: int) -> str:
    """``String(value ?? "").slice(0, limit)``."""
    return utf16_slice("" if value is None else js_string(value), limit)


def validate_metadata(value: Any) -> dict[str, str]:
    """At most 20 entries; keys ``^[a-zA-Z0-9_-]{1,40}$`` (not reserved) with string values of at
    most 500 UTF-16 units. Keys are sorted (TypeScript sorts with localeCompare; key order is not
    part of the contract)."""
    if not isinstance(value, Mapping) or len(value) > 20:
        raise HttpError(400, "Use at most 20 metadata entries")
    for key, item in value.items():
        if not _METADATA_KEY.fullmatch(key) or not isinstance(item, str) or utf16_length(item) > 500 or key in RESERVED_METADATA:
            raise HttpError(400, "Invalid or reserved metadata key")
    return {key: value[key] for key in sorted(value, key=lambda k: (k.lower(), k.swapcase()))}


def _products(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list) or not 0 < len(value) <= 20:
        raise HttpError(400, "A plan needs products")
    products = []
    for x in value:
        products.append(
            {
                "id": identifier(prop(x, "id")),
                "name": _text(prop(x, "name"), 80),
                "credits": integer(prop(x, "credits")),
                "dailyLimit": integer(prop(x, "dailyLimit")),
                "weeklyLimit": integer(prop(x, "weeklyLimit")),
                "daySeconds": integer(prop(x, "daySeconds"), 60, 86400 * 31),
                "weekSeconds": integer(prop(x, "weekSeconds"), 60, 86400 * 366),
            }
        )
    return products


def _plan(p: Any) -> dict[str, Any]:
    plan_id = identifier(prop(p, "id"))
    family = prop(p, "family")
    plan: dict[str, Any] = {
        "id": plan_id,
        "family": identifier(plan_id if family is None else family),
        "description": _text(prop(p, "description"), 500),
    }
    metadata = prop(p, "metadata")
    plan["metadata"] = validate_metadata({} if metadata is None else metadata)
    plan["name"] = _text(prop(p, "name"), 80)
    plan["amount"] = integer(prop(p, "amount"))
    currency = prop(p, "currency")
    if not valid_currency(currency):
        raise HttpError(400, "Invalid currency")
    plan["currency"] = currency
    plan["periodDays"] = integer(prop(p, "periodDays"), 1, 366)
    plan["enabled"] = prop(p, "enabled") is True and prop(p, "archived") is not True
    plan["archived"] = prop(p, "archived") is True
    price = prop(p, "stripePriceId")
    if truthy(price):
        plan["stripePriceId"] = identifier(price)
    plan["products"] = _products(prop(p, "products"))
    return plan


def validate_settings(values: Any) -> dict[str, Any]:
    """Normalized settings or ``HttpError(400)`` (order: shape, plans in order, duplicates,
    reminderDays, credits)."""
    source = values if isinstance(values, Mapping) else {}
    plans_in = source.get("plans")
    if (
        not isinstance(source.get("paymentRequired"), bool)
        or not isinstance(source.get("notifications"), bool)
        or not isinstance(plans_in, list)
        or not 1 <= len(plans_in) <= 20
    ):
        raise HttpError(400, "Invalid subscription settings")
    plans = [_plan(p) for p in plans_in]
    priced = [p["stripePriceId"] for p in plans if "stripePriceId" in p]
    if (
        len({p["id"] for p in plans}) != len(plans)
        or len(set(priced)) != len(priced)
        or any(
            not p["name"]
            or not valid_minor_amount(p["amount"], p["currency"])
            or len({x["id"] for x in p["products"]}) != len(p["products"])
            or any(not x["name"] for x in p["products"])
            for p in plans
        )
    ):
        raise HttpError(400, "Duplicate or unnamed plans/products")
    reminder = integer(source.get("reminderDays"), 0, 30)
    credits = source.get("credits")
    # Settings saved before credit rates existed keep working with the defaults.
    return {
        "paymentRequired": source["paymentRequired"],
        "notifications": source["notifications"],
        "reminderDays": reminder,
        "plans": plans,
        "credits": validate_credits(DEFAULT_CREDITS if credits is None else credits),
    }


def plan_content(plan: Mapping[str, Any]) -> dict[str, Any]:
    """The versioned content of a plan: a change creates a new plan version."""
    family = plan.get("family")
    description = plan.get("description")
    metadata = plan.get("metadata")
    return {
        "id": plan.get("id"),
        "family": plan.get("id") if family is None else family,
        "name": plan.get("name"),
        "description": "" if description is None else description,
        "amount": plan.get("amount"),
        "currency": plan.get("currency"),
        "periodDays": plan.get("periodDays"),
        "products": plan.get("products"),
        "metadata": {} if metadata is None else metadata,
    }


_LAST_NUMBER = re.compile(r"([0-9]+)\Z")


def next_version(version: str) -> str:
    """``version.replace(/(\\d+)$/, n => String(Number(n) + 1))``: "0.0.9" -> "0.0.10"."""
    return _LAST_NUMBER.sub(lambda m: number_to_string(float(m.group(1)) + 1), version, count=1)


_COMBINING = re.compile("[̀-ͯ]")
_NOT_SLUG = re.compile(r"[^a-z0-9]+")


def plan_id_from_name(name: str, existing: Sequence[str] = ()) -> str:
    """Stable, URL-safe draft ids: NFKD, accents dropped, lowercase, runs of other characters as
    "-", at most 80 characters; "-2", "-3"… avoid collisions (archived ids included)."""
    base = _COMBINING.sub("", unicodedata.normalize("NFKD", name)).lower()
    base = _NOT_SLUG.sub("-", base)
    base = re.sub(r"^-|-\Z", "", base)[:80]
    base = re.sub(r"-\Z", "", base) or "new-plan"
    ids = set(existing)
    value, suffix = base, 2
    while value in ids:
        value = f"{base}-{suffix}"
        suffix += 1
    return value


__all__ = [
    "DEFAULTS",
    "RESERVED_METADATA",
    "default_settings",
    "identifier",
    "validate_metadata",
    "validate_settings",
    "plan_content",
    "next_version",
    "plan_id_from_name",
]
