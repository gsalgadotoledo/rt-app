"""JavaScript Number and String semantics the subscriptions modules depend on (TypeScript is the reference).

All numbers are IEEE-754 float64, like JavaScript ``Number``:

- ``num`` turns JSON integers into floats, so sums past 2**53 lose precision exactly like JavaScript.
- ``js_round`` is ``Math.round`` (halves go up: 2.5 -> 3, -2.5 -> -2), not Python ``round``.
- ``number_to_string`` is ``Number.prototype.toString()`` (``1``, ``1.5``, ``1e+21``, ``1e-7``).
- ``js_string`` is ``String(value)`` for JSON values; ``js_trim`` is ``String.prototype.trim``.
- ``utf16_slice`` is ``string.slice(0, n)`` in UTF-16 code units (it can split a surrogate pair).
"""
from __future__ import annotations

import math
from typing import Any

# ECMAScript WhiteSpace + LineTerminator (what trim() removes). Python's str.strip() differs:
# it strips U+001C-U+001F and U+0085, and keeps U+FEFF.
JS_WHITESPACE = (
    "\t\n\v\f\r              "
    "    　﻿"
)


def is_number(value: object) -> bool:
    """``typeof value === "number"``: ``bool`` is not a number."""
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def num(value: Any) -> Any:
    """A JSON number as float64 (JavaScript Number); other values unchanged."""
    return float(value) if is_number(value) else value


def js_round(x: float) -> float:
    """``Math.round``: the nearest integer, halves toward +Infinity.

    Computed exactly (``x - floor(x)`` is exact in float64), so 0.49999999999999994 gives 0 and
    large values do not round twice, unlike a naive ``floor(x + 0.5)``.
    """
    x = float(x)
    if not math.isfinite(x) or x == 0:
        return x
    base = math.floor(x)
    result = float(base + 1 if x - base >= 0.5 else base)
    return -0.0 if result == 0 and x < 0 else result


def number_to_string(value: float | int) -> str:
    """``String(n)`` for a JavaScript number (ECMAScript Number::toString, radix 10)."""
    x = float(value)
    if math.isnan(x):
        return "NaN"
    if x == 0:
        return "0"  # also -0
    if math.isinf(x):
        return "Infinity" if x > 0 else "-Infinity"
    if x < 0:
        return "-" + number_to_string(-x)
    # repr() gives the shortest round-trip digits, the same digits JavaScript chooses.
    mantissa, _, exponent = repr(x).partition("e")
    whole, _, fraction = mantissa.partition(".")
    digits = (whole + fraction).lstrip("0")
    leading = len(whole + fraction) - len((whole + fraction).lstrip("0"))
    n = len(whole) + (int(exponent) if exponent else 0) - leading
    digits = digits.rstrip("0") or "0"
    k = len(digits)
    if k <= n <= 21:
        return digits + "0" * (n - k)
    if 0 < n <= 21:
        return digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return "0." + "0" * (-n) + digits
    e = n - 1
    sign = "+" if e >= 0 else "-"
    return digits[0] + ("." + digits[1:] if k > 1 else "") + "e" + sign + str(abs(e))


def js_string(value: Any) -> str:
    """``String(value)`` for JSON values (``None`` is ``null``; objects are ``[object Object]``)."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return value
    if is_number(value):
        return number_to_string(value)
    if isinstance(value, (list, tuple)):
        return ",".join("" if item is None else js_string(item) for item in value)
    return "[object Object]"


def js_trim(text: str) -> str:
    """``String.prototype.trim``."""
    return text.strip(JS_WHITESPACE)


def utf16_slice(text: str, end: int) -> str:
    """``text.slice(0, end)`` counted in UTF-16 code units; may leave a lone high surrogate."""
    units = text.encode("utf-16-le", "surrogatepass")
    return units[: 2 * end].decode("utf-16-le", "surrogatepass")


def utf8(text: str) -> bytes:
    """Node's ``Buffer.from(text)`` / ``hash.update(text)``: lone surrogates become U+FFFD."""
    return text.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "replace").encode("utf-8")


def truthy(value: Any) -> bool:
    """JavaScript truthiness for JSON values (NaN, 0, "" and null are falsy)."""
    if value is None or value is False:
        return False
    if isinstance(value, float) and math.isnan(value):
        return False
    if is_number(value) or isinstance(value, str):
        return bool(value)
    return True
