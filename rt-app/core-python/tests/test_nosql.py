import base64
import json
import unittest

from rt_app import Conflict, HttpError
from rt_app.nosql import MemoryStore, NoSQL, encode_cursor


def row(pk="P", sk="a", version=1, **data):
    return {"pk": pk, "sk": sk, "version": version, "data": data}


class MemoryStoreTests(unittest.TestCase):
    def setUp(self):
        self.store = MemoryStore()

    def test_is_a_nosql_store(self):
        self.assertIsInstance(self.store, NoSQL)

    def test_create_read_and_copies(self):
        self.assertIsNone(self.store.get("P", "a"))
        written = row(tags=["x"])
        self.store.transact([{"row": written, "expected": None}])
        written["data"]["tags"].append("mutated")
        read = self.store.get("P", "a")
        self.assertEqual(read, row(tags=["x"]))
        read["data"]["tags"].append("mutated")
        self.assertEqual(self.store.get("P", "a"), row(tags=["x"]))

    def test_version_guard_and_atomicity(self):
        self.store.transact([{"row": row(sk="taken"), "expected": None}])
        with self.assertRaises(Conflict) as caught:
            self.store.transact([{"row": row(sk="new"), "expected": None}, {"row": row(sk="taken"), "expected": None}])
        self.assertEqual((caught.exception.status, caught.exception.message), (409, "Conflict: refresh and try again"))
        self.assertIsNone(self.store.get("P", "new"))
        with self.assertRaises(Conflict):
            self.store.transact([{"row": row(sk="taken", version=2), "expected": True}])  # True is not 1
        self.store.transact([{"row": row(sk="taken", version=2), "expected": 1}])
        self.assertEqual(self.store.get("P", "taken")["version"], 2)

    def test_duplicate_key_is_a_plain_error(self):
        with self.assertRaises(Exception) as caught:
            self.store.transact([{"row": row(), "expected": None}, {"row": row(), "expected": None}])
        self.assertNotIsInstance(caught.exception, HttpError)
        self.assertEqual(str(caught.exception), "Duplicate transaction key")

    def test_delete_needs_the_version(self):
        self.store.transact([{"row": row(version=4), "expected": None}])
        with self.assertRaises(Conflict):
            self.store.transact([{"row": row(version=4), "expected": 3, "delete": True}])
        self.store.transact([{"row": row(version=4), "expected": 4, "delete": True}])
        self.assertIsNone(self.store.get("P", "a"))

    def test_code_point_order_and_pages(self):
        for sk in ["😀", "�", "é", "z"]:
            self.store.transact([{"row": row(sk=sk), "expected": None}])
        self.assertEqual([r["sk"] for r in self.store.list("P")["items"]], ["z", "é", "�", "😀"])
        self.assertEqual(self.store.list("EMPTY"), {"items": []})

    def test_cursor_format_and_partition_binding(self):
        self.store.transact([{"row": row(sk=f"k{i:02}"), "expected": None} for i in range(51)])
        first = self.store.list("P")
        self.assertEqual(len(first["items"]), 50)
        cursor = first["cursor"]
        self.assertNotIn("=", cursor)
        self.assertEqual(json.loads(base64.urlsafe_b64decode(cursor + "==")), {"pk": "P", "sk": "k49"})
        self.assertEqual(cursor, encode_cursor("P", "k49"))
        self.assertEqual(encode_cursor("P", "é"), "eyJwayI6IlAiLCJzayI6IsOpIn0")  # Node: Buffer.from('{"pk":"P","sk":"é"}').toString("base64url")
        self.assertEqual([r["sk"] for r in self.store.list("P", cursor)["items"]], ["k50"])
        for bad in ["not-a-cursor", encode_cursor("OTHER", "k49"), base64.urlsafe_b64encode(b"null").decode()]:
            with self.assertRaises(HttpError) as caught:
                self.store.list("P", bad)
            self.assertEqual((caught.exception.status, caught.exception.message), (400, "Invalid cursor"))


if __name__ == "__main__":
    unittest.main()
