"""FileCache: NoSQLCache over a local JSON file (port of ``@gsalgadotoledo/rt-app-cache-file``).

The file is a :class:`rt_app.nosql.json.JsonStore` database (``{"format": 1, "rows": […]}``, shared
with every language): writers coordinate through ``<file>.lock`` and replace the file atomically,
and every write drops ``CACHE#``, ``OBSERVER#`` and ``VISITS`` rows whose ``ttl`` (seconds) has
passed in real time. Use a dedicated cache file, not the application's database file; small
datasets only.
"""
from __future__ import annotations

import os

from ..contracts import Clock
from ..nosql.json import JsonStore
from .nosql import NoSQLCache

#: Former name of :class:`rt_app.nosql.json.JsonStore`, kept for existing imports.
JsonFileStore = JsonStore


class FileCache(NoSQLCache):
    """``FileCache(".rt-app/cache.json")``: a cache shared by every process on this machine.

    Retention uses real time; ``clock`` only drives entry expiry, like the TypeScript FileCache.
    """

    def __init__(self, file: str | os.PathLike[str] = ".rt-app/cache.json", namespace: str = "default", clock: Clock | None = None) -> None:
        super().__init__(JsonStore(file), namespace, clock)


__all__ = ["FileCache", "JsonFileStore"]
