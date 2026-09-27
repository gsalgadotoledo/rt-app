"""JsonStore: a NoSQL store in one local JSON file (port of ``@gsalgadotoledo/rt-app-json``).

For small local databases only (development, demos, single-machine tools). Every language reads and
writes the same file, so a database created by the TypeScript server can be opened here and vice
versa (``rt-app/spec/contracts/json.contract.yaml`` pins the format)::

    store = JsonStore(".rt-app/local.json")
    store.transact([{"row": {"pk": "USERS", "sk": "ana", "version": 1, "data": {}}, "expected": None}])
    secret = local_secret(".rt-app/local.json")   # the auth key kept next to the database

- File: ``JSON.stringify({format: 1, rows: [...]})``, UTF-8, compact. Rows keep their first-insertion
  order and any unknown fields; every write re-serializes the file like JavaScript (JavaScript
  numbers, ``JSON.stringify`` string escapes, array-index keys first in object key order).
- Processes coordinate through ``<file>.lock`` (created exclusively, polled every 20 ms, 5 s
  timeout); writes replace the file atomically (temporary file, fsync, rename; mode 0600).
- Every transaction drops ``OBSERVER#…``, ``CACHE#…`` and ``VISITS`` rows whose ``ttl`` (seconds) is
  at or before the clock; reads never drop rows.
- ``list`` orders a partition by Unicode code point, 50 rows per page, like every store.
"""
from __future__ import annotations

import copy
import json
import math
import os
import re
import secrets
import time
import uuid
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any, Final, TypeVar

from .. import _canonical, _js
from ..contracts import Clock, epoch_ms
from ..errors import Conflict
from . import PAGE_SIZE, Page, Row, Write, decode_cursor, encode_cursor

T = TypeVar("T")

DEFAULT_LOCK_TIMEOUT_MS: Final = 5000
LOCK_POLL_SECONDS: Final = 0.02
#: Partitions whose expired rows every write drops (observer events, cache entries, visits).
RETAINED_PREFIXES: Final = ("OBSERVER#", "CACHE#")
RETAINED_PARTITIONS: Final = ("VISITS",)

INVALID_DATABASE: Final = "Invalid JSON database"
DUPLICATE_DATABASE_KEY: Final = "Duplicate JSON database key"
INVALID_ROW: Final = "Invalid JSON row"
DUPLICATE_TRANSACTION_KEY: Final = "Duplicate transaction key"
INVALID_SECRET: Final = "Invalid local auth key; restore it with the matching database"

_ARRAY_INDEX = re.compile(r"0|[1-9][0-9]*", re.ASCII)
_DECIMAL = re.compile(r"[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?", re.ASCII)
_JS_SPACE = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
_SECRET = re.compile(r"[a-f0-9]{96}")


class JsonStoreError(RuntimeError):
    """A JSON database the store cannot use (invalid, duplicated keys, locked, bad write)."""


# --- JavaScript JSON --------------------------------------------------------------------------


def _is_array_index(key: str) -> bool:
    return bool(_ARRAY_INDEX.fullmatch(key)) and int(key) < 4294967295


def _js_key_order(keys: Sequence[str]) -> list[str]:
    """JavaScript own-property order: array-index keys ascending, then insertion order."""
    indices = sorted((k for k in keys if _is_array_index(k)), key=int)
    return indices + [k for k in keys if not _is_array_index(k)]


def stringify(value: Any) -> str:
    """``JSON.stringify`` of a parsed JSON value: JavaScript numbers and property order.

    ``stringify({"b": 1.0, "2": 0})`` → ``'{"2":0,"b":1}'``; non-finite numbers are ``null``.
    """
    parts: list[str] = []

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
            parts.append(_canonical.number(item) or "null")
        elif isinstance(item, dict):
            parts.append("{")
            for i, key in enumerate(_js_key_order([str(k) for k in item])):
                if i:
                    parts.append(",")
                parts.append(_js.stringify(key))
                parts.append(":")
                write(item[key])
            parts.append("}")
        elif isinstance(item, (list, tuple)):
            parts.append("[")
            for i, element in enumerate(item):
                if i:
                    parts.append(",")
                write(element)
            parts.append("]")
        else:
            raise TypeError(f"Cannot write {type(item).__name__} as JSON")

    write(value)
    return "".join(parts)


def _reject_constant(name: str) -> Any:
    raise ValueError(f"Invalid JSON constant {name}")


def parse(text: str) -> Any:
    """``JSON.parse``: a repeated key keeps its first position and its last value."""
    return json.loads(text, parse_constant=_reject_constant)


