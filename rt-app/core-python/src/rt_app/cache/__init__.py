"""TTL cache-aside with stable content keys (port of ``@gsalgadotoledo/rt-app-cache``).

Compose it in ``app.py`` like any component::

    cache = Singleton(lambda: Cache(MemoryCache()))            # process-local LRU
    cache = Singleton(lambda: Cache(NoSQLCache(store.get())))  # shared through a NoSQL store
    cache = Singleton(lambda: Cache(FileCache(".rt-app/cache.json")))

    products = cache.get().remember("tenant-1:products", {"page": 1}, 60_000, load_products)

Rules shared with TypeScript (see ``rt-app/docs/polyglot/cache.md``):

- Values are JSON (``None``, bool, numbers, str, lists, dicts with str keys), at most 64000 UTF-8
  bytes of canonical JSON. Keys are non-empty and at most 240 UTF-16 units; TTLs are whole
  milliseconds from 1 ms to 30 days. Errors are ``TypeError`` with the TypeScript messages.
- ``get`` returns :data:`MISS` on a miss: a cached ``None`` is a hit.
- An entry expires when ``expires <= now``; clocks are epoch milliseconds (injectable).
- ``remember`` loads once per key at a time in this process (threads share the in-flight load)
  and never caches a failed load.
"""
from __future__ import annotations

import copy
import threading
from collections import OrderedDict
from collections.abc import Callable
from typing import Any, Final, Protocol, TypeAlias, runtime_checkable

from .. import _canonical, _js
from ..contracts import Clock, epoch_ms

CacheValue: TypeAlias = Any
"""A JSON value: None, bool, int, float, str, list or dict with str keys."""

MAX_VALUE_BYTES: Final = 64000
MAX_KEY_LENGTH: Final = 240
MAX_TTL_MS: Final = 30 * 86400000

VALUE_MESSAGE: Final = "Cache requires finite, acyclic JSON values"
OBJECT_MESSAGE: Final = "Cache accepts plain objects only"
NAMESPACE_MESSAGE: Final = "Invalid cache namespace"
ENTRY_MESSAGE: Final = "Cache needs a key and TTL between 1 ms and 30 days"
SIZE_MESSAGE: Final = "Cache values are limited to 64 KB"
CAPACITY_MESSAGE: Final = "Invalid cache capacity"

_NAMESPACE_CHARS: Final = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:._-")


class _Miss:
    """A cache miss (JavaScript ``undefined``), unlike a cached ``None``."""

    _instance: _Miss | None = None

    def __new__(cls) -> _Miss:
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __repr__(self) -> str:
        return "MISS"

    def __bool__(self) -> bool:
        return False


#: Returned by ``get`` when there is no live entry.
MISS: Final = _Miss()


@runtime_checkable
class CacheAdapter(Protocol):
    """Storage for :class:`Cache`: MemoryCache, NoSQLCache, FileCache or DynamoCache."""

    def get(self, key: str) -> CacheValue | _Miss: ...

    def set(self, key: str, value: CacheValue, ttl_ms: int) -> None: ...

    def delete(self, key: str) -> None: ...


def _fail(kind: str) -> TypeError:
    return TypeError(OBJECT_MESSAGE if kind == "object" else VALUE_MESSAGE)


def canonical(value: Any) -> str:
    """Canonical JSON (sorted keys, JavaScript numbers); TypeError for non-JSON values."""
    return _canonical.canonical(value, _fail)


def content_key(namespace: str, input: CacheValue) -> str:
    """Stable scoped hash: ``content_key("tenant-1:products", {"page": 1})`` → ``"tenant-1:products:<sha256>"``."""
    if (
        not isinstance(namespace, str)
        or not 1 <= len(namespace) <= 100
        or not all(ch in _NAMESPACE_CHARS for ch in namespace)
    ):
        raise TypeError(NAMESPACE_MESSAGE)
    return namespace + ":" + _canonical.sha256_hex(canonical(input))


def validate_entry(key: str, ttl_ms: int) -> None:
    """Reject empty/oversized keys (UTF-16 units) and TTLs outside 1 ms–30 days."""
    if (
        not isinstance(key, str)
        or not key
        or _js.utf16_length(key) > MAX_KEY_LENGTH
        or not _js.is_safe_integer(ttl_ms)
        or not 1 <= ttl_ms <= MAX_TTL_MS
    ):
        raise TypeError(ENTRY_MESSAGE)


def checked_json(value: CacheValue) -> str:
    """Canonical JSON of a value that fits the 64000-byte limit."""
    text = canonical(value)
    if len(_canonical.utf8(text)) > MAX_VALUE_BYTES:
        raise TypeError(SIZE_MESSAGE)
    return text


