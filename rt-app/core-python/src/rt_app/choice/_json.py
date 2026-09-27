"""JSON text exactly as JavaScript writes it, for the choice modules (TypeScript is the reference).

- ``stringify`` is ``JSON.stringify``: compact, JavaScript number formatting (``1e+21``, ``1e-7``,
  ``100``), only ``"``, ``\\`` and control characters escaped (U+2028 and DEL stay raw), lone
  surrogates written ``\\udxxx``, and object keys in JavaScript property order: array-index keys
  (``"0"`` … ``"4294967294"``) first in numeric order, then the others in insertion order.
- ``canonical`` is ``canonical()`` of ``@gsalgadotoledo/rt-app-cache``: the same text with every
  object's keys sorted by UTF-16 code units (JavaScript ``Array.prototype.sort``).
- ``snapshot`` is ``JSON.parse(canonical(value))``: a deep copy whose dicts hold their keys in the
  order JavaScript gives them after that round trip.
"""
from __future__ import annotations

import math
import re
from collections.abc import Iterable, Mapping
from typing import Any

from .._jsnum import is_number, number_to_string

_ARRAY_INDEX = re.compile(r"0|[1-9][0-9]{0,9}")
_MAX_ARRAY_INDEX = 2**32 - 2
_ESCAPE = re.compile('[\x00-\x1f"\\\\\ud800-\udfff]')
_SHORT = {'"': '\\"', "\\": "\\\\", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t"}
_MAX_SAFE = 2**53 - 1


def is_array_index(key: str) -> bool:
    """Whether JavaScript treats ``key`` as an array index (listed first, in numeric order)."""
    return bool(_ARRAY_INDEX.fullmatch(key)) and int(key) <= _MAX_ARRAY_INDEX


def utf16_key(key: str) -> bytes:
    """Sort key comparing strings by UTF-16 code units, like JavaScript's default sort."""
    return key.encode("utf-16-be", "surrogatepass")


def js_key_order(keys: Iterable[str]) -> list[str]:
    """Property order of a JavaScript object created with ``keys`` in this insertion order."""
    keys = list(keys)
    indexes = sorted((k for k in keys if is_array_index(k)), key=int)
    return indexes + [k for k in keys if not is_array_index(k)]


def quote(text: str) -> str:
    """``JSON.stringify(text)``."""
    return '"' + _ESCAPE.sub(lambda m: _SHORT.get(m.group()) or f"\\u{ord(m.group()):04x}", text) + '"'


def _number(value: int | float) -> str:
    if isinstance(value, float) and not math.isfinite(value):
        return "null"
    return number_to_string(value)


def _write(value: Any, out: list[str], sort: bool) -> None:
    if value is None:
        out.append("null")
    elif value is True:
        out.append("true")
    elif value is False:
        out.append("false")
    elif isinstance(value, str):
        out.append(quote(value))
    elif is_number(value):
        out.append(_number(value))
    elif isinstance(value, Mapping):
        keys = [str(k) for k in value]
        keys = sorted(keys, key=utf16_key) if sort else js_key_order(keys)
        out.append("{")
        for i, key in enumerate(keys):
            if i:
                out.append(",")
            out.append(quote(key))
            out.append(":")
            _write(value[key], out, sort)
        out.append("}")
    elif isinstance(value, (list, tuple)):
        out.append("[")
        for i, item in enumerate(value):
            if i:
                out.append(",")
            _write(item, out, sort)
        out.append("]")
    else:
        raise TypeError("Cache requires finite, acyclic JSON values")


def stringify(value: Any) -> str:
    """``JSON.stringify(value)`` for JSON values (dicts in JavaScript property order)."""
    out: list[str] = []
    _write(value, out, sort=False)
    return "".join(out)


def canonical(value: Any) -> str:
    """Canonical JSON: keys sorted by UTF-16 code units at every level."""
    out: list[str] = []
    _write(value, out, sort=True)
    return "".join(out)


def snapshot(value: Any) -> Any:
    """``JSON.parse(canonical(value))``: a deep copy with JavaScript key order and float64 numbers."""
    if isinstance(value, Mapping):
        ordered = js_key_order(sorted((str(k) for k in value), key=utf16_key))
        return {key: snapshot(value[key]) for key in ordered}
    if isinstance(value, (list, tuple)):
        return [snapshot(item) for item in value]
    if isinstance(value, int) and not isinstance(value, bool) and abs(value) > _MAX_SAFE:
        return float(value)  # JavaScript numbers are float64
    if isinstance(value, float) and value == 0:
        return 0  # JSON.parse("0") after -0 was written "0"
    return value
