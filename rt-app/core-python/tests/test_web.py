import base64
import contextlib
import io
import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

from rt_app import HttpError
from rt_app.feature_flags import FeatureFlags
from rt_app.health import Health
from rt_app.nosql import MemoryStore
from rt_app.web import App, Endpoint, Feature, Request, handler_for
from rt_app.web.__main__ import api_gateway_v2_event, main
from rt_app.web.server import app_handler, make_server

FLAG = {"version": None, "description": "", "enabled": True, "public": True, "rollout": 100, "subjects": []}


def boom(_):
    raise RuntimeError("secret detail")


def make_app(**options):
    extra = Feature(
        id="extra",
        endpoints=[
            Endpoint("GET", "/items/:id", "items.read", "guest", lambda c: {"id": c.params["id"]}),
            Endpoint("GET", "/items/new", "items.read", "guest", lambda c: {"literal": True}),
            Endpoint("GET", "/me", "me", "authenticated", lambda c: c.actor),
            Endpoint("GET", "/boom", "boom", "guest", boom),
            Endpoint("GET", "/teapot", "tea", "guest", lambda c: (_ for _ in ()).throw(HttpError(418, "Teapot"))),
            Endpoint("GET", "/reports", "reports.read", "permission", lambda c: ["r"]),
        ],
    )
    return App([Health().feature(), FeatureFlags(MemoryStore()).feature(), extra], **options)


class DispatchTests(unittest.TestCase):
    def call(self, app, method, path, body=None, headers=None):
        return app.handle(Request(method=method, path=path, body=body or {}, headers=headers or {}))

    def test_routing(self):
        app = make_app(local_admin=True)
        self.assertEqual(self.call(app, "GET", "/health/live").body, {"ok": True})
        self.assertEqual(self.call(app, "GET", "/health/live/").status, 200)
        self.assertEqual(self.call(app, "GET", "/items/new").body, {"literal": True})
        self.assertEqual(self.call(app, "GET", "/items/a%20b").body, {"id": "a b"})
        self.assertEqual(self.call(app, "GET", "/items/%E0%A4%A").body, {"error": "Invalid URL"})
        self.assertEqual(self.call(app, "GET", "/items/%FF").status, 400)
        for method, path in [("GET", "/nope"), ("DELETE", "/health/live"), ("GET", "/feature-flags")]:
            response = self.call(app, method, path)
            self.assertEqual((response.status, response.body), (404, {"error": "Endpoint not found"}))
        # Owner/permission endpoints are also served at their path (sign-in required), like TypeScript.
        self.assertEqual(self.call(app, "GET", "/reports").status, 401)

    def test_admin_mount_and_actors(self):
        local = make_app(local_admin=True)
        saved = self.call(local, "PUT", "/admin/app/feature-flags/x", FLAG)
        self.assertEqual((saved.status, saved.body["updatedBy"]), (200, "rt-app-root"))
        self.assertEqual(self.call(local, "GET", "/admin/app/reports").body, ["r"])
        self.assertEqual(self.call(local, "GET", "/me").status, 401)  # local admin is only for /admin routes

        closed = make_app()
        response = self.call(closed, "GET", "/admin/app/feature-flags")
        self.assertEqual((response.status, response.body), (401, {"error": "Sign in to admin"}))

        users = {"u": {"id": "u", "role": "user", "grants": ["reports.read"]}, "o": {"id": "o", "role": "owner"}}
        auth = make_app(authenticate=lambda r: users.get(r.headers.get("authorization", "")))
        self.assertEqual(self.call(auth, "GET", "/me", headers={"authorization": "u"}).body["id"], "u")
        # Grants apply at the plain path; /admin/app only admits the admin root.
        self.assertEqual(self.call(auth, "GET", "/reports", headers={"authorization": "u"}).body, ["r"])
        self.assertEqual(self.call(auth, "GET", "/admin/app/reports", headers={"authorization": "o"}).status, 401)
        root = make_app(admin_authenticate=lambda r: {"id": "rt-app-root", "role": "owner", "grants": []} if r.headers.get("authorization") == "admin" else None)
        self.assertEqual(self.call(root, "GET", "/admin/app/feature-flags", headers={"authorization": "admin"}).status, 200)
        self.assertEqual(self.call(root, "GET", "/admin/app/feature-flags", headers={"authorization": "x"}).status, 401)

    def test_errors(self):
        app = make_app()
        self.assertEqual(self.call(app, "GET", "/teapot").body, {"error": "Teapot"})
        with self.assertLogs("rt_app.web", "ERROR"):
            response = self.call(app, "GET", "/boom")
        self.assertEqual((response.status, response.body), (500, {"error": "Internal error"}))

    def test_duplicate_endpoints_are_rejected(self):
        with self.assertRaises(ValueError):
            App([Health().feature(), Health().feature()])