def js_number(value: Any) -> float:
    """JavaScript ``Number(value)`` for JSON values (``"0x10"`` → 16, ``" 5 "`` → 5, ``"x"`` → NaN)."""
    if value is None or value is False:
        return 0.0
    if value is True:
        return 1.0
    if _js.is_number(value):
        return float(value)
    if isinstance(value, str):
        text = value.strip(_JS_SPACE)
        if not text:
            return 0.0
        if text in ("Infinity", "+Infinity"):
            return math.inf
        if text == "-Infinity":
            return -math.inf
        prefix = text[:2].lower()
        for mark, base, digits in (("0x", 16, "0123456789abcdefABCDEF"), ("0o", 8, "01234567"), ("0b", 2, "01")):
            if prefix == mark:
                body = text[2:]
                return float(int(body, base)) if body and all(c in digits for c in body) else math.nan
        return float(text) if _DECIMAL.fullmatch(text) else math.nan
    if isinstance(value, list):
        if not value:
            return 0.0
        return js_number(value[0]) if len(value) == 1 and not isinstance(value[0], (list, dict)) else math.nan
    return math.nan


def make_dirs(path: str | os.PathLike[str], mode: int = 0o700) -> None:
    """``mkdir -p`` that gives every created directory ``mode``, like Node's ``mkdir(recursive)``
    (``os.makedirs`` applies it to the leaf only)."""
    path = os.path.abspath(path)
    if os.path.isdir(path):
        return
    make_dirs(os.path.dirname(path), mode)
    try:
        os.mkdir(path, mode)
    except FileExistsError:
        if not os.path.isdir(path):
            raise


# --- rows ------------------------------------------------------------------------------------


def valid_row(row: Any) -> bool:
    """A string pk and sk, a safe-integer version and a non-array object data."""
    return (
        isinstance(row, dict)
        and isinstance(row.get("pk"), str)
        and isinstance(row.get("sk"), str)
        and _js.is_safe_integer(row.get("version"))
        and isinstance(row.get("data"), dict)
    )


def _same_version(current: Any, expected: Any) -> bool:
    """JavaScript ``===`` of two JSON values used as versions."""
    if isinstance(current, bool) or isinstance(expected, bool):
        return current is expected
    if _js.is_number(current) and _js.is_number(expected):
        return current == expected
    return type(current) is type(expected) and current == expected


def _truthy(value: Any) -> bool:
    if value is None or value is False:
        return False
    if _js.is_number(value):
        return value != 0 and not (isinstance(value, float) and math.isnan(value))
    if isinstance(value, str):
        return value != ""
    return True


def expired(row: Row, now_seconds: float) -> bool:
    """The retention rule: a retained partition and a truthy ``ttl <= now`` (JavaScript comparison)."""
    pk = row["pk"]
    if not (pk.startswith(RETAINED_PREFIXES) or pk in RETAINED_PARTITIONS):
        return False
    ttl = row.get("ttl")
    if not _truthy(ttl) or isinstance(ttl, dict):
        return False
    number = js_number(ttl)
    return not math.isnan(number) and number <= now_seconds


