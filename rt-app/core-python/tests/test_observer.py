import threading
import time
import unittest

from rt_app import HttpError
from rt_app.nosql import MemoryStore
from rt_app.observer import (
    Observer,
    ObserverStore,
    Output,
    matches_log,
    observer_feature,
    post_output,
    safe_path,
    sanitize,
    valid_day,
    validate_log_query,
)
from rt_app.observer._json import stringify
from rt_app.observer.console import ConsoleOutput
from rt_app.observer.email import EmailOutput, LocalEmailOutput
from rt_app.observer.slack import SlackOutput
from rt_app.observer.sms import SmsOutput
from rt_app.observer.webhook import WebhookOutput
from rt_app.web import App, Request

T0 = 1_772_600_767_890  # 2026-03-04T05:06:07.890Z


class Recorder:
    def __init__(self, id="spy", behavior="ok"):
        self.id, self.behavior, self.events, self.signal = id, behavior, [], None

    def write(self, event, signal=None):
        self.signal = signal
        if self.behavior == "fail":
            raise RuntimeError("password=hunter2")
        if self.behavior == "hang":
            signal.wait()
            return
        self.events.append(event)


class Transport:
    def __init__(self, status=200):
        self.status, self.requests = status, []

    def __call__(self, request, signal=None):
        self.requests.append(request)
        return self.status


class Client:
    def __init__(self):
        self.calls = []

    def send_email(self, **kwargs):
        self.calls.append(kwargs)

    def publish(self, **kwargs):
        self.calls.append(kwargs)


def event(**fields):
    return {"category": "app", "id": "e1", "at": "2026-03-04T05:06:07.890Z", "level": "error", "kind": "log", "source": "app", "message": "m", "data": {}, **fields}


class SanitizeTests(unittest.TestCase):
    def test_keys_strings_and_limits(self):
        self.assertEqual(
            sanitize({"password": "x", "zip": 1, "name": "me@example.com", "note": "Bearer abc token=1"}),
            {"password": "[redacted]", "zip": "[redacted]", "name": "[email]", "note": "Bearer [redacted] token=[redacted]"},
        )
        self.assertEqual(sanitize("😀" * 501), "😀" * 500)
        self.assertEqual(sanitize({"a": {"b": {"c": {"d": {"e": 1}}}}}), {"a": {"b": {"c": {"d": {"e": "[truncated]"}}}}})
        self.assertEqual(len(sanitize(list(range(25)))), 20)
        self.assertEqual(list(sanitize({"b": 1, "10": 2, "2": 3})), ["2", "10", "b"])
        self.assertEqual(sanitize(ValueError("secret")), {"name": "ValueError"})
        # ASCII-only case folding, JavaScript whitespace.
        self.assertEqual(sanitize({"\u017fecret": "kept"}), {"\u017fecret": "kept"})
        self.assertEqual(sanitize("Bearer\u00a0x"), "Bearer [redacted]")
        self.assertEqual(sanitize("Bearer\u200bx"), "Bearer\u200bx")

    def test_safe_path(self):
        self.assertEqual(safe_path("https://u:p@h.test/a b/../c?q#f"), "/c")
        self.assertEqual(safe_path("../x"), "/x")
        self.assertEqual(safe_path("/{^}"), "/%7B%5E%7D")
        for bad, message in (("javascript:x", "Observer expects an HTTP URL or path"), ("http://", "Invalid URL"), ("http://h:99999/", "Invalid URL")):
            with self.assertRaisesRegex(ValueError, message):
                safe_path(bad)

    def test_days_and_queries(self):
        self.assertTrue(valid_day("2024-02-29") and valid_day("0000-02-29"))
        self.assertFalse(valid_day("2026-02-29") or valid_day("1900-02-29") or valid_day("２０２６-01-01") or valid_day(20260101))
        for query, message in (({"day": "x"}, "Invalid day"), ({"day": "2026-01-01", "level": "fatal"}, "Invalid level"), ({"day": "2026-01-01", "text": "t" * 201}, "Invalid log filter")):
            with self.assertRaises(HttpError) as caught:
                validate_log_query(query)
            self.assertEqual(caught.exception.message, message)
        self.assertFalse(matches_log({"level": "debug"}, {"day": "d"}))
        self.assertTrue(matches_log({"level": "info", "message": 'say "HI"'}, {"day": "d", "text": '\\"hi'}))


