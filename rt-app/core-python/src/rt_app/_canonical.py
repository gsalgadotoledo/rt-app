"""Canonical JSON shared by the cache and idempotency modules (TypeScript is the reference).

``canonical(value)`` is the TypeScript ``canonical``: ``JSON.stringify`` output with object keys
sorted by UTF-16 code units (JavaScript ``Array.prototype.sort``), so ``"😀"`` (D83D DE00) sorts
before ``"！"`` (U+FF01). Numbers are JavaScript numbers (float64): ``1e+21``, ``1e-7``, ``-0`` is
``0`` and integers above 2**53 are rounded. Strings are written like ``JSON.stringify``: only
``"``, ``\\`` and U+0000-U+001F are escaped (plus lone surrogates), never U+2028, DEL or ``<>&``.
"""
from __future__ import annotations

import hashlib
import math
import re
from collections.abc import Callable
from typing import Any

from . import _js, _jsnum

_LONE_SURROGATE = re.compile("[\ud800-\udfff]")

#: Builds the exception to raise; ``kind`` is ``"value"`` (not finite, acyclic JSON) or ``"object"``
#: (not a plain object).
Fail = Callable[[str], Exception]


def _utf16_key(text: str) -> bytes:
    return text.encode("utf-16-be", "surrogatepass")


def number(value: int | float) -> str | None:
    """``JSON.stringify`` of a finite number as float64, or None when it is not finite."""
    try:
        x = float(value)
    except OverflowError:
        return None
    if not math.isfinite(x):
        return None
    return _jsnum.number_to_string(x)


def canonical(value: Any, fail: Fail) -> str:
    """Canonical JSON text of ``value``; ``fail(kind)`` builds the error for non-JSON input."""
    parts: list[str] = []
    ancestors: set[int] = set()

    def write(item: Any) -> None:
        if item is None:
            parts.append("null")
        elif item is True:
            parts.append("true")
        elif item is False:
            parts.append("false")
        elif isinstance(item, str):
            parts.append(_js.stringify(item))
        elif isinstance(item, (int, float)):
            text = number(item)
            if text is None:
                raise fail("value")
            parts.append(text)
        elif isinstance(item, (list, tuple, dict)):
            if id(item) in ancestors:
                raise fail("value")
            ancestors.add(id(item))
            if isinstance(item, dict):
                if not all(isinstance(key, str) for key in item):
                    raise fail("object")
                parts.append("{")
                for i, key in enumerate(sorted(item, key=_utf16_key)):
                    if i:
                        parts.append(",")
                    parts.append(_js.stringify(key))
                    parts.append(":")
                    write(item[key])
                parts.append("}")
            else:
                parts.append("[")
                for i, element in enumerate(item):
                    if i:
                        parts.append(",")
                    write(element)
                parts.append("]")
            ancestors.discard(id(item))
        else:
            raise fail("object")

    write(value)
    return "".join(parts)


def utf8(text: str) -> bytes:
    """``Buffer.from(text)`` / ``TextEncoder``: UTF-8 with lone surrogates as U+FFFD."""
    return _LONE_SURROGATE.sub("�", text).encode("utf-8")


def sha256_hex(text: str) -> str:
    """Hex SHA-256 of the UTF-8 text (lone surrogates as U+FFFD)."""
    return hashlib.sha256(utf8(text)).hexdigest()


def parse(text: str) -> Any:
    """``JSON.parse`` of canonical text."""
    return _js.parse(text)
