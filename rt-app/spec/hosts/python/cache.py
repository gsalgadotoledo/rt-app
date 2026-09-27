"""Subjects: cache-memory, cache-nosql, cache-file, cache-dynamodb (optional).

Every subject is a facade over ``Cache(adapter)`` with a settable clock (epoch ms), mirroring
hosts/node/cache.mjs. Contract method names are camelCase and map to these snake_case names.
"""
from __future__ import annotations

import os
import secrets
import shutil
import tempfile
import time
from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from storage import memory_store, rows_of

from rt_app import _js
from rt_app.cache import MISS, Cache, MemoryCache, canonical, content_key, validate_entry
from rt_app.cache.file import FileCache, JsonFileStore
from rt_app.cache.nosql import NoSQLCache
from rt_app.errors import Conflict
from rt_app.nosql import NoSQL, Page, Row, Write

DEFAULT_NOW = 4102444800000  # 2100-01-01


def _init(init: Any) -> dict[str, Any]:
    return init if isinstance(init, dict) else {}


def _namespace(init: dict[str, Any]) -> str:
    """init.namespace, or the adapter default when absent (wire null is "not given")."""
    namespace = init.get("namespace")
    return "default" if namespace is None else namespace


class _Clock:
    """A settable clock in epoch milliseconds, starting at init.now."""

    def __init__(self, init: dict[str, Any]) -> None:
        now = init.get("now")
        self.ms: float = now if _js.is_number(now) else DEFAULT_NOW

    def __call__(self) -> float:
        return self.ms

    def set(self, ms: Any) -> None:
        if not _js.is_finite_number(ms):
            raise TypeError("setNow needs epoch milliseconds")
        self.ms = ms


class FaultyStore:
    """A store whose next transactions can fail on purpose, one queued fault per transaction:
    "ok" passes through, "conflict" raises Conflict and "error" raises "Store unavailable" (both
    without writing), "lostAck" writes and then raises "Acknowledgement lost"."""

    def __init__(self, store: NoSQL) -> None:
        self._store = store
        self._faults: list[str] = []
        self.count = 0

    def get(self, pk: str, sk: str) -> Row | None:
        return self._store.get(pk, sk)

    def list(self, pk: str, cursor: str | None = None) -> Page:
        return self._store.list(pk, cursor)

    def transact(self, writes: Sequence[Write]) -> None:
        self.count += 1
        fault = self._faults.pop(0) if self._faults else None
        if fault == "conflict":
            raise Conflict()
        if fault == "error":
            raise RuntimeError("Store unavailable")
        self._store.transact(writes)
        if fault == "lostAck":
            raise RuntimeError("Acknowledgement lost")

    def inject(self, kind: Any, count: Any = None) -> None:
        if kind not in ("ok", "conflict", "error", "lostAck"):
            raise TypeError(f"Unknown fault {kind}")
        self._faults.extend([kind] * (1 if count is None else int(count)))
        return None


class CacheFacade:
    """The shared surface: Cache methods plus loader bookkeeping and the clock."""

    def __init__(self, cache: Cache, clock: _Clock) -> None:
        self.cache = cache
        self._clock = clock
        self._loads = 0

    def _loader(self, outcome: Any) -> Any:
        def load() -> Any:
            self._loads += 1
            if isinstance(outcome, dict) and isinstance(outcome.get("error"), str):
                raise RuntimeError(outcome["error"])
            return outcome.get("value") if isinstance(outcome, dict) else None

        return load

    def get(self, key: Any) -> dict[str, Any]:
        """{hit: false} | {hit: true, value}: wire null cannot tell a miss from a cached null."""
        value = self.cache.get(key)
        return {"hit": False} if value is MISS else {"hit": True, "value": value}

    def set(self, key: Any, value: Any, ttl_ms: Any) -> None:
        self.cache.set(key, value, ttl_ms)

    def delete(self, key: Any) -> None:
        self.cache.delete(key)

    def remember(self, namespace: Any, input: Any, ttl_ms: Any, outcome: Any) -> Any:
        return self.cache.remember(namespace, input, ttl_ms, self._loader(outcome))

    def loads(self) -> int:
        return self._loads

    def remember_concurrently(self, namespace: Any, input: Any, ttl_ms: Any, value: Any, count: Any) -> dict[str, Any]:
        before = self._loads

        def slow() -> Any:
            self._loads += 1
            time.sleep(0.05)
            return value

        with ThreadPoolExecutor(max_workers=int(count)) as pool:
            futures = [pool.submit(self.cache.remember, namespace, input, ttl_ms, slow) for _ in range(int(count))]
            results = [future.result() for future in futures]
        return {"loads": self._loads - before, "results": results}

    def canonical(self, value: Any) -> str:
        return canonical(value)

    def content_key(self, namespace: Any, input: Any) -> str:
        return content_key(namespace, input)

    def validate_entry(self, key: Any, ttl_ms: Any) -> None:
        validate_entry(key, ttl_ms)

    def set_now(self, ms: Any) -> None:
        self._clock.set(ms)


