import base64
import json
import socket
import threading
import time
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from rt_app import HttpError
from rt_app.web import App, Endpoint, Feature, Request, handler_for, proxy_to, serve_raw
from rt_app.web.proxy import is_loopback
from rt_app.web.server import app_handler, make_server


class Upstream(BaseHTTPRequestHandler):
    """A stand-in for the Node core: echoes what it received."""

    protocol_version = "HTTP/1.1"

    def _serve(self):
        length = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(length) if length else b""
        if self.path.startswith("/slow"):
            time.sleep(1)
        if self.path.startswith("/redirect"):
            self.send_response(302)
            self.send_header("location", "/elsewhere")
            self.send_header("content-length", "0")
            self.end_headers()
            return
        data = json.dumps({
            "method": self.command,
            "path": self.path,
            "headers": {k.lower(): v for k, v in self.headers.items()},
            "body": body.decode("latin-1"),
        }).encode()
        self.send_response(418 if self.path.startswith("/teapot") else 200)
        self.send_header("content-type", "application/json")
        self.send_header("set-cookie", "a=1")
        self.send_header("set-cookie", "b=2")
        self.send_header("x-upstream", "yes")
        self.send_header("connection", "x-upstream-hop")
        self.send_header("x-upstream-hop", "drop me")
        self.send_header("keep-alive", "timeout=5")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_GET = do_POST = do_PUT = do_DELETE = do_HEAD = _serve

    def log_message(self, *args):
        pass


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class ProxyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        cls.upstream.daemon_threads = True
        threading.Thread(target=cls.upstream.serve_forever, daemon=True).start()
        cls.url = f"http://127.0.0.1:{cls.upstream.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.upstream.shutdown()
        cls.upstream.server_close()

    def make_app(self, **options):
        local = Feature(id="local", endpoints=[Endpoint("POST", "/native", "native", "guest", lambda c: {"native": c.request.body})])
        return App([local], fallback=proxy_to(self.url, **options))

    def test_only_loopback_upstreams(self):
        for url in ["http://10.0.0.5:4000", "http://example.com", "ftp://127.0.0.1", "http://127.0.0.1:4000/?x=1"]:
            with self.assertRaises(ValueError, msg=url):
                proxy_to(url)
        for host in ["localhost", "127.0.0.1", "127.8.9.10", "::1", "[::1]"]:
            self.assertTrue(is_loopback(host), host)
        proxy_to("http://[::1]:4000")

    def test_unmatched_requests_are_forwarded(self):
        app = self.make_app()
        response = serve_raw(
            app,
            "post",
            "/api/items?b=2&a=1&a=3",
            {
                "authorization": "Bearer t",
                "connection": "keep-alive, x-secret-hop",
                "x-secret-hop": "never forwarded",
                "te": "trailers",
                "proxy-authorization": "Basic x",
                "host": "api.example.test",
                "content-type": "text/plain",
            },
            b"not json at all",
            "203.0.113.9",
        )
        self.assertEqual(response.status, 200)
        echoed = json.loads(response.raw)
        self.assertEqual((echoed["method"], echoed["path"], echoed["body"]), ("POST", "/api/items?b=2&a=1&a=3", "not json at all"))
        headers = echoed["headers"]
        self.assertEqual(headers["authorization"], "Bearer t")
        self.assertEqual(headers["x-forwarded-for"], "203.0.113.9")
        self.assertEqual(headers["x-forwarded-host"], "api.example.test")
        for hop in ["x-secret-hop", "te", "proxy-authorization"]:
            self.assertNotIn(hop, headers)
        self.assertNotEqual(headers.get("connection", "close").lower(), "keep-alive, x-secret-hop")
        names = [name for name, _ in response.headers]
        self.assertEqual([v for n, v in response.headers if n == "set-cookie"], ["a=1", "b=2"])
        self.assertIn("x-upstream", names)
        for hop in ["connection", "keep-alive", "x-upstream-hop", "content-length"]:
            self.assertNotIn(hop, names)

    def test_matched_endpoints_stay_native(self):
        app = self.make_app()
        response = serve_raw(app, "POST", "/native", {}, b'{"x":1}')
        self.assertEqual((response.status, response.body, response.raw), (200, {"native": {"x": 1}}, None))
        self.assertEqual(serve_raw(app, "POST", "/native", {}, b"[1]").status, 400)  # JSON rules still apply
        # Same path, other method: no endpoint matches, so it is forwarded.
        self.assertEqual(json.loads(serve_raw(app, "GET", "/native", {}, b"").raw)["path"], "/native")

    def test_upstream_statuses_and_redirects_pass_through(self):
        app = self.make_app()
        self.assertEqual(serve_raw(app, "GET", "/teapot", {}, b"").status, 418)
        redirect = serve_raw(app, "GET", "/redirect", {}, b"")
        self.assertEqual((redirect.status, dict(redirect.headers)["location"]), (302, "/elsewhere"))

    def test_unavailable_core_is_502(self):
        down = App([], fallback=proxy_to(f"http://127.0.0.1:{free_port()}"))
        slow = self.make_app(timeout=0.2)
        with self.assertLogs("rt_app.web", "WARNING"):
            response = serve_raw(down, "GET", "/anything", {}, b"")
            self.assertEqual((response.status, response.body), (502, {"error": "RT-App core is unavailable"}))
            response = serve_raw(slow, "GET", "/slow", {}, b"")
            self.assertEqual((response.status, response.body), (502, {"error": "RT-App core is unavailable"}))

    def test_without_fallback_unmatched_is_404(self):
        response = App([]).handle(Request(method="GET", path="/nope"))
        self.assertEqual((response.status, response.body), (404, {"error": "Endpoint not found"}))

    def test_fallback_body_limit(self):
        app = self.make_app(max_body_bytes=32)
        self.assertEqual(serve_raw(app, "POST", "/big", {}, b"x" * 33).status, 413)
        self.assertEqual(serve_raw(app, "POST", "/big", {}, b"x" * 32).status, 200)

    def test_http_server_and_lambda_adapters(self):
        app = self.make_app()
        server = make_server(app_handler(app), 0, max_read=app.fallback_body_limit())
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            port = server.server_address[1]
            request = urllib.request.Request(f"http://127.0.0.1:{port}/proxied?q=1", data=b"\x00\xffraw", method="PUT")
            with urllib.request.urlopen(request) as answer:
                echoed = json.loads(answer.read())
                self.assertEqual(answer.headers.get_all("set-cookie"), ["a=1", "b=2"])
                self.assertEqual(answer.headers["x-upstream"], "yes")
            self.assertEqual((echoed["method"], echoed["path"], echoed["body"]), ("PUT", "/proxied?q=1", "\x00\xffraw"))
        finally:
            server.shutdown()
            server.server_close()
        result = handler_for(app)({
            "version": "2.0",
            "rawPath": "/proxied",
            "rawQueryString": "",
            "headers": {},
            "requestContext": {"http": {"method": "GET", "sourceIp": "198.51.100.1"}},
        })
        self.assertTrue(result["isBase64Encoded"])
        self.assertEqual(result["cookies"], ["a=1", "b=2"])
        self.assertEqual(json.loads(base64.b64decode(result["body"]))["headers"]["x-forwarded-for"], "198.51.100.1")


class AccessPolicyTests(unittest.TestCase):
    def test_unknown_access_fails_closed_without_an_acl(self):
        feature = Feature(id="x", endpoints=[Endpoint("GET", "/typo", "typo", "admin", lambda c: "open")])  # type: ignore[arg-type]
        app = App([feature], authenticate=lambda r: {"id": "root", "role": "owner", "grants": []})
        response = app.handle(Request(method="GET", path="/typo"))
        self.assertEqual((response.status, response.body), (403, {"error": "You do not have permission to access this resource"}))

    def test_acl_replaces_the_builtin_policy(self):
        seen = []

        class Deny:
            def check(self, endpoint, actor=None):
                seen.append((endpoint.resource, actor))
                raise HttpError(403, "Denied by policy")

        feature = Feature(id="x", endpoints=[Endpoint("GET", "/open", "open", "guest", lambda c: "ok")])
        response = App([feature], acl=Deny()).handle(Request(method="GET", path="/open"))
        self.assertEqual((response.status, response.body, seen), (403, {"error": "Denied by policy"}, [("open", None)]))


if __name__ == "__main__":
    unittest.main()
