"""NoSQLCache: cache entries in a NoSQL store (port of ``@gsalgadotoledo/rt-app-cache-nosql``).

Rows: ``{pk: "CACHE#" + namespace, sk: sha256hex(utf8(key)), version, data: {value, expires},
ttl: ceil(expires / 1000)}``. Expiry is enforced on reads (``expires > now`` is live) even when the
provider's TTL cleanup is late; reads never delete. Writes are version-guarded and retry a
``Conflict`` up to four attempts in total; other store errors propagate at once.
"""
from __future__ import annotations

import copy
import math
from collections.abc import Callable

from .. import _canonical, _js
from ..contracts import Clock, epoch_ms
from ..errors import Conflict
from ..nosql import NoSQL, Row, Write
from . import MISS, CacheValue, _Miss, checked_json, validate_entry

ATTEMPTS = 4


class NoSQLCache:
    """Logical-TTL cache over any NoSQL store (memory, JSON file, DynamoDB, PostgreSQL)."""

    def __init__(self, store: NoSQL, namespace: str = "default", clock: Clock | None = None) -> None:
        self.store = store
        self.namespace = namespace
        self._clock = clock

    def _address(self, key: str) -> tuple[str, str]:
        return "CACHE#" + self.namespace, _canonical.sha256_hex(key)

    def _now(self) -> float:
        return epoch_ms(self._clock)

    def get(self, key: str) -> CacheValue | _Miss:
        """A copy of the stored value while ``expires > now``; MISS otherwise (rows are kept)."""
        row = self.store.get(*self._address(key))
        if not row:
            return MISS
        data = row.get("data") or {}
        expires = data.get("expires")
        if not _js.is_number(expires) or not expires > self._now() or "value" not in data:
            return MISS
        return copy.deepcopy(data["value"])

    def set(self, key: str, value: CacheValue, ttl_ms: int) -> None:
        """Store validated JSON with a version guard; retry conflicts up to four attempts."""
        validate_entry(key, ttl_ms)
        text = checked_json(value)
        expires = self._now() + ttl_ms
        pk, sk = self._address(key)

        def write(row: Row | None) -> Write:
            return {
                "row": {
                    "pk": pk,
                    "sk": sk,
                    "version": (row["version"] if row else 0) + 1,
                    "data": {"value": _canonical.parse(text), "expires": expires},
                    "ttl": math.ceil(expires / 1000),
                },
                "expected": row["version"] if row else None,
            }

        self._mutate(key, write)

    def delete(self, key: str) -> None:
        """Remove the row with a version check; nothing is written when it is absent."""
        self._mutate(key, lambda row: {"row": row, "expected": row["version"], "delete": True} if row else None)

    def _mutate(self, key: str, operation: Callable[[Row | None], Write | None]) -> None:
        """Re-read on conflict; propagate infrastructure errors without retrying them."""
        pk, sk = self._address(key)
        for attempt in range(ATTEMPTS):
            write = operation(self.store.get(pk, sk))
            if write is None:
                return
            try:
                self.store.transact([write])
                return
            except Conflict:
                if attempt == ATTEMPTS - 1:
                    raise


__all__ = ["NoSQLCache"]