class LambdaTests(unittest.TestCase):
    def setUp(self):
        self.handler = handler_for(make_app(local_admin=True))

    def test_http_api_v2(self):
        body = base64.b64encode(json.dumps(FLAG).encode()).decode()
        event = {
            "version": "2.0", "rawPath": "/admin/app/feature-flags/v2", "rawQueryString": "",
            "headers": {"Content-Type": "application/json"}, "body": body, "isBase64Encoded": True,
            "requestContext": {"http": {"method": "PUT", "sourceIp": "1.2.3.4"}},
        }
        result = self.handler(event, None)
        self.assertEqual(result["statusCode"], 200)
        self.assertEqual(result["headers"], {"content-type": "application/json", "cache-control": "no-store"})
        self.assertEqual(json.loads(result["body"])["version"], 1)
        listed = self.handler({"version": "2.0", "rawPath": "/admin/app/feature-flags", "rawQueryString": "cursor=bad",
                               "requestContext": {"http": {"method": "GET"}}}, None)
        self.assertEqual((listed["statusCode"], json.loads(listed["body"])), (400, {"error": "Invalid cursor"}))

    def test_rest_v1_and_body_rules(self):
        event = {"httpMethod": "POST", "path": "/feature-flags/evaluate", "headers": {"X-A": "1"},
                 "queryStringParameters": None, "body": json.dumps({"keys": ["missing"]}), "isBase64Encoded": False,
                 "requestContext": {"identity": {"sourceIp": "1.2.3.4"}}}
        self.assertEqual(json.loads(self.handler(event, None)["body"]), {"missing": False})
        for raw in ["{bad", "[1]", "null"]:
            result = self.handler({**event, "body": raw}, None)
            self.assertEqual((result["statusCode"], json.loads(result["body"])), (400, {"error": "Invalid JSON"}))
        result = self.handler({**event, "body": json.dumps({"keys": ["x" * 20000]})}, None)
        self.assertEqual((result["statusCode"], json.loads(result["body"])), (413, {"error": "Request body too large"}))

    def test_local_event_round_trip(self):
        event = api_gateway_v2_event("GET", "/admin/app/feature-flags?cursor=bad&x=1", {"cookie": "a=1; b=2"}, b"", "127.0.0.1")
        self.assertEqual((event["rawPath"], event["rawQueryString"], event["cookies"]), ("/admin/app/feature-flags", "cursor=bad&x=1", ["a=1", "b=2"]))
        self.assertEqual(self.handler(event, None)["statusCode"], 400)


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = make_server(app_handler(make_app(local_admin=True)))
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = "http://127.0.0.1:%d" % cls.server.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def request(self, method, path, data=None):
        request = urllib.request.Request(self.base + path, data=data, method=method)
        try:
            with urllib.request.urlopen(request) as response:
                return response.status, response.headers, json.loads(response.read() or b"null")
        except urllib.error.HTTPError as error:
            with error:
                return error.code, error.headers, json.loads(error.read() or b"null")

    def test_json_responses(self):
        status, headers, body = self.request("GET", "/health/ready")
        self.assertEqual((status, body, headers["cache-control"]), (200, {"ok": True}, "no-store"))
        self.assertEqual(self.request("POST", "/feature-flags/evaluate", b"{bad")[::2], (400, {"error": "Invalid JSON"}))
        self.assertEqual(self.request("POST", "/feature-flags/evaluate", b"x" * 17000)[::2], (413, {"error": "Request body too large"}))
        self.assertEqual(self.request("GET", "/admin/app/feature-flags?cursor=bad")[::2], (400, {"error": "Invalid cursor"}))


class CliTests(unittest.TestCase):
    def run_cli(self, *args):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = main(list(args))
        return code, json.loads(out.getvalue())

    def test_call(self):
        with tempfile.TemporaryDirectory() as folder:
            with open(os.path.join(folder, "cli_app.py"), "w") as file:
                file.write("from rt_app.health import Health\nfrom rt_app.web import App\napp = App([Health().feature()])\n")
            cwd = os.getcwd()
            os.chdir(folder)
            try:
                self.assertEqual(self.run_cli("call", "cli_app:app", "GET", "/health/live"), (0, {"ok": True}))
                self.assertEqual(self.run_cli("call", "cli_app:app", "get", "/nope"), (1, {"error": "Endpoint not found"}))
                self.assertEqual(self.run_cli("call", "cli_app:app", "GET", "/health/live", "--body", "[1]", "--header", "x-a: 1"),
                                 (1, {"error": "Invalid JSON"}))
            finally:
                os.chdir(cwd)


if __name__ == "__main__":
    unittest.main()