class MemoryCache:
    """Bounded process-local LRU. Values are copied in and out; thread-safe."""

    def __init__(self, max_entries: int = 1000, clock: Clock | None = None) -> None:
        if not _js.is_safe_integer(max_entries) or max_entries < 1:
            raise TypeError(CAPACITY_MESSAGE)
        self._max = int(max_entries)
        self._clock = clock
        self._entries: OrderedDict[str, tuple[CacheValue, float]] = OrderedDict()
        self._lock = threading.Lock()

    def _now(self) -> float:
        return epoch_ms(self._clock)

    def get(self, key: str) -> CacheValue | _Miss:
        """A copy of the live value (refreshing its LRU position), or MISS; expired entries are dropped."""
        with self._lock:
            entry = self._entries.pop(key, None)
            if entry is None:
                return MISS
            if entry[1] <= self._now():
                return MISS
            self._entries[key] = entry
            return copy.deepcopy(entry[0])

    def set(self, key: str, value: CacheValue, ttl_ms: int) -> None:
        """Store a copy; drop expired entries, then evict the least recently used beyond capacity."""
        validate_entry(key, ttl_ms)
        checked_json(value)
        stored = copy.deepcopy(value)
        with self._lock:
            now = self._now()
            for id_ in [id_ for id_, (_, expires) in self._entries.items() if expires <= now]:
                del self._entries[id_]
            self._entries.pop(key, None)
            self._entries[key] = (stored, self._now() + ttl_ms)
            while len(self._entries) > self._max:
                self._entries.popitem(last=False)

    def delete(self, key: str) -> None:
        """Remove a key; deleting an absent key succeeds."""
        with self._lock:
            self._entries.pop(key, None)


class _Flight:
    """One in-flight load shared by the threads that asked for the same key."""

    def __init__(self) -> None:
        self.done = threading.Event()
        self.value: CacheValue = None
        self.error: BaseException | None = None

    def result(self) -> CacheValue:
        self.done.wait()
        if self.error is not None:
            raise self.error
        return self.value


class Cache:
    """Cache-aside over an adapter, with concurrent loader deduplication in this process only."""

    def __init__(self, adapter: CacheAdapter | None = None) -> None:
        self.adapter: CacheAdapter = adapter if adapter is not None else MemoryCache()
        self._pending: dict[str, _Flight] = {}
        self._lock = threading.Lock()

    def get(self, key: str) -> CacheValue | _Miss:
        """Read through the adapter; MISS means no entry, None is a cached value."""
        return self.adapter.get(key)

    def set(self, key: str, value: CacheValue, ttl_ms: int) -> None:
        """Write a JSON value with an explicit TTL in milliseconds."""
        self.adapter.set(key, value, ttl_ms)

    def delete(self, key: str) -> None:
        """Invalidate through the adapter; provider errors propagate."""
        self.adapter.delete(key)

    def remember(self, namespace: str, input: CacheValue, ttl_ms: int, load: Callable[[], CacheValue]) -> CacheValue:
        """Load only on a miss, share in-flight work, and never keep failed loads.

        ``cache.remember("user:42", {"page": 1}, 1000, lambda: ["item"])`` → ``["item"]``
        """
        key = content_key(namespace, input)
        validate_entry(key, ttl_ms)
        hit = self.adapter.get(key)
        if hit is not MISS:
            return hit
        with self._lock:
            flight = self._pending.get(key)
            leader = flight is None
            if flight is None:
                flight = self._pending[key] = _Flight()
        if not leader:
            return copy.deepcopy(flight.result())
        try:
            value = load()
            self.adapter.set(key, value, ttl_ms)
            flight.value = value
        except BaseException as error:
            flight.error = error
            raise
        finally:
            with self._lock:
                if self._pending.get(key) is flight:
                    del self._pending[key]
            flight.done.set()
        return copy.deepcopy(value)


def __getattr__(name: str) -> Any:
    """Lazy adapters: NoSQLCache, FileCache and DynamoCache load on first use."""
    if name == "NoSQLCache":
        from .nosql import NoSQLCache

        return NoSQLCache
    if name == "FileCache":
        from .file import FileCache

        return FileCache
    if name == "DynamoCache":
        from .dynamodb import DynamoCache

        return DynamoCache
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = [
    "CacheValue",
    "CacheAdapter",
    "MISS",
    "Cache",
    "MemoryCache",
    "NoSQLCache",
    "FileCache",
    "DynamoCache",
    "canonical",
    "content_key",
    "validate_entry",
    "checked_json",
    "MAX_VALUE_BYTES",
    "MAX_TTL_MS",
]
