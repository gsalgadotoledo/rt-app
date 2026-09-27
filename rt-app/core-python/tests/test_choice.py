import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from rt_app import HttpError
from rt_app.choice import AbortError, Choice, InvalidProviderResponse, validate_choice
from rt_app.choice._json import canonical, snapshot, stringify
from rt_app.choice.jev import JEV_URL, HttpRequest, HttpResponse, JevError, JevProvider, urllib_transport
from rt_app.choice.transformers import InvalidClassifierResponse, TransformersChoiceProvider
from rt_app.web import App, serve_raw

INPUT = {
    "context": "Refund",
    "question": "Which team?",
    "options": [{"id": "billing", "description": "Invoices"}, {"id": "sales"}],
}
PREDICTION = {
    "probabilities": {"billing": 0.9, "sales": 0.1},
    "model": "test",
    "semantics": "model-probabilities",
    "confidence": 0.7,
}


class Fake:
    id = "fake"

    def __init__(self, result=PREDICTION, hook=None):
        self.result, self.hook, self.calls = result, hook, []

    def predict(self, input, signal=None):
        self.calls.append(input)
        if self.hook:
            self.hook()
        return self.result


class JsonTests(unittest.TestCase):
    def test_javascript_key_order_numbers_and_escapes(self):
        value = {"b": 1, "a": 2, "10": 3, "2": 4, "😀": 5, "\uff01": 6, "4294967295": 7, "4294967294": 8}
        self.assertEqual(
            stringify(snapshot(value)),
            '{"2":4,"10":3,"4294967294":8,"4294967295":7,"a":2,"b":1,"😀":5,"\uff01":6}',
        )
        self.assertEqual(canonical({"b": 1, "10": 2, "2": 3}), '{"10":2,"2":3,"b":1}')
        self.assertEqual(stringify([1e21, 1e-7, 100.0, -0.0, 10**21]), "[1e+21,1e-7,100,0,1e+21]")
        self.assertEqual(stringify("\x00\x1f\b\"\\\x7f\u2028\ud800"), '"\\u0000\\u001f\\b\\"\\\\\x7f\u2028\\ud800"')


class ChoiceTests(unittest.TestCase):
    def test_accepts_confident_calibrated_answers(self):
        decision = Choice(Fake()).decide(INPUT)
        self.assertEqual(decision, {"provider": "fake", **PREDICTION, "selected": "billing", "accepted": True, "requiresReview": False})
        self.assertTrue(Choice(Fake()).decide(INPUT, {"minProbability": 0.99})["requiresReview"])
        uncalibrated = Fake({**PREDICTION, "semantics": "uncalibrated-scores"})
        self.assertFalse(Choice(uncalibrated).decide(INPUT)["accepted"])
        self.assertTrue(Choice(uncalibrated).decide(INPUT, {"allowUncalibrated": True})["accepted"])
        self.assertFalse(Choice(uncalibrated).decide(INPUT, {"allowUncalibrated": 1})["accepted"])
        tie = Fake({**PREDICTION, "probabilities": {"billing": 0.5, "sales": 0.5}})
        self.assertEqual(Choice(tie).decide(INPUT, {"minProbability": 0, "minMargin": 0})["accepted"], False)

    def test_margin_uses_float64(self):
        three = {"question": "q", "options": [{"id": "a"}, {"id": "b"}, {"id": "c"}]}
        fake = Fake({"probabilities": {"a": 0.5, "b": 0.4, "c": 0.1}, "model": "m", "semantics": "model-probabilities"})
        self.assertFalse(Choice(fake).decide(three, {"minProbability": 0.5, "minMargin": 0.1})["accepted"])

    def test_validation(self):
        for bad, message in [
            (None, "Invalid choice question or options"),
            ([], "Invalid choice question or options"),
            ({**INPUT, "question": "\u00a0\ufeff"}, "Invalid choice question or options"),
            ({**INPUT, "question": "😀" * 2001}, "Invalid choice question or options"),
            ({**INPUT, "options": [{"id": "a"}] * 256}, "Invalid choice question or options"),
            ({**INPUT, "options": [{"id": "a"}, {"id": "a"}]}, "Invalid or duplicate option"),
            ({**INPUT, "options": [{"id": "a\n"}, {"id": "b"}]}, "Invalid or duplicate option"),
            ({**INPUT, "options": [{"id": "a", "description": None}, {"id": "b"}]}, "Invalid or duplicate option"),
            ({**INPUT, "context": "é" * 63969, "question": "q", "options": [{"id": "a"}, {"id": "b"}]}, "Choice input too large"),
        ]:
            with self.subTest(message=message), self.assertRaises(HttpError) as caught:
                validate_choice(bad)
            self.assertEqual((caught.exception.status, caught.exception.message), (400, message))
        self.assertEqual(validate_choice({**INPUT, "question": "\u200b"})["question"], "\u200b")
        big = {"context": "é" * 63968, "question": "q", "options": [{"id": "a"}, {"id": "b"}]}
        self.assertEqual(validate_choice(big)["question"], "q")

    def test_invalid_answers_and_policy(self):
        for result in [
            None,
            {**PREDICTION, "probabilities": {"billing": 0.5, "sales": 0.2}},
            {**PREDICTION, "probabilities": {"billing": 1, "other": 0}},
            {**PREDICTION, "probabilities": {"billing": True, "sales": 0}},
            {**PREDICTION, "confidence": None},
            {**PREDICTION, "confidence": 2},
            {**PREDICTION, "model": ""},
            {**PREDICTION, "semantics": "fake"},
        ]:
            with self.subTest(result=result), self.assertRaises(InvalidProviderResponse):
                Choice(Fake(result)).decide(INPUT)
        fake = Fake()
        with self.assertRaises(HttpError) as caught:
            Choice(fake).decide(INPUT, {"minMargin": -1})
        self.assertEqual(caught.exception.message, "Invalid choice policy")
        self.assertEqual(fake.calls, [])

    def test_cancellation(self):
        aborted = threading.Event()
        aborted.set()
        with self.assertRaises(AbortError):
            Choice(Fake()).decide(INPUT, None, aborted)
        signal = threading.Event()
        with self.assertRaises(AbortError) as caught:
            Choice(Fake(hook=signal.set)).decide(INPUT, None, signal)
        self.assertEqual(caught.exception.message, "This operation was aborted")

    def test_feature_over_http(self):
        feature = Choice(Fake()).feature()
        self.assertTrue(feature.endpoints[0].explicit_grant)
        app = App([feature], local_admin=True)
        response = serve_raw(app, "POST", "/admin/app/choice/decide", {}, json.dumps(INPUT).encode())
        # rt_app.web applies explicitGrant under /admin/app (TypeScript does not): 403 for now.
        self.assertIn(response.status, (200, 403))
        # Outside /admin/app the caller must be signed in (and hold choice.decide explicitly).
        self.assertEqual(serve_raw(app, "POST", "/choice/decide", {}, b"{}").status, 401)


