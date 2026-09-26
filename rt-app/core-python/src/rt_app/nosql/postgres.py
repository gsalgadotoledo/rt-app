"""NoSQL store on PostgreSQL (port of ``@gsalgadotoledo/rt-app-postgres``), with psycopg 3.

One table of ``(pk, sk, version, data jsonb, ttl)``; the TypeScript and Python stores share tables.
Version-guarded writes run in one SQL transaction, so a conflict rolls back the whole write set,
exactly like DynamoDB transactions. ``list`` orders by ``sk COLLATE "C"`` (code point order).

Needs the optional dependency ``psycopg`` (``pip install "rt-app-core[postgres]"``); it is imported
when a store is created, so ``rt_app`` works without it.
"""
from __future__ import annotations

import queue
import re
import threading
import urllib.parse
from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from typing import TYPE_CHECKING, Any, TypeVar

from .. import _js
from ..errors import Conflict
from . import PAGE_SIZE, Page, Row, Write, decode_cursor, encode_cursor

if TYPE_CHECKING:
    import psycopg

T = TypeVar("T")

_TABLE = re.compile(r"[a-z_][a-z0-9_]{0,62}")
_LOCAL_HOSTS = ("localhost", "127.0.0.1", "::1")


def table_name(name: str) -> str:
    """A safe unquoted table name (``^[a-z_][a-z0-9_]{0,62}$``)."""
    if not isinstance(name, str) or not _TABLE.fullmatch(name):
        raise ValueError(f"Invalid table name: {name}")
    return name


def _to_row(record: tuple[Any, ...]) -> Row:
    pk, sk, version, data, ttl = record
    row: Row = {
        "pk": pk,
        "sk": sk,
        "version": int(version),
        "data": _js.parse(data) if isinstance(data, str) else data,
    }
    if ttl is not None:
        row["ttl"] = int(ttl)
    return row


def _json(value: Any) -> str:
    """``JSON.stringify`` of row data for a ``$n::jsonb`` parameter."""
    return _js.stringify(value)


def _version(value: Any) -> Any:
    """A version parameter; non-numbers (``True`` included) can never equal an integer column."""
    return value if _js.is_number(value) else None


class _Pool:
    """A small thread-safe connection pool (at most ``size`` open connections, reused LIFO)."""

    def __init__(self, connect: Callable[[], psycopg.Connection[Any]], size: int) -> None:
        self._connect = connect
        self._idle: queue.LifoQueue[psycopg.Connection[Any]] = queue.LifoQueue()
        self._slots = threading.BoundedSemaphore(size)
        self._closed = False

    @contextmanager
    def connection(self) -> Iterator[psycopg.Connection[Any]]:
        if self._closed:
            raise RuntimeError("PostgresStore is closed")
        self._slots.acquire()
        conn: psycopg.Connection[Any] | None = None
        try:
            while conn is None:
                try:
                    candidate = self._idle.get_nowait()
                except queue.Empty:
                    conn = self._connect()
                    break
                if candidate.closed or candidate.broken:
                    continue
                conn = candidate
            yield conn
        finally:
            if conn is not None:
                if self._closed or conn.closed or conn.broken or conn.info.transaction_status != 0:
                    conn.close()  # IDLE (0) connections only go back to the pool
                else:
                    self._idle.put(conn)
            self._slots.release()

    def close(self) -> None:
        self._closed = True
        while True:
            try:
                self._idle.get_nowait().close()
            except queue.Empty:
                return