class ObserverTests(unittest.TestCase):
    def setUp(self):
        self.now = [T0]
        self.ids = iter(f"e{i}" for i in range(1, 10_000))

    def observer(self, outputs, timeout_ms=1500):
        return Observer(outputs, timeout_ms, now=lambda: self.now[0], new_id=lambda: next(self.ids))

    def test_events_context_and_helpers(self):
        spy = Recorder()
        observer = self.observer([Output(spy)])
        observer.with_context({"requestId": "r1", "category": "payments", "other": "x"}, lambda: observer.error("Declined", {"email": "a@b.co"}))
        observer.info({"a": 1})
        observer.count_view("Home", {"url": "https://h.test/home?token=1", "apiUrl": "/v1"})
        observer.record_request({"method": "get", "url": "/users/:id?x", "durationMs": 3, "status": 404})
        self.assertEqual(spy.events[0], {
            "category": "payments", "id": "e1", "at": "2026-03-04T05:06:07.890Z", "level": "error", "kind": "log", "source": "app",
            "message": "Declined", "data": {"values": [{"email": "[redacted]"}]}, "requestId": "r1",
        })
        self.assertEqual((spy.events[1]["message"], spy.events[1]["data"]), ("Application log", {"values": [{"a": 1}]}))
        self.assertEqual((spy.events[2]["category"], spy.events[2]["source"], spy.events[2]["data"]), ("analytics", "spa", {"path": "/home", "endpointPath": "/v1"}))
        self.assertEqual((spy.events[3]["level"], spy.events[3]["data"]), ("warn", {"method": "GET", "path": "/users/:id", "status": 404, "durationMs": 3}))
        with self.assertRaisesRegex(ValueError, "Invalid request metric"):
            observer.record_request({"method": "GET", "url": "/", "durationMs": True, "status": 200})

    def test_measure_keeps_results_and_errors(self):
        spy = Recorder()
        observer = self.observer([Output(spy)])

        def slow():
            self.now[0] += 25
            return 42

        self.assertEqual(observer.measure("op", slow), 42)
        failure = RuntimeError("private")
        with self.assertRaises(RuntimeError) as caught:
            observer.measure("op", lambda: (_ for _ in ()).throw(failure), source="worker")
        self.assertIs(caught.exception, failure)
        self.assertEqual([e["data"] for e in spy.events], [{"name": "op", "durationMs": 25, "failed": False}, {"name": "op", "durationMs": 0, "failed": True}])

    def test_subscriptions_filters_failures_and_budgets(self):
        errors, broken, hanging, pager = Recorder("errors"), Recorder("broken", "fail"), Recorder("hanging", "hang"), Recorder("pager")
        observer = self.observer([
            Output(errors, levels=["error"], filter=lambda e: "page" in e["message"]),
            Output(broken),
            Output(hanging),
            Output(pager, max_per_minute=1),
            Output(Recorder("off"), enabled=False),
        ], timeout_ms=30)
        observer.error("page me")
        observer.error("ignored")
        self.assertEqual([e["message"] for e in errors.events], ["page me"])
        self.assertEqual(observer.health, {"failed": 4, "dropped": 1})
        self.assertTrue(hanging.signal.is_set())
        self.now[0] += 60_000
        observer.error("next minute")
        self.assertEqual(len(pager.events), 2)
        with self.assertRaisesRegex(ValueError, "Duplicate observer output id"):
            Observer([Output(Recorder()), Output(Recorder())])

    def test_concurrent_contexts_and_in_flight_limit(self):
        spy = Recorder()
        observer = self.observer([Output(spy)])

        def request(id, delay):
            observer.with_context({"requestId": id}, lambda: (time.sleep(delay), observer.info(id)))

        threads = [threading.Thread(target=request, args=(id, delay)) for id, delay in (("a", 0.02), ("b", 0))]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(sorted((e["message"], e["requestId"]) for e in spy.events), [("a", "a"), ("b", "b")])
        busy = self.observer([Output(Recorder("hang", "hang"))], timeout_ms=200)
        barrier = threading.Barrier(33)
        threads = [threading.Thread(target=lambda: (barrier.wait(), busy.info("x"))) for _ in range(33)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(busy.health, {"failed": 32, "dropped": 1})


class AnalyticsTests(unittest.TestCase):
    def test_the_observer_serves_analytics(self):
        from rt_app.analytics import Analytics

        spy = Recorder()
        analytics = Analytics(Observer([Output(spy)]))
        analytics.track("checkout.completed", {"password": "x"})
        analytics.page_view("Home", {"url": "/?q=1"})
        self.assertEqual([(e["kind"], e["category"], e["data"]) for e in spy.events], [("analytics", "analytics", {"password": "[redacted]"}), ("pageview", "analytics", {"path": "/"})])


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.now = [T0]
        self.store = MemoryStore()
        self.storage = ObserverStore(self.store, now=lambda: self.now[0])
        ids = iter(f"e{i}" for i in range(1, 100))
        self.observer = Observer([Output(self.storage)], now=lambda: self.now[0], new_id=lambda: next(ids))

    def test_rows_report_and_search(self):
        self.observer.record_request({"method": "GET", "url": "/a", "durationMs": 0.125, "status": 500})
        self.observer.record_request({"method": "GET", "url": "/a", "durationMs": 2.375, "status": 200})
        self.observer.count_view("Home", {"url": "/"})
        self.observer.debug("hidden")
        row = self.store.get("OBSERVER#2026-03-04", "2026-03-04T05:06:07.890Z#e1")
        self.assertEqual((row["version"], row["ttl"]), (1, 1_773_205_567))
        report = self.storage.report("2026-03-04")
        self.assertEqual(report["counts"], {"requests": 2, "errors": 1, "spa": 1, "ssr": 0})
        self.assertEqual(report["requestMetrics"], [{"name": "GET /a", "source": "api", "count": 2, "minMs": 0.125, "maxMs": 2.375, "errors": 1, "averageMs": 1.25}])
        self.assertEqual(report["averageMs"], 1)  # Math.round(1.25)
        self.assertEqual(report["hours"][5], {"hour": 5, "requests": 2, "views": 1})
        self.assertEqual([e["id"] for e in self.storage.search({"day": "2026-03-04"})["events"]], ["e1", "e2", "e3"])
        self.assertEqual([e["id"] for e in self.storage.search({"day": "2026-03-04", "level": "debug"})["events"]], ["e4"])
        self.now[0] += 7 * 86_400_000
        self.assertEqual(self.storage.report("2026-03-04")["events"], [])

    def test_half_values_round_up_like_javascript(self):
        for id, ms in (("a", 0.125), ("b", 2.375)):
            self.storage.write(event(id=id, kind="request", data={"method": "GET", "path": "/x", "durationMs": ms, "status": 200}))
        self.storage.write(event(id="c", kind="request", data={"path": "/y", "durationMs": 0.125, "status": "503"}))
        report = self.storage.report("2026-03-04")
        self.assertEqual([(m["name"], m["averageMs"], m["errors"]) for m in report["requestMetrics"]], [("GET /x", 1.25, 0), ("undefined /y", 0.13, 1)])


class FeatureTests(unittest.TestCase):
    def setUp(self):
        self.now = [T0]
        self.spy = Recorder()
        storage = ObserverStore(MemoryStore(), now=lambda: self.now[0])
        observer = Observer([Output(storage), Output(self.spy)], now=lambda: self.now[0])
        self.app = App([observer_feature(observer, storage, now=lambda: self.now[0])], local_admin=True)

    def call(self, method, path, body=None, query=None, ip="10.0.0.1"):
        response = self.app.handle(Request(method=method, path=path, body=body or {}, query=query or {}, ip=ip))
        return response.status, response.body

    def test_endpoints_are_mounted_like_typescript(self):
        self.assertEqual(self.call("GET", "/observer/report")[0], 404)
        self.assertEqual(self.call("POST", "/admin/app/observer/events", {"source": "spa", "path": "/"})[0], 404)
        status, body = self.call("GET", "/admin/app/observer/report")
        self.assertEqual((status, body["day"], body["health"]), (200, "2026-03-04", {"failed": 0, "dropped": 0}))
        self.assertEqual(body["outputs"][0], {"id": "store", "enabled": True, "levels": ["debug", "info", "warn", "error"], "kinds": ["log", "request", "pageview", "timing", "analytics"]})
        self.assertEqual(self.call("GET", "/admin/app/observer/logs", query={"level": "nope"}), (400, {"error": "Invalid level"}))

    def test_page_events_are_validated_and_limited(self):
        for body, message in (({"source": "spa", "path": "/", "message": None}, "Invalid page message"), ({"source": "spa", "path": "//evil.test/x"}, "Invalid page event"), ({"source": "web", "path": "/"}, "Invalid page event")):
            self.assertEqual(self.call("POST", "/observer/events", body), (400, {"error": message}))
        for _ in range(60):
            self.assertEqual(self.call("POST", "/observer/events", {"source": "spa", "path": "/"}), (200, {"ok": True}))
        self.assertEqual(self.call("POST", "/observer/events", {"source": "spa", "path": "/"}), (429, {"error": "Too many events"}))
        self.assertEqual(self.call("POST", "/observer/events", {"source": "spa", "path": "/"}, ip="10.0.0.2")[0], 200)
        self.now[0] += 60_000
        self.assertEqual(self.call("POST", "/observer/events", {"source": "ssr", "path": "/a"})[0], 200)
        self.assertEqual(self.spy.events[-1]["message"], "Page viewed")


class OutputTests(unittest.TestCase):
    def test_console_json_lines(self):
        lines = []
        ConsoleOutput(lambda level, line: lines.append((level, line))).write(event(data={"n": 1.0, "x": 1e-7}))
        self.assertEqual(lines, [("error", '{"category":"app","id":"e1","at":"2026-03-04T05:06:07.890Z","level":"error","kind":"log","source":"app","message":"m","data":{"n":1,"x":1e-7}}')])
        self.assertEqual(stringify({"a": [], "b": {}, "c": [1]}, 2), '{\n  "a": [],\n  "b": {},\n  "c": [\n    1\n  ]\n}')

    def test_webhook_and_post_output(self):
        transport = Transport()
        WebhookOutput("audit", "https://LOGS.test:443/in", {"X-Key": "k"}, transport).write(event())
        self.assertEqual(transport.requests[0]["url"], "https://logs.test/in")
        self.assertEqual(transport.requests[0]["headers"], {"Content-Type": "application/json", "X-Key": "k"})
        with self.assertRaisesRegex(ValueError, "requires HTTPS"):
            WebhookOutput("x", "http://logs.test", transport=transport)
        with self.assertRaisesRegex(ValueError, "without URL credentials"):
            post_output("https://u:p@logs.test", "{}", {}, transport=transport)
        with self.assertRaisesRegex(RuntimeError, "returned HTTP 302"):
            post_output("https://logs.test", "{}", {}, transport=Transport(302))
        self.assertEqual(len(transport.requests), 1)

    def test_slack(self):
        transport = Transport()
        SlackOutput("https://hooks.slack.com/services/x", transport).write(event(category="payments", requestId="r1", message="Declined"))
        self.assertEqual(transport.requests[0]["body"], '{"text":"[error] payments: Declined\\nRequest: r1","mrkdwn":false}')
        for url in ("https://hooks.slack.com./services/x", "https://evil.test/services/x", "https://hooks.slack.com/services"):
            with self.assertRaisesRegex(ValueError, "Invalid Slack incoming webhook"):
                SlackOutput(url, transport)

    def test_email_and_sms(self):
        client = Client()
        EmailOutput("a@x.test", "b@x.test", client).write(event())
        self.assertEqual(client.calls[0]["Content"]["Simple"]["Subject"], {"Data": "[error] app"})
        self.assertTrue(client.calls[0]["Content"]["Simple"]["Body"]["Text"]["Data"].startswith('{\n  "category": "app",'))
        with self.assertRaisesRegex(ValueError, "valid from/to"):
            EmailOutput("a", "b@x.test", client)
        sent = []
        LocalEmailOutput("a", "b", 1024, send=sent.append, production=False).write(event(level="warn"))
        self.assertEqual(sent[0]["subject"], "[warn] app")
        with self.assertRaisesRegex(ValueError, "production"):
            LocalEmailOutput("a", "b", 1, production=True)
        with self.assertRaisesRegex(ValueError, "port"):
            LocalEmailOutput("a", "b", 2.5, production=False)
        sms = Client()
        SmsOutput("+15555550123", sms).write(event(message="x" * 200))
        self.assertEqual(len(sms.calls[0]["Message"]), 140)
        with self.assertRaisesRegex(ValueError, "E.164"):
            SmsOutput("+1555555012\n", sms)


if __name__ == "__main__":
    unittest.main()