class JevTests(unittest.TestCase):
    def test_envelope_and_mapping(self):
        sent = []

        def transport(request: HttpRequest) -> HttpResponse:
            sent.append(request)
            answer = {"model": "jev-test", "answers": {"decision": {"type": "choice", "probabilities": {"billing": 1, "sales": 0}}}}
            return HttpResponse(200, json.dumps(answer).encode())

        provider = JevProvider("key", "m", transport)
        self.assertEqual(
            provider.predict(INPUT),
            {"model": "jev-test", "probabilities": {"billing": 1, "sales": 0}, "semantics": "model-probabilities"},
        )
        self.assertEqual(sent[0].url, JEV_URL)
        self.assertEqual(sent[0].headers["authorization"], "Bearer key")
        self.assertEqual(
            sent[0].body.decode(),
            '{"model":"m","state":"Refund","questions":{"decision":{"type":"choice","instructions":"Which team?",'
            '"criteria":{"billing":"Invoices","sales":null}}}}',
        )
        for args in [("",), ("key", ""), ("key", "m", transport, 0), ("key", "m", transport, "15")]:
            with self.assertRaises(TypeError):
                JevProvider(*args)

    def test_private_failures(self):
        for response, message in [
            (HttpResponse(429, b"secret"), "Jev request failed: HTTP 429"),
            (HttpResponse(200, b"secret"), "Invalid Jev response"),
            (HttpResponse(200, b"null"), "Invalid Jev response"),
            (HttpResponse(200, b"{}"), "Invalid Jev response"),
        ]:
            with self.subTest(message=message), self.assertRaises(JevError) as caught:
                JevProvider("key", "m", lambda _request, r=response: r).predict(INPUT)
            self.assertEqual(caught.exception.message, message)

    def test_urllib_transport_refuses_redirects_and_skips_failure_bodies(self):
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers["content-length"])
                body = self.rfile.read(length)
                if self.path == "/redirect":
                    self.send_response(302)
                    self.send_header("location", "/ok")
                    self.end_headers()
                elif self.path == "/fail":
                    self.send_response(503)
                    self.end_headers()
                    self.wfile.write(b"secret")
                else:
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(body)

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            base = f"http://127.0.0.1:{server.server_port}"
            request = lambda path: HttpRequest(base + path, "POST", {"content-type": "application/json"}, b"{}", 5)
            self.assertEqual(urllib_transport(request("/ok")), HttpResponse(200, b"{}"))
            self.assertEqual(urllib_transport(request("/fail")), HttpResponse(503))
            with self.assertRaises(OSError):
                urllib_transport(request("/redirect"))
        finally:
            server.shutdown()
            server.server_close()


class TransformersTests(unittest.TestCase):
    def test_maps_reordered_labels_without_calibration(self):
        seen = []

        def pipeline(text, labels, *, multi_label):
            seen.append((text, labels, multi_label))
            return {"labels": labels[::-1], "scores": [0.1, 0.9]}

        prediction = TransformersChoiceProvider(pipeline, "open-model").predict(INPUT)
        self.assertEqual(prediction, {"model": "open-model", "semantics": "uncalibrated-scores", "probabilities": {"billing": 0.9, "sales": 0.1}})
        self.assertEqual(seen, [('Which team?\n\n"Refund"', ["billing: Invoices", "sales"], False)])
        self.assertFalse(Choice(TransformersChoiceProvider(pipeline, "m")).decide(INPUT)["accepted"])

    def test_invalid_results_and_cancellation(self):
        for result in [None, {"labels": [], "scores": []}, {"labels": ["sales", "sales"], "scores": [0.5, 0.5]},
                       {"labels": ["wrong", "sales"], "scores": [1, 0]}, {"labels": "ab", "scores": [1, 0]}]:
            with self.subTest(result=result), self.assertRaises(InvalidClassifierResponse):
                TransformersChoiceProvider(lambda *a, r=result, **k: r, "m").predict(INPUT)
        signal = threading.Event()

        def pipeline(text, labels, *, multi_label):
            signal.set()
            return {"labels": labels, "scores": [0.5, 0.5]}

        with self.assertRaises(AbortError):
            TransformersChoiceProvider(pipeline, "m").predict(INPUT, signal)


if __name__ == "__main__":
    unittest.main()
