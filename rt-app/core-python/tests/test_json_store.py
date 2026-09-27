"""JsonStore (rt_app.nosql.json): file format shared with TypeScript, locking, retention, auth key."""
from __future__ import annotations

import math
import os
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

from rt_app.errors import Conflict, HttpError
from rt_app.nosql.json import JsonStore, JsonStoreError, js_number, local_secret, parse, stringify


def row(sk: str, version: int = 1, **data: object) -> dict:
    return {"pk": "p", "sk": sk, "version": version, "data": dict(data)}


class Fixture(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.TemporaryDirectory()
        self.path = Path(self.dir.name) / "db.json"

    def tearDown(self) -> None:
        self.dir.cleanup()


class JavaScriptJsonTest(unittest.TestCase):
    def test_stringify_matches_json_stringify(self) -> None:
        self.assertEqual(stringify({"b": 1.0, "2": "x", "a": [1e21, -0.0, 1e-7, 0.1], "10": None}), '{"2":"x","10":null,"b":1,"a":[1e+21,0,1e-7,0.1]}')
        self.assertEqual(stringify("\u2028<>&\x7f\x01\n\"\\"), '"\u2028<>&\x7f\\u0001\\n\\"\\\\"')
        self.assertEqual(stringify(12345678901234567890), "12345678901234567000")
        self.assertEqual(stringify(math.inf), "null")
        self.assertEqual(stringify({"4294967295": 1, "4294967294": 2, "01": 3}), '{"4294967294":2,"4294967295":1,"01":3}')

    def test_parse_keeps_first_position_and_last_value(self) -> None:
        self.assertEqual(stringify(parse('{"a":1,"b":2,"a":3}')), '{"a":3,"b":2}')
        with self.assertRaises(ValueError):
            parse("NaN")

    def test_js_number(self) -> None:
        cases = {"100": 100, " 7 ": 7, "0x10": 16, "0b11": 3, "0o7": 7, "": 0, "1e3": 1000, ".5": 0.5, "5.": 5, True: 1, None: 0}
        for value, expected in cases.items():
            self.assertEqual(js_number(value), expected, value)
        for value in ("soon", "1_0", "inf", "-0x1", "0x", "1e", {}):
            self.assertTrue(math.isnan(js_number(value)), value)
        self.assertEqual(js_number("-Infinity"), -math.inf)


class JsonStoreTest(Fixture):
    def test_file_format_and_row_order(self) -> None:
        store = JsonStore(self.path)
        store.transact([{"row": row("b", name="B"), "expected": None}, {"row": row("a"), "expected": None}])
        store.transact([{"row": row("b", 2, name="B2"), "expected": 1}, {"row": row("c"), "expected": None}])
        self.assertEqual(
            self.path.read_text("utf-8"),
            '{"format":1,"rows":[{"pk":"p","sk":"b","version":2,"data":{"name":"B2"}},{"pk":"p","sk":"a","version":1,"data":{}},{"pk":"p","sk":"c","version":1,"data":{}}]}',
        )
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
        self.assertEqual(sorted(os.listdir(self.dir.name)), ["db.json"])

    def test_reads_a_typescript_file_and_keeps_unknown_fields(self) -> None:
        self.path.write_text('{"note":1,"rows":[{"data":{"x":1.0},"version":1,"sk":"a","pk":"p","extra":true}],"format":1}', "utf-8")
        store = JsonStore(self.path)
        self.assertEqual(store.get("p", "a"), {"data": {"x": 1.0}, "version": 1, "sk": "a", "pk": "p", "extra": True})
        store.transact([{"row": row("b"), "expected": None}])
        self.assertEqual(self.path.read_text("utf-8"), '{"format":1,"rows":[{"data":{"x":1},"version":1,"sk":"a","pk":"p","extra":true},{"pk":"p","sk":"b","version":1,"data":{}}]}')

    def test_guards_are_atomic_and_leave_the_file_untouched(self) -> None:
        store = JsonStore(self.path)
        store.transact([{"row": row("a"), "expected": None}])
        before = self.path.read_bytes()
        with self.assertRaises(Conflict):
            store.transact([{"row": row("b"), "expected": None}, {"row": row("a", 2), "expected": 5}])
        with self.assertRaisesRegex(JsonStoreError, "^Invalid JSON row$"):
            store.transact([{"row": {"pk": "p", "sk": "x", "version": 1.5, "data": {}}, "expected": None}])
        with self.assertRaisesRegex(JsonStoreError, "^Duplicate transaction key$"):
            store.transact([{"row": row("x"), "expected": None}, {"row": row("x"), "expected": None}])
        self.assertEqual(self.path.read_bytes(), before)
        self.assertIsNone(store.get("p", "b"))

    def test_invalid_files_fail_closed(self) -> None:
        for text, message in (
            ("broken", "Invalid JSON database"),
            ('{"format":true,"rows":[]}', "Invalid JSON database"),
            ('{"format":1,"rows":[{"pk":"a","sk":"b","version":9007199254740992,"data":{}}]}', "Invalid JSON database"),
            ('{"format":1,"rows":[{"pk":"a","sk":"b","version":1,"data":{}},{"pk":"a","sk":"b","version":1,"data":{}}]}', "Duplicate JSON database key"),
        ):
            self.path.write_text(text, "utf-8")
            with self.assertRaisesRegex(JsonStoreError, f"^{message}$"):
                JsonStore(self.path).transact([])
            self.assertEqual(self.path.read_text("utf-8"), text)
            self.assertFalse(Path(str(self.path) + ".lock").exists())

    def test_stale_locks_time_out(self) -> None:
        Path(str(self.path) + ".lock").write_bytes(b"")
        with self.assertRaisesRegex(JsonStoreError, r"^JSON store locked: .*db\.json\.lock\. Stop writers before removing a stale lock\.$"):
            JsonStore(self.path, 30).get("p", "a")
        self.assertTrue(Path(str(self.path) + ".lock").exists())

    def test_list_pages_in_code_point_order(self) -> None:
        store = JsonStore(self.path)
        store.transact([{"row": row(sk), "expected": None} for sk in ["😀", "�", "é", "z"]])
        self.assertEqual([r["sk"] for r in store.list("p")["items"]], ["z", "é", "�", "😀"])
        store.transact([{"row": row(f"k{i:02}"), "expected": None} for i in range(51)])
        first = store.list("p")
        self.assertEqual(first["cursor"], "eyJwayI6InAiLCJzayI6Ims0OSJ9")
        self.assertEqual(len(store.list("p", first["cursor"])["items"]), 5)
        with self.assertRaises(HttpError):
            store.list("other", first["cursor"])

    def test_retention_uses_the_clock_on_writes_only(self) -> None:
        now = [10_000]
        store = JsonStore(self.path, now=lambda: now[0])
        store.transact([
            {"row": {"pk": "CACHE#a", "sk": "x", "version": 1, "data": {}, "ttl": 10}, "expected": None},
            {"row": {"pk": "CACHE#a", "sk": "y", "version": 1, "data": {}, "ttl": 11}, "expected": None},
            {"row": {"pk": "USERS", "sk": "u", "version": 1, "data": {}, "ttl": 1}, "expected": None},
        ])
        self.assertEqual([r["sk"] for r in store.list("CACHE#a")["items"]], ["y"])
        now[0] = 11_000
        self.assertIsNotNone(store.get("CACHE#a", "y"))
        store.transact([])
        self.assertIsNone(store.get("CACHE#a", "y"))
        self.assertIsNotNone(store.get("USERS", "u"))

    def test_concurrent_threads_and_processes_create_a_row_once(self) -> None:
        results: list[str] = []

        def claim() -> None:
            try:
                JsonStore(self.path).transact([{"row": row("once"), "expected": None}])
                results.append("ok")
            except Conflict:
                results.append("conflict")

        threads = [threading.Thread(target=claim) for _ in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(sorted(results), ["conflict", "conflict", "conflict", "ok"])
        code = (
            "import sys\nfrom rt_app.errors import Conflict\nfrom rt_app.nosql.json import JsonStore\n"
            "try:\n JsonStore(sys.argv[1]).transact([{'row':{'pk':'p','sk':'proc','version':1,'data':{}},'expected':None}])\n"
            "except Conflict:\n sys.exit(2)\n"
        )
        env = {**os.environ, "PYTHONPATH": os.pathsep.join(sys.path)}
        processes = [subprocess.Popen([sys.executable, "-c", code, str(self.path)], env=env) for _ in range(2)]
        self.assertEqual(sorted(p.wait() for p in processes), [0, 2])


class LocalSecretTest(Fixture):
    def test_created_once_private_and_validated(self) -> None:
        database = Path(self.dir.name) / "nested" / "local.json"
        first = local_secret(database)
        self.assertRegex(first, r"^[a-f0-9]{96}$")
        self.assertEqual(local_secret(database), first)
        key = Path(str(database) + ".key")
        self.assertEqual(stat.S_IMODE(key.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(key.parent.stat().st_mode), 0o700)
        self.assertFalse(database.exists())
        for broken in ("broken", first + "\n", first.upper(), ""):
            key.write_text(broken, "utf-8")
            with self.assertRaisesRegex(JsonStoreError, "^Invalid local auth key; restore it with the matching database$"):
                local_secret(database)


if __name__ == "__main__":
    unittest.main()
