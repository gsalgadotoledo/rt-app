"""Subjects: nosql-memory, nosql-json, feature-flags."""
from __future__ import annotations

import shutil
import tempfile
from pathlib import Path
from typing import Any

from rt_app.feature_flags import FeatureFlags
from rt_app.nosql import MemoryStore, Page, Row, Write
from rt_app.nosql.json import JsonStore


def memory_store(rows: list[Row] | None = None) -> MemoryStore:
    """A memory store holding the given rows (as written by version-guarded creates)."""
    store = MemoryStore()
    if rows:
        store.transact([{"row": row, "expected": None} for row in rows])
    return store


def rows_of(init: Any) -> list[Row] | None:
    return init.get("rows") if isinstance(init, dict) else None


class TempJsonStore:
    """A JsonStore on a fresh temporary file holding the given rows; close() removes the directory."""

    def __init__(self, rows: list[Row] | None) -> None:
        self._dir = tempfile.mkdtemp(prefix="rt-contract-nosql-json-")
        self._store = JsonStore(Path(self._dir) / "db.json")
        if rows:
            self._store.transact([{"row": row, "expected": None} for row in rows])

    def get(self, pk: str, sk: str) -> Row | None:
        return self._store.get(pk, sk)

    def transact(self, writes: list[Write]) -> None:
        self._store.transact(writes)

    def list(self, pk: str, cursor: str | None = None) -> Page:
        return self._store.list(pk, cursor)

    def close(self) -> None:
        shutil.rmtree(self._dir, ignore_errors=True)


SUBJECTS = {
    "nosql-memory": lambda init: memory_store(rows_of(init)),
    "nosql-json": lambda init: TempJsonStore(rows_of(init)),
    "feature-flags": lambda init: FeatureFlags(memory_store(rows_of(init))),
}
