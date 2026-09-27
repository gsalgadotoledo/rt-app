import asyncio
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from rt_app import HttpError
from rt_app.health import AvailabilityMonitor, Health, HealthChecks, Probe, http_health_probe
from rt_app.web import App, Request

NOW = 1_893_456_000_000  # 2030-01-01T00:00:00.000Z


def fail(signal):
    raise RuntimeError("password=secret")


class HealthChecksTests(unittest.TestCase):
    def test_report_redacts_failures_and_keeps_order(self):
        health = HealthChecks([Probe("db", fail), Probe("search", lambda s: None, required=False)], now=lambda: NOW)
        report = health.report()
        self.assertEqual(report["at"], "2030-01-01T00:00:00.000Z")
        self.assertFalse(report["ok"])
        self.assertEqual([(c["id"], c["required"], c["status"]) for c in report["checks"]], [("db", True, "down"), ("search", False, "up")])
        self.assertNotIn("secret", repr(report))
        self.assertIsInstance(report["checks"][0]["durationMs"], int)

    def test_cache_uses_the_clock_and_copies(self):
        now, calls = [NOW], []
        health = HealthChecks([Probe("db", lambda s: calls.append(1))], 100, 1000, now=lambda: now[0])
        first = health.report()
        first["checks"][0]["status"] = "down"
        now[0] += 999
        self.assertEqual(health.report()["checks"][0]["status"], "up")
        self.assertEqual(len(calls), 1)
        now[0] += 1
        self.assertEqual(health.report()["at"], "2030-01-01T00:00:01.000Z")
        self.assertEqual(len(calls), 2)

    def test_timeouts_abort_and_run_in_parallel(self):
        signals = []

        def hang(signal):
            signals.append(signal)
            signal.wait()

        slow = [Probe(f"p{i}", lambda s: threading.Event().wait(0.05)) for i in range(5)]
        health = HealthChecks([Probe("hang", hang, required=False), *slow], 200, 0)
        report = health.report()
        self.assertTrue(report["ok"])
        self.assertEqual(report["checks"][0]["status"], "down")
        self.assertTrue(signals[0].is_set())
        self.assertTrue(all(c["status"] == "up" for c in report["checks"][1:]))

    def test_async_probes(self):
        async def ok(signal):
            await asyncio.sleep(0)

        async def broken(signal):
            raise RuntimeError("down")

        report = HealthChecks([Probe("a", ok), Probe("b", broken)], cache_ms=0).report()
        self.assertEqual([c["status"] for c in report["checks"]], ["up", "down"])

    def test_concurrent_callers_share_one_run(self):
        calls = []
        health = HealthChecks([Probe("db", lambda s: (calls.append(1), threading.Event().wait(0.05)))], cache_ms=0)
        barrier, results = threading.Barrier(4), []
        threads = [threading.Thread(target=lambda: (barrier.wait(), results.append(health.report()))) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(results), 4)

    def test_invalid_configuration(self):
        for probes, timeout, cache in [([], 0, 1), ([], 10, -1), ([], "10", 1), ([], 10, True), ([], float("inf"), 1),
                                       ([Probe("db", fail), Probe("db", fail)], 10, 1), ([Probe(f"p{i}", fail) for i in range(21)], 10, 1)]:
            with self.subTest(timeout=timeout, cache=cache, probes=len(probes)):
                with self.assertRaisesRegex(ValueError, "Invalid health configuration"):
                    HealthChecks(probes, timeout, cache)
        HealthChecks([Probe(f"p{i}", fail) for i in range(20)], 1.5, 0)

    def test_endpoints(self):
        health = HealthChecks([Probe("db", fail)], cache_ms=0)
        app = App([health.feature()], local_admin=True)
        self.assertEqual(app.handle(Request("GET", "/health/live")).body, {"ok": True})
        self.assertEqual(app.handle(Request("GET", "/health/ready")).status, 503)
        self.assertEqual(app.handle(Request("GET", "/health/ready")).body, {"error": "Service unavailable"})
        self.assertEqual(app.handle(Request("GET", "/health/report")).status, 404)
        report = app.handle(Request("GET", "/admin/app/health/report"))
        self.assertEqual((report.status, report.body["ok"]), (200, False))
        self.assertEqual([e.path for e in Health().feature().endpoints], ["/health/live", "/health/ready"])


class MonitorTests(unittest.TestCase):
    def test_alerts_initial_outage_transitions_and_retries(self):
        down, fail_next, alerts = [True], [False], []

        def check(signal):
            if down[0]:
                raise RuntimeError("down")

        def notify(alert):
            if fail_next[0]:
                fail_next[0] = False
                raise RuntimeError("mail offline")
            alerts.append(alert["status"])

        monitor = AvailabilityMonitor(HealthChecks([Probe("api", check)], cache_ms=0, now=lambda: NOW), notify)
        monitor.poll()
        monitor.poll()
        down[0], fail_next[0] = False, True
        with self.assertRaisesRegex(RuntimeError, "mail offline"):
            monitor.poll()
        monitor.poll()
        self.assertEqual(alerts, ["down", "up"])


class _Handler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        status = {"/ok": 200, "/redirect": 302, "/fail": 503}[self.path]
        self.send_response(status)
        if status == 302:
            self.send_header("location", "/ok")
        self.send_header("content-length", "2")
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, *args):
        pass


class HttpProbeTests(unittest.TestCase):
    def test_validation(self):
        for url in ["ftp://example.test", "mailto:a@b.test", "https://user:pass@example.test", "https://:secret@example.test", "https://user@example.test"]:
            with self.subTest(url=url), self.assertRaisesRegex(ValueError, "^Invalid health URL$"):
                http_health_probe("x", url)
        for url in ["", "relative/path", "/abs", "http://", "https://example.test:99999"]:
            with self.subTest(url=url), self.assertRaisesRegex(ValueError, "^Invalid URL$"):
                http_health_probe("x", url)
        for url in ["https://@example.test", "https://:@example.test", "HTTPS://EXAMPLE.TEST/"]:
            self.assertEqual(http_health_probe("ok", url).id, "ok")

    def test_real_requests_reject_redirects_and_errors(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{server.server_address[1]}"
        try:
            http_health_probe("ok", base + "/ok").check(threading.Event())
            for path in ["/redirect", "/fail"]:
                with self.subTest(path=path), self.assertRaisesRegex(RuntimeError, "Service unavailable"):
                    http_health_probe("x", base + path).check(threading.Event())
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
