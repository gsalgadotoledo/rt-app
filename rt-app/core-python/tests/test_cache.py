"""Cache port: canonical keys, MemoryCache LRU/TTL, remember, NoSQLCache and FileCache."""
from __future__ import annotations

import json
import tempfile
import threading
import time
import unittest
from pathlib import Path

from rt_app.cache import MISS, Cache, MemoryCache, canonical, content_key, validate_entry
from rt_app.cache.file import FileCache, JsonFileStore
from rt_app.cache.nosql import NoSQLCache
from rt_app.errors import Conflict
from rt_app.nosql import MemoryStore

NOW = 4102444800000


class Clock:
    def __init__(self, ms: int = NOW) -> None:
        self.ms = ms

    def __call__(self) -> int:
        return self.ms


class CanonicalTest(unittest.TestCase):
    def test_matches_json_stringify(self) -> None:
        self.assertEqual(canonical([None, False, 12, {"z": 1, "a": "x"}]), '[null,false,12,{"a":"x","z":1}]')
        self.assertEqual(canonical({"！": 1, "😀": 2, "a": 3}), '{"a":3,"😀":2,"！":1}')  # UTF-16 order
        self.assertEqual(canonical("\u2028\x7f\n\x01<"), '"\u2028\x7f\\n\\u0001<"')
        self.assertEqual(canonical("\ud800"), '"\\ud800"')
        self.assertEqual(
            canonical([1e21, 1e-7, -0.0, 12345678901234567890, 1.0, 2**53 + 1]),
            "[1e+21,1e-7,0,12345678901234567000,1,9007199254740992]",
        )

    def test_rejects_non_json(self) -> None:
        cyclic: dict = {}
        cyclic["self"] = cyclic
        for value, message in (
            (float("nan"), "Cache requires finite, acyclic JSON values"),
            (float("inf"), "Cache requires finite, acyclic JSON values"),
            (10**400, "Cache requires finite, acyclic JSON values"),
            (cyclic, "Cache requires finite, acyclic JSON values"),
            ({1: "x"}, "Cache accepts plain objects only"),
            ({1, 2}, "Cache accepts plain objects only"),
            (object(), "Cache accepts plain objects only"),
        ):
            with self.assertRaises(TypeError) as caught:
                canonical(value)
            self.assertEqual(str(caught.exception), message)
        shared = [1]
        self.assertEqual(canonical([shared, shared]), "[[1],[1]]")  # repeated, not cyclic

    def test_content_key_and_validation(self) -> None:
        self.assertEqual(
            content_key("tenant-1:products", {"page": 1}),
            "tenant-1:products:70fb0185588d2e765454a7927f2792ae2b6faa2516781deb69864246e0803d05",
        )
        for namespace in ("", "a b", "a\n", "é", "n" * 101):
            with self.assertRaisesRegex(TypeError, "Invalid cache namespace"):
                content_key(namespace, 1)
        validate_entry("k" * 240, 2592000000)
        validate_entry("😀" * 120, 1)
        for key, ttl in (("", 1), ("😀" * 121, 1), ("k", 0), ("k", 1.5), ("k", True), ("k", 2592000001)):
            with self.assertRaisesRegex(TypeError, "Cache needs a key"):
                validate_entry(key, ttl)


class MemoryCacheTest(unittest.TestCase):
    def test_lru_expiry_and_copies(self) -> None:
        clock = Clock()
        cache = MemoryCache(2, clock)
        cache.set("a", {"v": 1}, 10)
        cache.set("b", None, 10)
        self.assertIsNone(cache.get("b"))
        copy = cache.get("a")
        copy["v"] = 5
        self.assertEqual(cache.get("a"), {"v": 1})
        cache.set("c", False, 10)
        self.assertIs(cache.get("b"), MISS)  # a was refreshed by the reads
        clock.ms += 10
        self.assertIs(cache.get("a"), MISS)
        clock.ms -= 5
        self.assertIs(cache.get("a"), MISS)  # expired reads delete
        for capacity in (0, -1, 1.5, "2", True):
            with self.assertRaisesRegex(TypeError, "Invalid cache capacity"):
                MemoryCache(capacity)  # type: ignore[arg-type]

    def test_size_limit_counts_utf8_bytes(self) -> None:
        cache = MemoryCache()
        cache.set("k", "é" * 31999, 10)
        with self.assertRaisesRegex(TypeError, "64 KB"):
            cache.set("k", "é" * 32000, 10)
        self.assertEqual(len(cache.get("k")), 31999)