class PostgresStore:
    """NoSQL store contract on PostgreSQL. Thread-safe; every read sees committed data.

    ``PostgresStore(url, table="rt_app_rows")`` connects with a connection string (DATABASE_URL).
    TLS with certificate and host verification is required unless the host is local or
    ``ssl=False`` is passed; an ``sslmode`` in the URL always wins. The table is created on first
    use (``ensure_schema``), so no entry point has to prepare the database.
    """

    provider = "postgres"

    def __init__(self, url: str, *, table: str = "rt_app_rows", max: int = 10, ssl: bool | None = None) -> None:  # noqa: A002
        import psycopg  # optional dependency: rt-app-core[postgres]

        self.table = table_name(table)
        parts = urllib.parse.urlsplit(url)
        local = (parts.hostname or "localhost") in _LOCAL_HOSTS
        options: dict[str, Any] = {"autocommit": True}
        if "sslmode" not in urllib.parse.parse_qs(parts.query):
            if ssl if ssl is not None else not local:
                options.update(sslmode="verify-full", sslrootcert="system")
            else:
                options["sslmode"] = "disable"
        self._pool = _Pool(lambda: psycopg.Connection.connect(url, **options), max)
        self._schema_lock = threading.Lock()
        self._schema_ready = False

    # Schema ---------------------------------------------------------------------------------

    def ensure_schema(self) -> None:
        """Create the table if missing. Idempotent; runs once per store before the first query."""
        if self._schema_ready:
            return
        with self._schema_lock:
            if self._schema_ready:
                return
            with self._pool.connection() as conn:
                conn.execute(
                    f"""CREATE TABLE IF NOT EXISTS {self.table} (
        pk text NOT NULL,
        sk text NOT NULL,
        version integer NOT NULL,
        data jsonb NOT NULL,
        ttl bigint,
        PRIMARY KEY (pk, sk)
      )"""  # type: ignore[arg-type]  # the table name is validated
                )
            self._schema_ready = True

    def drop_table(self) -> None:
        """Drop this store's table (tests and throwaway environments). Destructive."""
        with self._pool.connection() as conn:
            conn.execute(f"DROP TABLE IF EXISTS {self.table}")  # type: ignore[arg-type]
        self._schema_ready = False

    def close(self) -> None:
        """Close the pooled connections."""
        self._pool.close()

    # Store contract -------------------------------------------------------------------------

    def get(self, pk: str, sk: str) -> Row | None:
        """Read one row; absence returns None."""
        self.ensure_schema()
        with self._pool.connection() as conn:
            record = conn.execute(
                f"SELECT pk, sk, version, data, ttl FROM {self.table} WHERE pk = %s AND sk = %s",  # type: ignore[arg-type]
                (pk, sk),
            ).fetchone()
        return _to_row(record) if record else None

    def transact(self, writes: Sequence[Write]) -> None:
        """Apply version-guarded writes atomically: ``expected=None`` means "must not exist", a
        number means "must have this version". Any mismatch raises ``Conflict`` and nothing commits.
        Row locks taken by UPDATE/INSERT make concurrent writers re-check the version after waiting.
        """
        if not writes:
            return
        keys: set[tuple[str, str]] = set()
        for write in writes:
            key = (write["row"]["pk"], write["row"]["sk"])
            if key in keys:
                raise ValueError("Duplicate transaction key")
            keys.add(key)
        self.ensure_schema()
        table = self.table
        with self._pool.connection() as conn, conn.transaction():
            for write in writes:
                row, expected, remove = write["row"], write.get("expected"), bool(write.get("delete"))
                ttl = row.get("ttl")
                if expected is None and not remove:
                    changed = conn.execute(
                        f"INSERT INTO {table} (pk, sk, version, data, ttl) VALUES (%s, %s, %s, %s::jsonb, %s) ON CONFLICT (pk, sk) DO NOTHING",  # type: ignore[arg-type]
                        (row["pk"], row["sk"], row["version"], _json(row["data"]), ttl),
                    ).rowcount
                elif expected is None:
                    # Deleting a row that must not exist is a no-op, but it still asserts absence.
                    found = conn.execute(
                        f"SELECT 1 FROM {table} WHERE pk = %s AND sk = %s FOR UPDATE",  # type: ignore[arg-type]
                        (row["pk"], row["sk"]),
                    ).fetchall()
                    changed = 0 if found else 1
                elif remove:
                    changed = conn.execute(
                        f"DELETE FROM {table} WHERE pk = %s AND sk = %s AND version = %s",  # type: ignore[arg-type]
                        (row["pk"], row["sk"], _version(expected)),
                    ).rowcount
                else:
                    changed = conn.execute(
                        f"UPDATE {table} SET version = %s, data = %s::jsonb, ttl = %s WHERE pk = %s AND sk = %s AND version = %s",  # type: ignore[arg-type]
                        (row["version"], _json(row["data"]), ttl, row["pk"], row["sk"], _version(expected)),
                    ).rowcount
                if changed != 1:
                    raise Conflict()  # leaving the transaction block rolls everything back

    def list(self, pk: str, cursor: str | None = None) -> Page:
        """Up to 50 rows ordered by sort key (code point order), and a cursor bound to this partition."""
        after = decode_cursor(pk, cursor) if cursor else ""
        self.ensure_schema()
        with self._pool.connection() as conn:
            # Binary collation matches the code point order the other adapters use.
            records = conn.execute(
                f'SELECT pk, sk, version, data, ttl FROM {self.table} WHERE pk = %s AND sk COLLATE "C" > %s '  # type: ignore[arg-type]
                f'ORDER BY sk COLLATE "C" LIMIT {PAGE_SIZE + 1}',
                (pk, after),
            ).fetchall()
        items = [_to_row(record) for record in records[:PAGE_SIZE]]
        page: Page = {"items": items}
        if len(records) > PAGE_SIZE:
            page["cursor"] = encode_cursor(pk, items[-1]["sk"])
        return page


__all__ = ["PostgresStore", "table_name"]
