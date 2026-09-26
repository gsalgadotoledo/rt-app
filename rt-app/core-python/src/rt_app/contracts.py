"""Shared data rules of the identity modules (port of ``@gsalgadotoledo/rt-app-contracts``).

- ``Clock`` / ``epoch_ms``: the injectable clock (epoch milliseconds or a datetime).
- ``text`` / ``email_address``: field validation with JavaScript ``trim``, ``toLowerCase`` and ``\\s``.
- ``public_user`` / ``view_user`` / ``audit_*``: user projections and audit fields.
- ``filtered`` / ``search_page``: case-insensitive list filters and bounded searches.
"""
from __future__ import annotations

import re
import time
from collections.abc import Callable, Mapping, Sequence
from datetime import datetime, timedelta, timezone
from typing import Any

from . import _js
from .errors import HttpError
from .nosql import NoSQL, Row

#: Injectable clock: epoch milliseconds or a datetime. ``None`` means the system clock.
Clock = Callable[[], "float | int | datetime"]

#: JavaScript WhiteSpace + LineTerminator: the set of ``String.prototype.trim`` and regexp ``\s``.
JS_WHITESPACE = "\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
_TRIM = re.compile(f"^[{JS_WHITESPACE}]+|[{JS_WHITESPACE}]+$")
_EMAIL = re.compile(f"[^{JS_WHITESPACE}@]+@[^{JS_WHITESPACE}@]+\\.[^{JS_WHITESPACE}@]+")
_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
_AUDIT_FIELDS = ("createdAt", "createdBy", "updatedAt", "updatedBy", "deletedAt", "deletedBy", "restoredAt", "restoredBy")


def epoch_ms(clock: Clock | None = None) -> float:
    """Current time in epoch milliseconds from an optional clock (the system clock by default)."""
    if clock is None:
        return time.time_ns() // 1_000_000
    value = clock()
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return (value - _EPOCH) // timedelta(milliseconds=1)
    return value


def to_datetime(ms: float) -> datetime:
    """``new Date(ms)``."""
    return _EPOCH + timedelta(milliseconds=ms)


def js_trim(value: str) -> str:
    """``String.prototype.trim``: Unicode White_Space and U+FEFF, but not U+0085 or U+001C-U+001F."""
    return _TRIM.sub("", value)


def text(value: object, field: str, max_length: int = 200) -> str:
    """A non-blank string of at most ``max_length`` UTF-16 units (before trimming), trimmed."""
    if not isinstance(value, str) or not js_trim(value) or _js.utf16_length(value) > max_length:
        raise HttpError(400, f"Invalid field: {field}")
    return js_trim(value)


def email_address(value: object) -> str:
    """Trimmed, lowercased address matching ``^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$`` (JavaScript ``\\s``)."""
    email = text(value, "email", 254).lower()
    if not _EMAIL.fullmatch(email):
        raise HttpError(400, "Invalid email")
    return email


def public_user(data: Mapping[str, Any]) -> dict[str, Any]:
    """The session actor: ``{id, email, name, role, grants, tokenVersion, active}``."""
    keys = ("id", "email", "name", "role", "grants", "tokenVersion", "active")
    return {key: data.get(key) for key in keys}


def audit_view(data: Mapping[str, Any]) -> dict[str, Any]:
    return {key: data.get(key) for key in _AUDIT_FIELDS}


def view_user(data: Mapping[str, Any]) -> dict[str, Any]:
    """Public user view with audit fields; never the password hash or token version."""
    view = public_user(data)
    view.pop("tokenVersion")
    return {**view, **audit_view(data)}


def _iso(at: datetime | None) -> str:
    return _js.iso_timestamp(at or _js.utc_now())


def audit_create(actor: str | None, at: datetime | None = None) -> dict[str, Any]:
    now = _iso(at)
    return {"createdAt": now, "createdBy": actor, "updatedAt": now, "updatedBy": actor, "deletedAt": None, "deletedBy": None}


def audit_update(actor: str | None, at: datetime | None = None) -> dict[str, Any]:
    return {"updatedAt": _iso(at), "updatedBy": actor}


def audit_delete(actor: str, at: datetime | None = None) -> dict[str, Any]:
    now = _iso(at)
    return {"updatedAt": now, "updatedBy": actor, "deletedAt": now, "deletedBy": actor}


def audit_restore(actor: str, at: datetime | None = None) -> dict[str, Any]:
    now = _iso(at)
    return {"updatedAt": now, "updatedBy": actor, "deletedAt": None, "deletedBy": None, "restoredAt": now, "restoredBy": actor}


def js_string(value: object) -> str:
    """``String(value)`` for the JSON values a field can hold."""
    if value is None:
        return ""  # ``?? ""`` in the reference filters
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and value.is_integer() and abs(value) < 1e21:
        return str(int(value))
    if isinstance(value, list):
        return ",".join(js_string(v) for v in value)
    return str(value)


def filtered(items: Sequence[Mapping[str, Any]], query: Mapping[str, str], fields: Sequence[str]) -> list[Mapping[str, Any]]:
    """Case-insensitive substring filters on ``fields``; ``cursor`` is ignored, others are 400."""
    for name in query:
        if name != "cursor" and name not in fields:
            raise HttpError(400, f"Unsupported filter: {name}")
    return [
        item
        for item in items
        if all(not query.get(field) or query[field].lower() in js_string(item.get(field)).lower() for field in fields)
    ]


def search_page(
    store: NoSQL,
    pk: str,
    query: Mapping[str, str],
    fields: Sequence[str],
    project: Callable[[Row], Mapping[str, Any] | None],
) -> dict[str, Any]:
    """Search bounded pages (10 at most), keeping the cursor while more data remains to inspect."""
    filters = {k: v for k, v in query.items() if k != "trash"}
    trash = query.get("trash")
    if trash is not None and trash not in ("true", "false"):
        raise HttpError(400, "Invalid trash filter")
    filtered([], filters, fields)  # validate even for empty collections
    cursor = query.get("cursor")
    for _ in range(10):
        page = store.list(pk, cursor)
        rows = [project(row) for row in page["items"] if bool(row["data"].get("deletedAt")) == (trash == "true")]
        items = filtered([row for row in rows if row is not None], filters, fields)
        cursor = page.get("cursor")
        if items or not cursor:
            return {"items": items, "cursor": cursor}
    return {"items": [], "cursor": cursor}


__all__ = [
    "Clock",
    "JS_WHITESPACE",
    "epoch_ms",
    "to_datetime",
    "js_trim",
    "text",
    "email_address",
    "public_user",
    "view_user",
    "audit_view",
    "audit_create",
    "audit_update",
    "audit_delete",
    "audit_restore",
    "filtered",
    "search_page",
]