class RememberTest(unittest.TestCase):
    def test_hits_failures_and_null(self) -> None:
        cache = Cache(MemoryCache(clock=Clock()))
        calls = []

        def load(value):
            def run():
                calls.append(value)
                return value

            return run

        self.assertEqual(cache.remember("ns", {"a": 1}, 100, load([1])), [1])
        self.assertEqual(cache.remember("ns", {"a": 1}, 100, load([2])), [1])
        self.assertIsNone(cache.remember("ns", 2, 100, load(None)))
        self.assertIsNone(cache.remember("ns", 2, 100, load("x")))

        def fail():
            raise RuntimeError("load failed")

        with self.assertRaisesRegex(RuntimeError, "load failed"):
            cache.remember("ns", 3, 100, fail)
        self.assertEqual(cache.remember("ns", 3, 100, load(7)), 7)
        self.assertEqual(calls, [[1], None, 7])

    def test_concurrent_callers_share_one_load(self) -> None:
        cache = Cache()
        calls = 0
        lock = threading.Lock()

        def slow():
            nonlocal calls
            with lock:
                calls += 1
            time.sleep(0.05)
            return {"a": 1}

        results: list = []
        threads = [threading.Thread(target=lambda: results.append(cache.remember("ns", 1, 1000, slow))) for _ in range(5)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(calls, 1)
        self.assertEqual(results, [{"a": 1}] * 5)
        results[0]["a"] = 2
        self.assertEqual(results[1], {"a": 1})


class FlakyStore(MemoryStore):
    def __init__(self, conflicts: int) -> None:
        super().__init__()
        self.conflicts = conflicts
        self.attempts = 0

    def transact(self, writes):  # type: ignore[no-untyped-def]
        self.attempts += 1
        if self.conflicts:
            self.conflicts -= 1
            raise Conflict()
        super().transact(writes)


class NoSQLCacheTest(unittest.TestCase):
    def test_row_format_and_logical_ttl(self) -> None:
        store, clock = MemoryStore(), Clock()
        cache = NoSQLCache(store, "t", clock)
        cache.set("k", {"b": 1, "a": 2}, 1500)
        row = store.get("CACHE#t", "8254c329a92850f6d539dd376f4816ee2764517da5e0235514af433164480d7a")
        self.assertEqual(row, {"pk": "CACHE#t", "sk": row["sk"], "version": 1, "data": {"value": {"a": 2, "b": 1}, "expires": NOW + 1500}, "ttl": 4102444802})
        clock.ms += 1500
        self.assertIs(cache.get("k"), MISS)
        clock.ms -= 1
        self.assertEqual(cache.get("k"), {"a": 2, "b": 1})  # reads never delete
        cache.delete("k")
        self.assertIs(cache.get("k"), MISS)

    def test_conflicts_are_retried_four_times(self) -> None:
        store = FlakyStore(3)
        NoSQLCache(store).set("k", 1, 100)
        self.assertEqual(store.attempts, 4)
        store = FlakyStore(4)
        with self.assertRaises(Conflict):
            NoSQLCache(store).set("k", 1, 100)
        self.assertEqual(store.attempts, 4)
        NoSQLCache(store).delete("missing")
        self.assertEqual(store.attempts, 4)


class FileCacheTest(unittest.TestCase):
    def test_file_is_shared_and_expired_rows_are_dropped(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "nested" / "cache.json"
            clock = Clock()
            FileCache(path, clock=clock).set("k", False, 60000)
            self.assertIs(FileCache(path, clock=clock).get("k"), False)
            document = json.loads(path.read_text())
            self.assertEqual(document["format"], 1)
            self.assertEqual(document["rows"][0]["data"], {"value": False, "expires": NOW + 60000})
            clock.ms = 1000  # ttl 2 s (1970) has passed in real time: dropped on write
            FileCache(path, clock=clock).set("old", 1, 1000)
            self.assertEqual(len(json.loads(path.read_text())["rows"]), 1)
            self.assertFalse(Path(str(path) + ".lock").exists())

    def test_invalid_files_and_locks(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "cache.json"
            path.write_text('{"format":2,"rows":[]}')
            with self.assertRaisesRegex(RuntimeError, "Invalid JSON database"):
                JsonFileStore(path).get("a", "b")
            path.write_text('{"format":1,"rows":[]}')
            Path(str(path) + ".lock").write_text("")
            with self.assertRaisesRegex(RuntimeError, "JSON store locked"):
                JsonFileStore(path, lock_timeout_ms=50).get("a", "b")


if __name__ == "__main__":
    unittest.main()