class JsonStore:
    """``JsonStore(".rt-app/local.json")``: small local databases shared by every process and language."""

    provider = "json"

    def __init__(
        self,
        file: str | os.PathLike[str],
        lock_timeout_ms: float | None = None,
        *,
        now: Clock | None = None,
    ) -> None:
        self.file = Path(os.path.abspath(file))
        self._lock_timeout = (DEFAULT_LOCK_TIMEOUT_MS if lock_timeout_ms is None else lock_timeout_ms) / 1000
        self._now = now

    # Locking and the file -------------------------------------------------------------------

    def _locked(self, operation: Callable[[dict[tuple[str, str], Row]], T]) -> T:
        make_dirs(self.file.parent)
        lock = str(self.file) + ".lock"
        deadline = time.monotonic() + self._lock_timeout
        while True:
            try:
                handle = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                break
            except FileExistsError:
                if time.monotonic() >= deadline:
                    raise JsonStoreError(f"JSON store locked: {lock}. Stop writers before removing a stale lock.") from None
                time.sleep(LOCK_POLL_SECONDS)
        try:
            return operation(self._read())
        finally:
            os.close(handle)
            os.unlink(lock)

    def _read(self) -> dict[tuple[str, str], Row]:
        try:
            text = self.file.read_bytes().decode("utf-8", "replace")
        except FileNotFoundError:
            return {}
        try:
            data = parse(text)
        except ValueError:
            raise JsonStoreError(INVALID_DATABASE) from None
        if not isinstance(data, dict):
            raise JsonStoreError(INVALID_DATABASE)
        version = data.get("format")
        if (
            not _js.is_number(version)
            or version != 1
            or not isinstance(data.get("rows"), list)
            or not all(valid_row(row) for row in data["rows"])
        ):
            raise JsonStoreError(INVALID_DATABASE)
        rows = {(row["pk"], row["sk"]): row for row in data["rows"]}
        if len(rows) != len(data["rows"]):
            raise JsonStoreError(DUPLICATE_DATABASE_KEY)
        return rows

    def _write(self, rows: dict[tuple[str, str], Row]) -> None:
        text = stringify({"format": 1, "rows": list(rows.values())})
        temp = f"{self.file}.{uuid.uuid4()}.tmp"
        try:
            fd = os.open(temp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(fd, "wb") as out:
                out.write(_canonical.utf8(text))
                out.flush()
                os.fsync(out.fileno())
            os.replace(temp, self.file)
        finally:
            try:
                os.unlink(temp)
            except FileNotFoundError:
                pass

    # NoSQL -------------------------------------------------------------------------------------

    def get(self, pk: str, sk: str) -> Row | None:
        """One row (a copy), or None."""
        return self._locked(lambda rows: copy.deepcopy(rows.get((pk, sk))))

    def transact(self, writes: Sequence[Write]) -> None:
        """Apply version-guarded writes atomically, run retention and rewrite the file.

        Each write is checked in order: a valid row (``Invalid JSON row``), a new key (``Duplicate
        transaction key``), then its guard (409 Conflict). A failure writes nothing.
        """
        # Snapshot before waiting for the lock: callers cannot change a queued transaction.
        snapshot: list[Any] = parse(stringify(list(writes)))

        def apply(rows: dict[tuple[str, str], Row]) -> None:
            seen: set[tuple[str, str]] = set()
            for write in snapshot:
                row = write.get("row") if isinstance(write, dict) else None
                if not valid_row(row):
                    raise JsonStoreError(INVALID_ROW)
                key = (row["pk"], row["sk"])
                if key in seen:
                    raise JsonStoreError(DUPLICATE_TRANSACTION_KEY)
                seen.add(key)
                old = rows.get(key)
                expected = write.get("expected")
                stale = old is not None if expected is None else old is None or not _same_version(old["version"], expected)
                if stale:
                    raise Conflict()
            for write in snapshot:
                key = (write["row"]["pk"], write["row"]["sk"])
                if _truthy(write.get("delete")):
                    rows.pop(key, None)
                else:
                    rows[key] = write["row"]
            now_seconds = epoch_ms(self._now) / 1000
            for key in [key for key, row in rows.items() if expired(row, now_seconds)]:
                del rows[key]
            self._write(rows)

        self._locked(apply)

    def list(self, pk: str, cursor: str | None = None) -> Page:
        """Up to 50 rows of one partition in code point order of ``sk``, and a cursor when more exist."""
        after = decode_cursor(pk, cursor) if cursor else ""

        def page(rows: dict[tuple[str, str], Row]) -> Page:
            matching = sorted((row for row in rows.values() if row["pk"] == pk and row["sk"] > after), key=lambda row: row["sk"])
            items = copy.deepcopy(matching[:PAGE_SIZE])
            result: Page = {"items": items}
            if len(matching) > PAGE_SIZE:
                result["cursor"] = encode_cursor(pk, items[-1]["sk"])
            return result

        return self._locked(page)

    def close(self) -> None:
        """Nothing to release: every operation opens and closes the file."""


def local_secret(database: str | os.PathLike[str]) -> str:
    """The local auth key kept next to a database: ``<database>.key`` (created once, mode 0600).

    ``local_secret(".rt-app/local.json")`` → 96 lowercase hex characters. An existing file is kept;
    one that is not exactly 96 lowercase hex characters raises ``Invalid local auth key; restore it
    with the matching database``.
    """
    file = os.path.abspath(database) + ".key"
    make_dirs(os.path.dirname(file))
    try:
        fd = os.open(file, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        pass
    else:
        with os.fdopen(fd, "wb") as out:
            out.write(secrets.token_hex(48).encode("ascii"))
            out.flush()
            os.fsync(out.fileno())
    key = Path(file).read_bytes().decode("utf-8", "replace")
    if not _SECRET.fullmatch(key):
        raise JsonStoreError(INVALID_SECRET)
    return key


__all__ = [
    "JsonStore",
    "JsonStoreError",
    "local_secret",
    "stringify",
    "parse",
    "js_number",
    "valid_row",
    "expired",
]
