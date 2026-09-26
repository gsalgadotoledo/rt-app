"""NoSQL store contract (rows with versions) and the in-memory reference store.

Rows are ``{pk, sk, version, data, ttl?}``. ``transact`` applies version-guarded writes atomically:
``expected=None`` means "must not exist", a number means "must have exactly this version".
``list`` returns one partition sorted by ``sk`` in Unicode code point order, 50 rows per page.

Stores: ``MemoryStore`` (here), ``PostgresStore`` (``rt_app.nosql.postgres``, needs psycopg) and
``DynamoStore`` (``rt_app.nosql.dynamodb``, needs boto3). The database stores are imported lazily,
so ``from rt_app.nosql import PostgresStore`` works without loading drivers until a store is built.
"""
from __future__ import annotations

import copy
import threading
from collections.abc import Sequence
from typing import Any, NotRequired, Protocol, TypedDict, runtime_checkable

from .. import _js
from ..errors import Conflict, HttpError

PAGE_SIZE = 50


class Row(TypedDict):
    pk: str
    sk: str
    version: int
    data: dict[str, Any]
    ttl: NotRequired[int]


class Write(TypedDict):
    row: Row
    expected: int | None
    delete: NotRequired[bool]


class Page(TypedDict):
    items: list[Row]
    cursor: NotRequired[str]


@runtime_checkable
class NoSQL(Protocol):
    """What modules need from a store. MemoryStore, DynamoDB or Postgres adapters implement it."""

    def get(self, pk: str, sk: str) -> Row | None: ...

    def transact(self, writes: Sequence[Write]) -> None: ...

    def list(self, pk: str, cursor: str | None = None) -> Page: ...


def encode_cursor(pk: str, sk: str) -> str:
    """Opaque cursor: base64url (no padding) of compact JSON ``{"pk":…,"sk":…}``."""
    return _js.base64url_encode(_js.stringify({"pk": pk, "sk": sk}).encode("utf-8"))


def decode_cursor(pk: str, cursor: str) -> str:
    """Sort key a cursor continues after; 400 "Invalid cursor" when malformed or for another partition."""
    try:
        key = _js.parse(_js.base64url_decode(cursor).decode("utf-8", "replace"))
        if not isinstance(key, dict) or key.get("pk") != pk or not isinstance(key.get("sk"), str):
            raise ValueError("cursor does not belong to this partition")
        return key["sk"]
    except Exception:
        raise HttpError(400, "Invalid cursor") from None


def _same_version(current: object, expected: object) -> bool:
    """JavaScript ``===`` for versions: numbers compare by value, ``True`` is not ``1``."""
    if isinstance(current, bool) or isinstance(expected, bool):
        return current is expected
    return type(current) in (int, float) and type(expected) in (int, float) and current == expected


class MemoryStore:
    """Development/test store. It is NOT a durable production database.

    Thread-safe: transactions are atomic across threads. Rows are copied in and out, so callers
    never share mutable state with the store.
    """

    provider = "memory"

    def __init__(self) -> None:
        self._rows: dict[tuple[str, str], Row] = {}
        self._lock = threading.Lock()

    def get(self, pk: str, sk: str) -> Row | None:
        """Read one row; absence returns None."""
        with self._lock:
            return copy.deepcopy(self._rows.get((pk, sk)))

    def transact(self, writes: Sequence[Write]) -> None:
        """Apply all version-guarded writes atomically; conflicts never commit a partial transaction."""
        with self._lock:
            keys: set[tuple[str, str]] = set()
            for write in writes:
                key = (write["row"]["pk"], write["row"]["sk"])
                if key in keys:
                    raise ValueError("Duplicate transaction key")
                keys.add(key)
                old = self._rows.get(key)
                expected = write.get("expected")
                if expected is None:
                    stale = old is not None
                else:
                    stale = old is None or not _same_version(old["version"], expected)
                if stale:
                    raise Conflict()
            for write in writes:
                key = (write["row"]["pk"], write["row"]["sk"])
                if write.get("delete"):
                    self._rows.pop(key, None)
                else:
                    self._rows[key] = copy.deepcopy(write["row"])

    def list(self, pk: str, cursor: str | None = None) -> Page:
        """Return up to 50 rows and a cursor bound to this partition; reject cross-partition cursors."""
        after = decode_cursor(pk, cursor) if cursor else ""
        with self._lock:
            rows = sorted(
                (row for row in self._rows.values() if row["pk"] == pk and row["sk"] > after),
                key=lambda row: row["sk"],
            )
            items = copy.deepcopy(rows[:PAGE_SIZE])
        page: Page = {"items": items}
        if len(rows) > PAGE_SIZE:
            page["cursor"] = encode_cursor(pk, items[-1]["sk"])
        return page


def __getattr__(name: str) -> Any:
    """Lazy exports: the PostgreSQL and DynamoDB stores load only when first used."""
    if name == "PostgresStore":
        from .postgres import PostgresStore

        return PostgresStore
    if name == "DynamoStore":
        from .dynamodb import DynamoStore

        return DynamoStore
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = [
    "Row",
    "Write",
    "Page",
    "NoSQL",
    "MemoryStore",
    "PostgresStore",
    "DynamoStore",
    "PAGE_SIZE",
    "encode_cursor",
    "decode_cursor",
]
