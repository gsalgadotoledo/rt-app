"""Currencies (port of ``packages/subscriptions/src/currency.ts``).

ISO currency codes from the runtime's CLDR catalog (the same list as the TypeScript reference) and
Stripe's minor units. Stripe availability varies by account.
"""
from __future__ import annotations

from typing import Any, Final

from .._jsnum import is_number

CURRENCY_CODES: Final[tuple[str, ...]] = (
    "aed", "afn", "all", "amd", "ang", "aoa", "ars", "aud", "awg", "azn", "bam", "bbd", "bdt",
    "bgn", "bhd", "bif", "bmd", "bnd", "bob", "brl", "bsd", "btn", "bwp", "byn", "bzd", "cad",
    "cdf", "chf", "clp", "cny", "cop", "crc", "cuc", "cup", "cve", "czk", "djf", "dkk", "dop",
    "dzd", "egp", "ern", "etb", "eur", "fjd", "fkp", "gbp", "gel", "ghs", "gip", "gmd", "gnf",
    "gtq", "gyd", "hkd", "hnl", "hrk", "htg", "huf", "idr", "ils", "inr", "iqd", "irr", "isk",
    "jmd", "jod", "jpy", "kes", "kgs", "khr", "kmf", "kpw", "krw", "kwd", "kyd", "kzt", "lak",
    "lbp", "lkr", "lrd", "lsl", "lyd", "mad", "mdl", "mga", "mkd", "mmk", "mnt", "mop", "mru",
    "mur", "mvr", "mwk", "mxn", "myr", "mzn", "nad", "ngn", "nio", "nok", "npr", "nzd", "omr",
    "pab", "pen", "pgk", "php", "pkr", "pln", "pyg", "qar", "ron", "rsd", "rub", "rwf", "sar",
    "sbd", "scr", "sdg", "sek", "sgd", "shp", "sle", "sll", "sos", "srd", "ssp", "stn", "svc",
    "syp", "szl", "thb", "tjs", "tmt", "tnd", "top", "try", "ttd", "twd", "tzs", "uah", "ugx",
    "usd", "uyu", "uzs", "ves", "vnd", "vuv", "wst", "xaf", "xcd", "xcg", "xdr", "xof", "xpf",
    "xsu", "yer", "zar", "zmw", "zwg", "zwl",
)
_CODES: Final = frozenset(CURRENCY_CODES)
_ZERO_DECIMAL: Final = frozenset(
    ["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "vnd", "vuv", "xaf", "xof", "xpf"]
)
_THREE_DECIMAL: Final = frozenset(["bhd", "iqd", "jod", "kwd", "lyd", "omr", "tnd"])
#: Charged in whole units although their minor unit has 2 decimals (Stripe backwards compatibility).
_HUNDREDS: Final = frozenset(["isk", "ugx"])


def valid_currency(code: Any) -> bool:
    """A lowercase code from the catalog (``"USD"`` is not valid; normalize first)."""
    return isinstance(code, str) and code in _CODES


def currency_decimals(code: str) -> int:
    """Minor-unit decimals: 0, 2 or 3 (case-insensitive; unknown codes give 2)."""
    lower = code.lower()
    if lower in _ZERO_DECIMAL:
        return 0
    if lower in _HUNDREDS:
        return 2
    return 3 if lower in _THREE_DECIMAL else 2


def major_amount(minor: float, code: str) -> float:
    """Minor units as a major amount (``minor / 10 ** decimals``, float64)."""
    return float(minor) / 10 ** currency_decimals(code)


def currency_step(code: str) -> float:
    """Smallest chargeable major amount."""
    return 1.0 if code.lower() in _HUNDREDS else 1 / 10 ** currency_decimals(code)


def valid_minor_amount(amount: Any, code: str) -> bool:
    """A safe integer >= 0; isk and ugx (any case) must also be a multiple of 100."""
    if not is_number(amount) or not _safe_integer(amount) or amount < 0:
        return False
    return code.lower() not in _HUNDREDS or amount % 100 == 0


def _safe_integer(value: float | int) -> bool:
    """``Number.isSafeInteger`` for a number."""
    if isinstance(value, float) and not value.is_integer():
        return False  # also NaN and infinities
    return abs(value) <= 2**53 - 1


__all__ = ["CURRENCY_CODES", "valid_currency", "currency_decimals", "major_amount", "currency_step", "valid_minor_amount"]
