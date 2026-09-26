"""Contract host for the Python implementations (run with: sh hosts/python.sh hosts/python_host.py)."""
from __future__ import annotations

from typing import Any

from rt_app.conformance import run_host
from rt_app.feature_flags import FeatureFlags
from rt_app.nosql import MemoryStore, Row


def memory_store(rows: list[Row] | None = None) -> MemoryStore:
    """A memory store holding the given rows (as written by version-guarded creates)."""
    store = MemoryStore()
    if rows:
        store.transact([{"row": row, "expected": None} for row in rows])
    return store


def _rows(init: Any) -> list[Row] | None:
    return init.get("rows") if isinstance(init, dict) else None


if __name__ == "__main__":
    run_host(
        {
            "nosql-memory": lambda init: memory_store(_rows(init)),
            "feature-flags": lambda init: FeatureFlags(memory_store(_rows(init))),
        }
    )
