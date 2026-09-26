"""Credit settings and request pricing (port of ``validateCredits``, ``defaults.credits`` and
``Subscriptions.estimate`` in ``packages/subscriptions/src/index.ts``).

Numbers are float64 with JavaScript rounding (``Math.round`` halves up), so estimates match the
TypeScript reference to the last bit. Validation errors are ``HttpError(400)``, checked in the
documented order; an unknown rate is ``HttpError(404, "Credit rate not found")``.
"""
from __future__ import annotations

import copy
import math
import re
from collections.abc import Mapping
from typing import Any, Final, TypedDict

from ..errors import HttpError
from .._jsnum import is_number, js_round, js_string, js_trim, num, utf16_slice
from .currency import valid_currency, valid_minor_amount


class CreditRate(TypedDict):
    """Credits charged per model/function; decimals allowed (e.g. 0.25 credits per 1k tokens)."""

    id: str
    name: str
    inputPer1k: float
    outputPer1k: float
    #: Minimum credits charged per request.
    minimum: int


class CreditPack(TypedDict):
    credits: int
    amountMinor: int
    currency: str


class CreditSettings(TypedDict):
    #: Price of a top-up pack; also the money value of one credit (amountMinor / credits).
    pack: CreditPack
    rates: list[CreditRate]


class Estimate(TypedDict):
    rate: CreditRate
    inputTokens: int
    outputTokens: int
    exactCredits: float
    credits: float
    valueMinor: float
    currency: str


DEFAULT_CREDITS: Final[CreditSettings] = {
    "pack": {"credits": 1000, "amountMinor": 1000, "currency": "usd"},
    "rates": [
        {"id": "standard", "name": "Standard model", "inputPer1k": 1, "outputPer1k": 3, "minimum": 1},
        {"id": "advanced", "name": "Advanced model", "inputPer1k": 5, "outputPer1k": 15, "minimum": 1},
    ],
}

_ID = re.compile(r"[a-zA-Z0-9_-]{1,100}")


def default_credits() -> CreditSettings:
    """A fresh copy of the default credit settings."""
    return copy.deepcopy(DEFAULT_CREDITS)


def _prop(value: Any, name: str) -> Any:
    """``value?.[name]`` for JSON values (only objects have named properties)."""
    return value.get(name) if isinstance(value, Mapping) else None


def _identifier(value: Any) -> str:
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise HttpError(400, "Invalid identifier")
    return value


def _safe_integer(value: Any) -> bool:
    if not is_number(value):
        return False
    if isinstance(value, float) and not value.is_integer():
        return False
    return abs(value) <= 2**53 - 1


def integer(value: Any, minimum: float = 0, maximum: float = 1e9) -> Any:
    """A safe integer within bounds, else 400 "Invalid numeric setting"."""
    if not _safe_integer(value) or value < minimum or value > maximum:
        raise HttpError(400, "Invalid numeric setting")
    return value


def rate(value: Any) -> Any:
    """Non-negative rate up to 1e6 with at most 4 decimals, tolerant of float64 noise.

    ``abs(n * 1e4 - Math.round(n * 1e4)) <= 1e-6``: 0.57 * 1e4 is 5699.999999999999 and is valid.
    """
    if not is_number(value) or not math.isfinite(value):
        raise HttpError(400, "Invalid credit rate")
    scaled = float(value) * 1e4
    if value < 0 or value > 1e6 or abs(scaled - js_round(scaled)) > 1e-6:
        raise HttpError(400, "Invalid credit rate")
    return value


def validate_credits(settings: Any) -> CreditSettings:
    """Normalized credit settings; unknown fields are dropped. Raises ``HttpError(400)``."""
    pack = _prop(settings, "pack")
    raw_currency = _prop(pack, "currency")
    currency = js_string("" if raw_currency is None else raw_currency).lower()
    if not valid_currency(currency):
        raise HttpError(400, "Invalid currency")
    amount_minor = integer(_prop(pack, "amountMinor"))
    if not valid_minor_amount(amount_minor, currency):
        raise HttpError(400, "Invalid amount for currency")
    raw_rates = _prop(settings, "rates")
    if not isinstance(raw_rates, list) or len(raw_rates) > 50:
        raise HttpError(400, "Use at most 50 credit rates")
    rates: list[CreditRate] = []
    for item in raw_rates:
        if item is None:
            raise TypeError("Cannot read properties of null (reading 'id')")
        name = _prop(item, "name")
        minimum = _prop(item, "minimum")
        rates.append(
            {
                "id": _identifier(_prop(item, "id")),
                "name": utf16_slice(js_trim(js_string("" if name is None else name)), 80),
                "inputPer1k": rate(_prop(item, "inputPer1k")),
                "outputPer1k": rate(_prop(item, "outputPer1k")),
                "minimum": integer(0 if minimum is None else minimum),
            }
        )
    if any(not r["name"] for r in rates) or len({r["id"] for r in rates}) != len(rates):
        raise HttpError(400, "Duplicate or unnamed credit rates")
    return {"pack": {"credits": integer(_prop(pack, "credits"), 1), "amountMinor": amount_minor, "currency": currency}, "rates": rates}


def estimate(settings: CreditSettings, rate_id: Any, input_tokens: Any, output_tokens: Any = None) -> Estimate:
    """Price a request: credits for a rate (model) and token counts, and their money value.

    ``credits = max(minimum, ceil(round(exact * 1e6) / 1e6))`` (float noise tolerated), and
    ``valueMinor = round(credits * pack.amountMinor / pack.credits)`` with JavaScript rounding.
    """
    selected = next((r for r in settings["rates"] if isinstance(rate_id, str) and r["id"] == rate_id), None)
    if selected is None:
        raise HttpError(404, "Credit rate not found")
    inputs = integer(input_tokens, 0, 1e10)
    outputs = integer(0 if output_tokens is None else output_tokens, 0, 1e10)
    exact = (num(inputs) / 1000) * num(selected["inputPer1k"]) + (num(outputs) / 1000) * num(selected["outputPer1k"])
    # Round up to whole credits (tolerating float noise) and apply the per-request minimum.
    credits = max(num(selected["minimum"]), float(math.ceil(js_round(exact * 1e6) / 1e6)))
    pack = settings["pack"]
    value_minor = js_round((credits * num(pack["amountMinor"])) / num(pack["credits"]))
    return {
        "rate": copy.deepcopy(selected),
        "inputTokens": inputs,
        "outputTokens": outputs,
        "exactCredits": js_round(exact * 1e4) / 1e4,
        "credits": credits,
        "valueMinor": value_minor,
        "currency": pack["currency"],
    }


class CreditPricing:
    """Request pricing over stored credit settings (validated) or the defaults."""

    def __init__(self, settings: Any = None) -> None:
        self.settings: CreditSettings = validate_credits(settings) if settings is not None else default_credits()

    def estimate(self, rate_id: Any, input_tokens: Any, output_tokens: Any = None) -> Estimate:
        return estimate(self.settings, rate_id, input_tokens, output_tokens)


__all__ = [
    "CreditRate",
    "CreditPack",
    "CreditSettings",
    "Estimate",
    "DEFAULT_CREDITS",
    "default_credits",
    "validate_credits",
    "estimate",
    "integer",
    "rate",
    "CreditPricing",
]
