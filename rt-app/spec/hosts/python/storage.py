"""Subjects: nosql-memory, feature-flags."""
from __future__ import annotations

from typing import Any

from rt_app.feature_flags import FeatureFlags
from rt_app.nosql import MemoryStore, Row


def memory_store(rows: list[Row] | None = None) -> MemoryStore:
    """A memory store holding the given rows (as written by version-guarded creates)."""
    store = MemoryStore()
    if rows:
        store.transact([{"row": row, "expected": None} for row in rows])
    return store


def rows_of(init: Any) -> list[Row] | None:
    return init.get("rows") if isinstance(init, dict) else None


SUBJECTS = {
    "nosql-memory": lambda init: memory_store(rows_of(init)),
    "feature-flags": lambda init: FeatureFlags(memory_store(rows_of(init))),
}
