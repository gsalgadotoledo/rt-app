import asyncio
import json
import unittest
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone

from rt_app import HttpError
from rt_app.conformance import decode, describe_error, encode, serve_contracts, snake_case


@dataclass
class Point:
    x: int
    label: str | None = None


class Counter:
    def __init__(self, start):
        self.value = start
        self.closed = []

    def add_one(self):
        self.value += 1
        return self.value

    async def slow_double(self, n):
        await asyncio.sleep(0)
        return n * 2

    def fail(self):
        raise HttpError(418, "Teapot")

    def _secret(self):
        return "hidden"

    def close(self):
        self.closed.append(True)


class ValueTests(unittest.TestCase):
    def test_encode(self):
        moment = datetime(2026, 1, 2, 3, 4, 5, 678000, tzinfo=timezone.utc)
        self.assertEqual(encode({"d": moment, "b": b"\x00\xff", "p": Point(1), "t": (1, None), "n": None}), {
            "d": {"$date": "2026-01-02T03:04:05.678Z"}, "b": {"$bytes": "AP8="},
            "p": {"x": 1, "label": None}, "t": [1, None], "n": None,
        })
        with self.assertRaises(ValueError):
            encode(float("inf"))

    def test_decode(self):
        self.assertEqual(decode({"$date": "2026-01-02T03:04:05.678Z"}), datetime(2026, 1, 2, 3, 4, 5, 678000, tzinfo=timezone.utc))
        self.assertEqual(decode([{"$bytes": "AP8="}, {"$bigint": "12345678901234567890"}]), [b"\x00\xff", 12345678901234567890])
        self.assertEqual(decode({"$date": "x", "other": 1}), {"$date": "x", "other": 1})

    def test_errors_and_names(self):
        self.assertEqual(describe_error(HttpError(409, "Conflict")), {"type": "HttpError", "status": 409, "message": "Conflict"})
        self.assertEqual(describe_error(ValueError("Duplicate transaction key")), {"type": "ValueError", "message": "Duplicate transaction key"})
        self.assertEqual([snake_case(n) for n in ["get", "addOne", "publicOnly", "getHTTPStatus"]], ["get", "add_one", "public_only", "get_http_status"])


class HostTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.created = []

        def factory(init):
            counter = Counter(init["start"])
            cls.created.append(counter)
            return counter

        cls.host = serve_contracts({"counter": factory})
        cls.url = cls.host.url

    @classmethod
    def tearDownClass(cls):
        cls.host.close()

    def request(self, method, path="", body=None, headers=None):
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(self.url + path, data=data, method=method, headers=headers or {})
        try:
            with urllib.request.urlopen(request) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            with error:
                return error.code, json.loads(error.read())

    def test_protocol(self):
        self.assertTrue(self.url.endswith("/rt-contract/v1"))
        status, info = self.request("GET")
        self.assertEqual((status, info["protocol"], info["language"], info["subjects"]), (200, 1, "python", ["counter"]))
        self.assertEqual(self.request("GET", headers={"Origin": "http://evil"})[0], 403)
        self.assertEqual(self.request("POST", "/instances", {"subject": "nope"})[0], 404)
        self.assertEqual(self.request("POST", "/instances", {"subject": "counter", "init": {}})[1]["ok"], False)

        status, created = self.request("POST", "/instances", {"subject": "counter", "init": {"start": 1}})
        instance = f"/instances/{created['id']}"
        self.assertEqual(self.request("POST", instance + "/addOne", {"args": []})[1], {"ok": True, "value": 2})
        self.assertEqual(self.request("POST", instance + "/slowDouble", {"args": [21]})[1], {"ok": True, "value": 42})
        self.assertEqual(self.request("POST", instance + "/fail", {})[1],
                         {"ok": False, "error": {"type": "HttpError", "status": 418, "message": "Teapot"}})
        for name in ["_secret", "missing", "__init__"]:
            self.assertEqual(self.request("POST", f"{instance}/{name}", {"args": []})[0], 404)
        self.assertEqual(self.request("POST", instance + "/addOne", {"args": 1})[0], 400)
        self.assertEqual(self.request("POST", "/instances/999/addOne", {"args": []})[0], 404)
        self.assertEqual(self.request("DELETE", instance), (200, {"ok": True}))
        self.assertEqual(self.created[-1].closed, [True])
        self.assertEqual(self.request("GET", "/elsewhere")[0], 404)


if __name__ == "__main__":
    unittest.main()
