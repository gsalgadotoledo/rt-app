import itertools
import unittest

from rt_app import HttpError
from rt_app.nosql import MemoryStore
from rt_app.visits import Visits
from rt_app.web import App, Request

SECRET = "visits-contract-secret-0123456789"
T0 = 1_893_456_000_000
ID = "00000000-0000-4000-8000-000000000001"
POINT = {"type": "click", "path": "/", "t": 5, "x": 20, "y": 30}
# Issued by the TypeScript reference (spec/contracts/visits.contract.yaml).
TS_TOKEN = ("eyJpZCI6IjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMSIsInN0YXJ0ZWRBdCI6MTg5MzQ1NjAwMDAwMH0."
            "PfLXHltgXNxsnYwLyX4alqkZ7PY2HR4GaG8zdsHjc-U")


class VisitsTests(unittest.TestCase):
    def setUp(self):
        self.now = [T0]
        self.ids = iter(f"00000000-0000-4000-8000-{i:012d}" for i in itertools.count(1))
        self.store = MemoryStore()
        self.visits = Visits(self.store, SECRET, now=lambda: self.now[0], new_id=lambda: next(self.ids))

    def assertHttpError(self, status, message, fn, *args):
        with self.assertRaises(HttpError) as caught:
            fn(*args)
        self.assertEqual((caught.exception.status, caught.exception.message), (status, message))

    def test_tokens_match_the_typescript_reference(self):
        self.assertEqual(self.visits.start("ip")["token"], TS_TOKEN)

    def test_ingest_list_detail_remove(self):
        token = self.visits.start("ip")["token"]
        self.now[0] += 1234
        self.assertEqual(self.visits.ingest({"token": token, "sequence": 1, "points": [{**POINT, "text": "secret"}, POINT]}, "ip"), {"ok": True, "recorded": True})
        self.assertEqual(self.visits.ingest({"token": token, "sequence": 1, "points": [POINT]}, "ip"), {"ok": True, "recorded": False})
        self.assertEqual(self.visits.list(), {"items": [{"id": ID, "startedAt": T0, "updatedAt": T0 + 1234, "sequence": 1, "events": 2, "pages": ["/"]}], "limit": 10, "maxPoints": 120})
        self.assertEqual(self.visits.detail(ID)["points"], [POINT, POINT])
        row = self.store.get("VISITS", "recent")
        self.assertEqual((row["version"], row["ttl"]), (2, 1_893_542_402))
        self.assertEqual(self.visits.remove(ID), {"ok": True})
        self.assertHttpError(404, "Visit not found", self.visits.detail, ID)

    def test_keeps_ten_newest_sessions_and_120_points(self):
        tokens = []
        for i in range(11):
            self.now[0] += 1
            tokens.append(self.visits.start(f"ip{i}")["token"])
            self.visits.ingest({"token": tokens[-1], "sequence": 1, "points": [POINT]}, f"ip{i}")
        self.assertEqual([item["startedAt"] for item in self.visits.list()["items"]], [T0 + i for i in range(11, 1, -1)])
        self.assertEqual(self.visits.ingest({"token": tokens[0], "sequence": 2, "points": [POINT]}, "x"), {"ok": True, "recorded": False})
        for sequence in range(2, 10):
            self.visits.ingest({"token": tokens[-1], "sequence": sequence, "points": [POINT] * 20}, "y")
        self.assertEqual(self.visits.list()["items"][0]["events"], 120)
        self.assertEqual(len(self.visits.detail("00000000-0000-4000-8000-000000000011")["points"]), 120)

    def test_validation(self):
        token = self.visits.start("ip")["token"]
        batch = {"token": token, "sequence": 1, "points": [POINT]}
        for bad in [{**batch, "sequence": 0}, {**batch, "sequence": True}, {**batch, "sequence": 1.5}, {**batch, "points": []}, {**batch, "points": [POINT] * 21}]:
            with self.subTest(batch=bad):
                self.assertHttpError(400, "Invalid visit batch", self.visits.ingest, bad, "ip")
        for point in [None, {**POINT, "type": "hover"}, {**POINT, "path": "/x"}, {**POINT, "x": 101}, {**POINT, "x": 1.5}, {**POINT, "y": True}, {**POINT, "t": 1_800_001}]:
            with self.subTest(point=point):
                self.assertHttpError(400, "Invalid visit point", self.visits.ingest, {**batch, "points": [point]}, "ip")
        for bad in [None, "x", token + "x", token + ".x", "a" * 501]:
            with self.subTest(token=bad):
                self.assertHttpError(400, "Invalid visit token", self.visits.ingest, {**batch, "token": bad}, "ip")
        self.now[0] += 1_800_001
        self.assertHttpError(400, "Expired or invalid visit token", self.visits.ingest, batch, "ip2")
        self.assertIsNone(self.store.get("VISITS", "recent"))

    def test_sessions_expire_after_a_day(self):
        token = self.visits.start("ip")["token"]
        self.visits.ingest({"token": token, "sequence": 1, "points": [POINT]}, "ip")
        self.now[0] += 86_400_000
        self.assertEqual(self.visits.list()["items"], [])
        self.assertEqual(self.store.get("VISITS", "recent")["data"], {"sessions": []})

    def test_rate_limits(self):
        for _ in range(60):
            self.visits.start("a")
        self.assertHttpError(429, "Visit rate limit", self.visits.start, "a")
        self.visits.start("b")
        self.now[0] += 60_000
        self.visits.start("a")
        for i in range(1999):  # plus "a": 2000 tracked clients
            self.visits.start(f"c{i}")
        self.assertHttpError(429, "Visits busy", self.visits.start, "new")

    def test_configuration(self):
        with self.assertRaisesRegex(ValueError, "at least 32 characters"):
            Visits(MemoryStore(), "s" * 31)
        Visits(MemoryStore(), "🔑" * 16)  # 32 UTF-16 code units
        for pages in [["about"], ["/a\n"], ["/café"], ["/" * 81], [f"/p{i}" for i in range(31)]]:
            with self.subTest(pages=pages), self.assertRaisesRegex(ValueError, "Invalid public visit pages"):
                Visits(MemoryStore(), SECRET, pages)

    def test_endpoints(self):
        app = App([self.visits.feature()], local_admin=True)
        started = app.handle(Request("POST", "/visits/start", ip="127.0.0.1"))
        self.assertEqual(started.body["pages"], ["/", "/about", "/services"])
        body = {"token": started.body["token"], "sequence": 1, "points": [POINT]}
        self.assertEqual(app.handle(Request("POST", "/visits/events", body=body, ip="127.0.0.1")).body, {"ok": True, "recorded": True})
        self.assertEqual(app.handle(Request("GET", "/visits")).status, 404)
        self.assertEqual(app.handle(Request("GET", f"/admin/app/visits/{ID}")).body["id"], ID)
        self.assertEqual(app.handle(Request("DELETE", f"/admin/app/visits/{ID}")).body, {"ok": True})
        self.assertEqual(app.handle(Request("GET", "/admin/app/visits")).body["items"], [])


if __name__ == "__main__":
    unittest.main()