def memory(init: Any) -> CacheFacade:
    init = _init(init)
    clock = _Clock(init)
    capacity = init.get("capacity")
    adapter = MemoryCache(clock=clock) if capacity is None else MemoryCache(capacity, clock)
    return CacheFacade(Cache(adapter), clock)


class NoSQLFacade(CacheFacade):
    """NoSQLCache over a MemoryStore holding init.rows, with fault injection."""

    def __init__(self, init: Any) -> None:
        init = _init(init)
        clock = _Clock(init)
        self._store = FaultyStore(memory_store(rows_of(init)))
        super().__init__(Cache(NoSQLCache(self._store, _namespace(init), clock)), clock)

    def row(self, pk: Any, sk: Any) -> Row | None:
        return self._store.get(pk, sk)

    def inject_faults(self, kind: Any, count: Any = None) -> None:
        return self._store.inject(kind, count)

    def transacts(self) -> int:
        return self._store.count

    def use_namespace(self, namespace: Any) -> None:
        self.cache = Cache(NoSQLCache(self._store, namespace, self._clock))


class FileFacade(CacheFacade):
    """FileCache on a fresh temporary file; reopen() builds a second instance on the same file."""

    def __init__(self, init: Any) -> None:
        init = _init(init)
        self._dir = tempfile.mkdtemp(prefix="rt-contract-cache-")
        self._path = Path(self._dir) / "cache.json"
        self._namespace = _namespace(init)
        clock = _Clock(init)
        super().__init__(self._build(clock), clock)

    def _build(self, clock: _Clock) -> Cache:
        return Cache(FileCache(self._path, self._namespace, clock))

    def row(self, pk: Any, sk: Any) -> Row | None:
        return JsonFileStore(self._path).get(pk, sk)

    def reopen(self) -> None:
        self.cache = self._build(self._clock)

    def file(self) -> Any:
        try:
            return _js.parse(self._path.read_text("utf-8"))
        except FileNotFoundError:
            return None

    def close(self) -> None:
        shutil.rmtree(self._dir, ignore_errors=True)


class DynamoFacade(CacheFacade):
    """DynamoCache on a fresh DynamoDB Local table (RT_APP_TEST_DYNAMODB_ENDPOINT); deleted on close."""

    def __init__(self, init: Any) -> None:
        import boto3

        from rt_app.cache.dynamodb import DynamoCache

        init = _init(init)
        clock = _Clock(init)
        endpoint = os.environ["RT_APP_TEST_DYNAMODB_ENDPOINT"]
        self._table = f"rt_contract_cache_{int(time.time() * 1000):x}_{secrets.token_hex(4)}"
        self._client = boto3.client("dynamodb", endpoint_url=endpoint, region_name="us-east-1")
        self._client.create_table(
            TableName=self._table,
            BillingMode="PAY_PER_REQUEST",
            AttributeDefinitions=[{"AttributeName": "pk", "AttributeType": "S"}, {"AttributeName": "sk", "AttributeType": "S"}],
            KeySchema=[{"AttributeName": "pk", "KeyType": "HASH"}, {"AttributeName": "sk", "KeyType": "RANGE"}],
        )
        self._adapter = DynamoCache(self._table, endpoint=endpoint, region="us-east-1", namespace=_namespace(init), clock=clock)
        super().__init__(Cache(self._adapter), clock)

    def row(self, pk: Any, sk: Any) -> Row | None:
        return self._adapter.store.get(pk, sk)

    def close(self) -> None:
        try:
            self._client.delete_table(TableName=self._table)
        finally:
            self._client.close()
            self._adapter.close()


SUBJECTS: dict[str, Any] = {
    "cache-memory": memory,
    "cache-nosql": NoSQLFacade,
    "cache-file": FileFacade,
}
if os.environ.get("RT_APP_TEST_DYNAMODB_ENDPOINT"):
    SUBJECTS["cache-dynamodb"] = DynamoFacade
