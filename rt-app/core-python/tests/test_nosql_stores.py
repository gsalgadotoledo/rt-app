"""PostgreSQL and DynamoDB stores. Skipped unless RT_APP_TEST_POSTGRES_URL / RT_APP_TEST_DYNAMODB_ENDPOINT
are set; run them with throwaway databases:

    node rt-app/spec/services.mjs --postgres --dynamodb -- sh rt-app/spec/hosts/python.sh -m unittest discover -s rt-app/core-python/tests
"""
import os
import secrets
import subprocess
import sys
import threading
import unittest

from rt_app import Conflict, HttpError
from rt_app.nosql import NoSQL, encode_cursor

POSTGRES_URL = os.environ.get("RT_APP_TEST_POSTGRES_URL")
DYNAMODB_ENDPOINT = os.environ.get("RT_APP_TEST_DYNAMODB_ENDPOINT")


def row(pk="P", sk="a", version=1, **data):
    return {"pk": pk, "sk": sk, "version": version, "data": data}


class StoreCases:
    """Behavior every database store shares with MemoryStore."""

    store: NoSQL

    def test_is_a_nosql_store(self):
        self.assertIsInstance(self.store, NoSQL)

    def test_create_read_with_ttl_and_json_values(self):
        self.assertIsNone(self.store.get("P", "a"))
        written = {**row(name="Añ😀", n=1.5, big=2**40, flag=True, none=None, tags=["x", {"y": 1}]), "ttl": 1788220800}
        self.store.transact([{"row": written, "expected": None}])
        self.assertEqual(self.store.get("P", "a"), written)

    def test_version_guards_are_atomic(self):
        self.store.transact([{"row": row(sk="taken"), "expected": None}])
        with self.assertRaises(Conflict):
            self.store.transact([{"row": row(sk="new"), "expected": None}, {"row": row(sk="taken"), "expected": None}])
        self.assertIsNone(self.store.get("P", "new"))
        with self.assertRaises(Conflict):
            self.store.transact([{"row": row(sk="taken", version=2), "expected": True}])  # True is not 1
        with self.assertRaises(Conflict):
            self.store.transact([{"row": row(sk="taken", version=3), "expected": 2}])
        self.store.transact([{"row": row(sk="taken", version=2, n=2), "expected": 1}])
        self.assertEqual(self.store.get("P", "taken"), row(sk="taken", version=2, n=2))
        with self.assertRaises(Conflict):
            self.store.transact([{"row": row(sk="taken", version=2), "expected": 1, "delete": True}])
        self.store.transact([{"row": row(sk="taken", version=2), "expected": 2, "delete": True}])
        self.assertIsNone(self.store.get("P", "taken"))

    def test_duplicate_keys_are_rejected_before_the_database(self):
        with self.assertRaises(ValueError) as caught:
            self.store.transact([{"row": row(), "expected": None}, {"row": row(), "expected": None}])
        self.assertNotIsInstance(caught.exception, HttpError)
        self.assertEqual(str(caught.exception), "Duplicate transaction key")
        self.store.transact([])

    def test_code_point_order_pages_and_cursors(self):
        for sk in ["😀", "�", "é", "z", "B"]:
            self.store.transact([{"row": row(sk=sk), "expected": None}])
        self.assertEqual([r["sk"] for r in self.store.list("P")["items"]], ["B", "z", "é", "�", "😀"])
        self.assertEqual(self.store.list("EMPTY"), {"items": []})
        self.store.transact([{"row": row(pk="Q", sk=f"k{i:02}"), "expected": None} for i in range(60)][:25])
        self.store.transact([{"row": row(pk="Q", sk=f"k{i:02}"), "expected": None} for i in range(60)][25:])
        first = self.store.list("Q")
        self.assertEqual(len(first["items"]), 50)
        self.assertEqual(first["cursor"], encode_cursor("Q", "k49"))
        self.assertEqual([r["sk"] for r in self.store.list("Q", first["cursor"])["items"]], [f"k{i}" for i in range(50, 60)])
        for pk, bad in (("Q", "not-a-cursor"), ("OTHER", first["cursor"])):
            with self.assertRaises(HttpError) as caught:
                self.store.list(pk, bad)
            self.assertEqual((caught.exception.status, caught.exception.message), (400, "Invalid cursor"))

    def test_concurrent_creates_have_one_winner(self):
        results: list[str] = []

        def create(n: int) -> None:
            try:
                self.store.transact([{"row": row(sk="race", n=n), "expected": None}])
                results.append("ok")
            except Conflict:
                results.append("conflict")

        threads = [threading.Thread(target=create, args=(n,)) for n in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(sorted(results), ["conflict", "conflict", "conflict", "ok"])


@unittest.skipUnless(POSTGRES_URL, "RT_APP_TEST_POSTGRES_URL is not set")
class PostgresStoreTests(StoreCases, unittest.TestCase):
    def setUp(self):
        from rt_app.nosql import PostgresStore

        self.store = PostgresStore(POSTGRES_URL, table=f"rt_test_{secrets.token_hex(4)}", max=4, ssl=False)
        self.addCleanup(self.store.close)
        self.addCleanup(self.store.drop_table)

    def test_table_names_are_validated(self):
        from rt_app.nosql.postgres import PostgresStore

        for name in ("Users", "a-b", "x; DROP TABLE t", "", "a" * 64):
            with self.assertRaises(ValueError):
                PostgresStore(POSTGRES_URL, table=name)


@unittest.skipUnless(DYNAMODB_ENDPOINT, "RT_APP_TEST_DYNAMODB_ENDPOINT is not set")
class DynamoStoreTests(StoreCases, unittest.TestCase):
    def setUp(self):
        import boto3

        from rt_app.nosql import DynamoStore

        table = f"rt_test_{secrets.token_hex(4)}"
        client = boto3.client("dynamodb", endpoint_url=DYNAMODB_ENDPOINT, region_name="us-east-1")
        client.create_table(
            TableName=table,
            BillingMode="PAY_PER_REQUEST",
            AttributeDefinitions=[{"AttributeName": "pk", "AttributeType": "S"}, {"AttributeName": "sk", "AttributeType": "S"}],
            KeySchema=[{"AttributeName": "pk", "KeyType": "HASH"}, {"AttributeName": "sk", "KeyType": "RANGE"}],
        )
        self.addCleanup(client.close)
        self.addCleanup(client.delete_table, TableName=table)
        self.store = DynamoStore(table, endpoint=DYNAMODB_ENDPOINT, region="us-east-1")
        self.addCleanup(self.store.close)

    def test_a_full_last_page_has_no_cursor(self):
        # Limit 51: the look-ahead row decides whether another page exists.
        self.store.transact([{"row": row(sk=f"k{i:02}"), "expected": None} for i in range(25)])
        self.store.transact([{"row": row(sk=f"k{i:02}"), "expected": None} for i in range(25, 50)])
        self.assertNotIn("cursor", self.store.list("P"))
        self.store.transact([{"row": row(sk="k50"), "expected": None}])
        page = self.store.list("P")
        self.assertEqual(page["cursor"], encode_cursor("P", "k49"))
        self.assertEqual([r["sk"] for r in self.store.list("P", page["cursor"])["items"]], ["k50"])


class OptionalDriversTests(unittest.TestCase):
    def test_rt_app_imports_without_loading_drivers(self):
        code = "import sys, rt_app, rt_app.nosql, rt_app.subscriptions; assert not {'psycopg', 'boto3'} & set(sys.modules), sorted(sys.modules)"
        subprocess.run([sys.executable, "-c", code], check=True, env={**os.environ, "PYTHONPATH": os.pathsep.join(sys.path)})


if __name__ == "__main__":
    unittest.main()
