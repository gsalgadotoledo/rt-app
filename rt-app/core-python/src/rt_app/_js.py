"""JavaScript-compatible helpers shared by the modules (TypeScript is the reference).

- ``utf16_length`` is JavaScript ``string.length``.
- ``stringify`` / ``parse`` behave like ``JSON.stringify`` / ``JSON.parse`` for JSON values.
- ``iso_timestamp`` is ``Date.prototype.toISOString`` (milliseconds, ``Z``).
- ``run_sync`` runs coroutines on one shared background event loop.
"""
from __future__ import annotations

import asyncio
import base64
import dataclasses
import json
import math
import re
import threading
from collections.abc import Awaitable, Mapping
from datetime import datetime, timezone
from typing import Any, TypeVar

T = TypeVar("T")

_LONE_SURROGATE = re.compile("[\ud800-\udfff]")
_BASE64_CHARS = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/-_")


def utf16_length(text: str) -> int:
    """Length in UTF-16 code units, like JavaScript ``text.length``."""
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


def is_number(value: object) -> bool:
    """``typeof value === "number"``: bool is not a number."""
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def is_finite_number(value: object) -> bool:
    """``Number.isFinite(value)``."""
    if not is_number(value):
        return False
    return isinstance(value, int) or math.isfinite(value)  # type: ignore[arg-type]


def is_safe_integer(value: object) -> bool:
    """``Number.isSafeInteger(value)``: 1.0 counts (JSON cannot tell it from 1), 1.5 does not."""
    if not is_finite_number(value):
        return False
    if isinstance(value, float) and not value.is_integer():
        return False
    return abs(value) <= 2**53 - 1  # type: ignore[arg-type]


def to_json(value: Any) -> Any:
    """Plain JSON value the way ``JSON.stringify`` sees it (dataclasses become objects).

    Non-finite floats become ``None`` (JavaScript writes ``null``); integral floats become ints so
    ``100.0`` is written ``100``. Unsupported types raise ``TypeError``.
    """
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            return None
        return int(value) if value.is_integer() and abs(value) < 1e21 else value
    if isinstance(value, Mapping):
        return {str(k): to_json(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [to_json(v) for v in value]
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return {f.name: to_json(getattr(value, f.name)) for f in dataclasses.fields(value)}
    if isinstance(value, datetime):
        return iso_timestamp(value)
    raise TypeError(f"Cannot write {type(value).__name__} as JSON")


def stringify(value: Any) -> str:
    """Compact JSON like ``JSON.stringify``; lone surrogates are escaped (well-formed output)."""
    text = json.dumps(to_json(value), ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    return _LONE_SURROGATE.sub(lambda m: f"\\u{ord(m.group()):04x}", text)


def _reject_constant(name: str) -> Any:
    raise ValueError(f"Invalid JSON constant {name}")


def parse(text: str) -> Any:
    """``JSON.parse``: raises ``ValueError`` on invalid JSON (NaN/Infinity are not JSON)."""
    return json.loads(text, parse_constant=_reject_constant)


def base64url_encode(data: bytes) -> str:
    """``Buffer.toString("base64url")``: URL alphabet, no padding."""
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def base64url_decode(text: str) -> bytes:
    """``Buffer.from(text, "base64url")``: lenient like Node (skips unknown characters, stops at ``=``)."""
    chars: list[str] = []
    for ch in text:
        if ch == "=":
            break
        if ch in _BASE64_CHARS:
            chars.append("+" if ch == "-" else "/" if ch == "_" else ch)
    data = "".join(chars)
    if len(data) % 4 == 1:
        data = data[:-1]
    return base64.b64decode(data + "=" * (-len(data) % 4))


def iso_timestamp(moment: datetime) -> str:
    """``Date.toISOString()``: UTC with milliseconds, e.g. ``2026-01-02T03:04:05.678Z``."""
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    moment = moment.astimezone(timezone.utc)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


_loop: asyncio.AbstractEventLoop | None = None
_loop_lock = threading.Lock()


def run_sync(awaitable: Awaitable[T]) -> T:
    """Run an awaitable from synchronous code on one shared background event loop.

    One loop for the whole process keeps loop-bound objects (``AsyncSingleton``) valid across calls.
    """
    global _loop
    with _loop_lock:
        if _loop is None:
            _loop = asyncio.new_event_loop()
            threading.Thread(target=_loop.run_forever, name="rt-app-async", daemon=True).start()
        loop = _loop

    async def wrapper() -> T:
        return await awaitable

    return asyncio.run_coroutine_threadsafe(wrapper(), loop).result()
