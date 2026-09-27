"""``JSON.stringify(value, null, indent)`` for the JSON values the Observer writes.

- object keys follow JavaScript property order: array-index keys ("0" … "4294967294") first in
  ascending numeric order, then the other keys in insertion order;
- numbers are JavaScript numbers (``1.0`` is ``1``, ``1e-7``, ``1e+21``); NaN and infinities are null;
- only ``"``, ``\\`` and control characters are escaped (``\\b \\f \\n \\r \\t`` or ``\\u00xx``), plus
  lone surrogates (``\\udxxx``); other characters are written as they are;
- ``indent`` > 0 writes the pretty form: one member per line, ``": "`` after keys, ``{}``/``[]``
  for empty containers.
"""
from __future__ import annotations

import math
from collections.abc import Mapping
from typing import Any

from .._jsnum import is_number, number_to_string

_ESCAPES = {'"': '\\"', "\\": "\\\\", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t"}


def is_array_index(key: str) -> bool:
    """Whether JavaScript orders ``key`` as an array index (canonical integer below 2**32 - 1)."""
    if not key or not key.isascii() or not key.isdigit() or (key[0] == "0" and len(key) > 1):
        return False
    return int(key) <= 2**32 - 2


def ordered_items(value: Mapping[Any, Any]) -> list[tuple[str, Any]]:
    """Object entries in JavaScript property order (``Object.entries``)."""
    items = [(str(k), v) for k, v in value.items()]
    indexes = sorted((item for item in items if is_array_index(item[0])), key=lambda item: int(item[0]))
    return indexes + [item for item in items if not is_array_index(item[0])]


def quote(text: str) -> str:
    out = ['"']
    for ch in text:
        code = ord(ch)
        if ch in _ESCAPES:
            out.append(_ESCAPES[ch])
        elif code < 0x20 or 0xD800 <= code <= 0xDFFF:
            out.append(f"\\u{code:04x}")
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def stringify(value: Any, indent: int = 0) -> str:
    """``JSON.stringify(value, null, indent)`` (compact when ``indent`` is 0)."""
    parts: list[str] = []
    _write(parts, value, indent, "")
    return "".join(parts)


def _write(parts: list[str], value: Any, indent: int, prefix: str) -> None:
    if value is None:
        parts.append("null")
    elif value is True:
        parts.append("true")
    elif value is False:
        parts.append("false")
    elif isinstance(value, str):
        parts.append(quote(value))
    elif is_number(value):
        parts.append("null" if isinstance(value, float) and not math.isfinite(value) else number_to_string(value))
    elif isinstance(value, Mapping):
        items = ordered_items(value)
        if not items:
            parts.append("{}")
            return
        inner = prefix + " " * indent
        parts.append("{")
        for i, (key, item) in enumerate(items):
            if i:
                parts.append(",")
            if indent:
                parts.append("\n" + inner)
            parts.append(quote(key) + (": " if indent else ":"))
            _write(parts, item, indent, inner)
        parts.append(("\n" + prefix if indent else "") + "}")
    elif isinstance(value, (list, tuple)):
        if not value:
            parts.append("[]")
            return
        inner = prefix + " " * indent
        parts.append("[")
        for i, item in enumerate(value):
            if i:
                parts.append(",")
            if indent:
                parts.append("\n" + inner)
            _write(parts, item, indent, inner)
        parts.append(("\n" + prefix if indent else "") + "]")
    else:
        raise TypeError(f"Cannot write {type(value).__name__} as JSON")
