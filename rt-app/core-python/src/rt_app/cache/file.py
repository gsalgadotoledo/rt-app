"""FileCache: NoSQLCache over a local JSON file (port of ``@gsalgadotoledo/rt-app-cache-file``).

The file is the ``@gsalgadotoledo/rt-app-json`` ``JsonStore`` format, so every language shares it:
``{"format": 1, "rows": [row, …]}``. Writers coordinate through an exclusive ``<file>.lock`` (polled
every 20 ms, 5 s timeout) and replace the file atomically (temporary file, fsync, rename). Every
write drops ``CACHE#``, ``OBSERVER#`` and ``VISITS`` rows whose ``ttl`` (seconds) has passed in real
time. Use a dedicated cache file, not the application's database file; small datasets only.
"""
from __future__ import annotations

import copy
import os
import time
import uuid
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any, TypeVar

from .. import _js
from ..contracts import Clock
from ..errors import Conflict
from ..nosql import PAGE_SIZE, Page, Row, Write, decode_cursor, encode_cursor
from .nosql import NoSQLCache

T = TypeVar("T")


def _valid(row: Any) -> bool:
    return (
        isinstance(row, dict)
        and isinstance(row.get("pk"), str)
        and isinstance(row.get("sk"), str)
        and _js.is_safe_integer(row.get("version"))
        and isinstance(row.get("data"), dict)
    )


def _row_key(row: Row) -> tuple[str, str]:
    return row["pk"], row["sk"]


def _same_version(current: Any, expected: Any) -> bool:
    if isinstance(current, bool) or isinstance(expected, bool):
        return current is expected
    return _js.is_number(current) and _js.is_number(expected) and current == expected


def _expired(row: Row, now_seconds: float) -> bool:
    pk = row["pk"]
    ttl = row.get("ttl")
    return (
        (pk.startswith("OBSERVER#") or pk.startswith("CACHE#") or pk == "VISITS")
        and _js.is_number(ttl)
        and bool(ttl)
        and ttl <= now_seconds
    )


class JsonFileStore:
    """The JsonStore file format and locking, for small local databases only."""

    provider = "json"

    def __init__(self, file: str | os.PathLike[str], lock_timeout_ms: int = 5000) -> None:
        self.file = Path(file).resolve()
        self._lock_timeout = lock_timeout_ms / 1000

    def _locked(self, operation: Callable[[dict[tuple[str, str], Row]], T]) -> T:
        self.file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        lock = str(self.file) + ".lock"
        deadline = time.monotonic() + self._lock_timeout
        while True:
            try:
                handle = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                break
            except FileExistsError:
                if time.monotonic() >= deadline:
                    raise RuntimeError(f"JSON store locked: {lock}. Stop writers before removing a stale lock.") from None
                time.sleep(0.02)
        try:
            try:
                data = _js.parse(self.file.read_text("utf-8"))
            except FileNotFoundError:
                data = {"format": 1, "rows": []}
            except ValueError:
                raise RuntimeError("Invalid JSON database") from None
            if (
                not isinstance(data, dict)
                or data.get("format") != 1
                or isinstance(data.get("format"), bool)
                or not isinstance(data.get("rows"), list)
                or not all(_valid(row) for row in data["rows"])
            ):
                raise RuntimeError("Invalid JSON database")
            rows = {_row_key(row): row for row in data["rows"]}
            if len(rows) != len(data["rows"]):
                raise RuntimeError("Duplicate JSON database key")
            return operation(rows)
        finally:
            os.close(handle)
            os.unlink(lock)

    def get(self, pk: str, sk: str) -> Row | None:
        """One row, or None."""
        return self._locked(lambda rows: copy.deepcopy(rows.get((pk, sk))))

    def transact(self, writes: Sequence[Write]) -> None:
        """Apply version-guarded writes atomically and rewrite the file."""
        snapshot: list[Write] = _js.parse(_js.stringify(list(writes)))

        def apply(rows: dict[tuple[str, str], Row]) -> None:
            seen: set[tuple[str, str]] = set()
            for write in snapshot:
                if not _valid(write.get("row")):
                    raise RuntimeError("Invalid JSON row")
                key = _row_key(write["row"])
                if key in seen:
                    raise ValueError("Duplicate transaction key")
                seen.add(key)
                old = rows.get(key)
                expected = write.get("expected")
                if (old is not None) if expected is None else (old is None or not _same_version(old["version"], expected)):
                    raise Conflict()
            for write in snapshot:
                key = _row_key(write["row"])
                if write.get("delete"):
                    rows.pop(key, None)
                else:
                    rows[key] = write["row"]
            now_seconds = time.time()
            for key in [key for key, row in rows.items() if _expired(row, now_seconds)]:
                del rows[key]
            temp = f"{self.file}.{uuid.uuid4()}.tmp"
            try:
                fd = os.open(temp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                with os.fdopen(fd, "w", encoding="utf-8") as out:
                    out.write(_js.stringify({"format": 1, "rows": list(rows.values())}))
                    out.flush()
                    os.fsync(out.fileno())
                os.replace(temp, self.file)
            finally:
                try:
                    os.unlink(temp)
                except FileNotFoundError:
                    pass

        self._locked(apply)

    def list(self, pk: str, cursor: str | None = None) -> Page:
        """Up to 50 rows of one partition in code point order of ``sk``."""
        after = decode_cursor(pk, cursor) if cursor else ""

        def page(rows: dict[tuple[str, str], Row]) -> Page:
            matching = sorted((row for row in rows.values() if row["pk"] == pk and row["sk"] > after), key=lambda row: row["sk"])
            items = copy.deepcopy(matching[:PAGE_SIZE])
            result: Page = {"items": items}
            if len(matching) > PAGE_SIZE:
                result["cursor"] = encode_cursor(pk, items[-1]["sk"])
            return result

        return self._locked(page)


class FileCache(NoSQLCache):
    """``FileCache(".rt-app/cache.json")``: a cache shared by every process on this machine."""

    def __init__(self, file: str | os.PathLike[str] = ".rt-app/cache.json", namespace: str = "default", clock: Clock | None = None) -> None:
        super().__init__(JsonFileStore(file), namespace, clock)


__all__ = ["FileCache", "JsonFileStore"]
