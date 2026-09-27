import threading
import unittest

from rt_app import HttpError
from rt_app.queue import MemoryQueue, Queue, QueueError, StaleReceipt, parse_date, validate_failure_limit, validate_message
from rt_app.web import App, Request

T0 = 1767323045678  # 2026-01-02T03:04:05.678Z


def message(id="m1", **extra):
    return {"id": id, "type": "t", "createdAt": "2026-01-02", **extra}


class Clock:
    def __init__(self):
        self.ms = T0

    def __call__(self):
        return self.ms


class ValidationTests(unittest.TestCase):
    def test_messages_are_normalized_copies(self):
        self.assertEqual(
            validate_message(message(payload={"z": [1.0, -0.0, 1e21]}, extra=True)),
            {"id": "m1", "type": "t", "createdAt": "2026-01-02", "payload": {"z": [1, 0, 1e21]}, "extra": True},
        )

    def test_invalid_envelopes(self):
        for bad in (None, [], "m", message(id=""), message(id=" "), message(id="😀" * 100 + "a"), message(traceId=None), message(createdAt="2026-13-01"), {"id": "m", "type": "t"}):
            with self.assertRaisesRegex(TypeError, "^Invalid queue message$"):
                validate_message(bad)
        self.assertEqual(validate_message(message(id="​", traceId=""))["traceId"], "")

    def test_size_limit_counts_utf8_bytes_of_the_canonical_json(self):
        validate_message(message(id="m", createdAt="2026-01-02T03:04:05.678Z", payload="x" * 239927))
        with self.assertRaisesRegex(TypeError, "240 KB"):
            validate_message(message(id="m", createdAt="2026-01-02T03:04:05.678Z", payload="x" * 239928))

    def test_date_parse_subset(self):
        self.assertEqual(parse_date("2026-01-02T03:04:05.678Z"), T0)
        self.assertEqual(parse_date("2026-01-02T05:04:05.678+02:00"), T0)
        self.assertEqual(parse_date("-271821-04-20T00:00:00Z"), -8.64e15)
        self.assertEqual(parse_date("2026-02-30"), parse_date("2026-03-02"))
        for bad in ("", "2026-01-02T24:00:01Z", "-000000-01-01", "20260102", "Jan 2 2026", "٢٠٢٦"):
            self.assertIsNone(parse_date(bad), bad)

    def test_failure_limit(self):
        validate_failure_limit(10.0)
        for bad in (0, 11, 1.5, True, "1", None):
            with self.assertRaises(HttpError):
                validate_failure_limit(bad)


class MemoryQueueTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.memory = MemoryQueue(3, 30, now=self.clock)

    def test_limits(self):
        for capacity, lease in ((0, 1), (1.5, 1), (True, 1), (1, 0)):
            with self.assertRaisesRegex(TypeError, "Invalid memory queue limits"):
                MemoryQueue(capacity, lease)

    def test_leases_redeliver_and_stale_old_receipts(self):
        self.memory.publish(message())
        [first] = self.memory.receive(1)
        self.assertEqual(self.memory.receive(10), [])
        self.clock.ms += 30000
        with self.assertRaises(StaleReceipt):
            first.ack()
        [second] = self.memory.receive(1)
        self.assertEqual(second.attempts, 2)
        second.extend(5)
        self.clock.ms += 4999
        second.ack()
        with self.assertRaises(StaleReceipt):
            second.ack()

    def test_retry_keeps_publish_order(self):
        self.memory.publish(message("a"))
        self.memory.publish(message("b"))
        [a] = self.memory.receive(1)
        a.retry(10)
        with self.assertRaisesRegex(TypeError, "Invalid visibility delay"):
            self.memory.receive(1)[0].retry(43201)
        self.clock.ms += 30000
        self.assertEqual([d.message["id"] for d in self.memory.receive(10)], ["a", "b"])

    def test_capacity_and_dead_letters(self):
        for i in range(3):
            self.memory.publish(message(str(i)))
        with self.assertRaisesRegex(QueueError, "Queue capacity exceeded"):
            self.memory.publish(message("x"))
        deliveries = self.memory.receive(3)
        for d in deliveries:
            d.dead_letter()
        self.memory.publish(message("y"))
        with self.assertRaisesRegex(QueueError, "Dead-letter capacity exceeded"):
            self.memory.receive(1)[0].dead_letter()
        items = self.memory.inspect_failures(2)
        self.assertEqual([i["id"] for i in items], ["0", "1"])
        self.memory.retry_failure(items[0]["token"])
        with self.assertRaises(HttpError) as caught:
            self.memory.retry_failure(items[0]["token"])
        self.assertEqual(caught.exception.status, 409)
        self.assertEqual(len(self.memory.dead_letters()), 2)


class QueueTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.memory = MemoryQueue(now=self.clock)
        self.queue = Queue(self.memory, now=self.clock, random=lambda: 0.999999)

    def test_send_uses_the_clock(self):
        self.assertEqual(self.queue.send("email", {"a": 1}, id="job", trace_id=""), "job")
        [d] = self.memory.receive(1)
        self.assertEqual(d.message, {"id": "job", "type": "email", "payload": {"a": 1}, "createdAt": "2026-01-02T03:04:05.678Z"})

    def test_work_once_acks_retries_with_backoff_and_dead_letters(self):
        self.queue.send("x", 1, id="bad")
        self.queue.send("x", 2, id="good")
        seen = []

        def handler(delivery):
            seen.append(delivery.message["id"])
            if delivery.message["id"] == "bad":
                raise ValueError("boom")

        self.assertEqual(self.queue.work_once(handler, max_attempts=2), 2)
        self.clock.ms += 999
        self.assertEqual(self.queue.work_once(handler, max_attempts=2), 0)
        self.clock.ms += 1
        self.assertEqual(self.queue.work_once(handler, max_attempts=2), 1)
        self.assertEqual(sorted(seen), ["bad", "bad", "good"])
        self.assertEqual([m["id"] for m in self.memory.dead_letters()], ["bad"])

    def test_invalid_limits_and_busy_worker(self):
        for options in ({"concurrency": 0}, {"max_attempts": 1.5}, {"base_delay_seconds": 5, "max_delay_seconds": 4}):
            with self.assertRaisesRegex(TypeError, "Invalid worker limits"):
                self.queue.work_once(lambda d: None, **options)
        self.queue.send("x", 1)
        errors = []

        def nested(delivery):
            try:
                self.queue.work_once(lambda d: None)
            except QueueError as error:
                errors.append(error.message)

        self.queue.work_once(nested)
        self.assertEqual(errors, ["Worker already receiving"])

    def test_settlement_failures_are_grouped(self):
        self.queue.send("x", 1)
        with self.assertRaises(ExceptionGroup) as caught:
            self.queue.work_once(lambda d: d.ack())
        self.assertEqual(caught.exception.message, "Queue settlement failed")

    def test_run_stops(self):
        for i in range(3):
            self.queue.send("x", i)
        stop = threading.Event()
        count = []

        def handler(delivery):
            count.append(1)
            if len(count) == 3:
                stop.set()

        self.queue.run(handler, stop, idle_ms=1, concurrency=1)
        self.assertEqual(len(count), 3)
        with self.assertRaisesRegex(TypeError, "Invalid poll interval"):
            self.queue.run(handler, stop, idle_ms=0.5)

    def test_endpoints_in_local_mode(self):
        app = App([self.queue.feature()], local_admin=True)
        status = app.handle(Request("GET", "/admin/app/queue/status"))
        self.assertEqual(status.body["supported"], True)
        self.assertEqual(app.handle(Request("GET", "/queue/status")).status, 401)
        self.assertEqual(app.handle(Request("POST", "/admin/app/queue/failed/inspect", {"limit": 0})).status, 400)
        self.assertEqual(app.handle(Request("POST", "/admin/app/queue/failed/retry", {"token": "x"})).body, {"error": "Message is no longer available; refresh the list"})

    def test_unsupported_adapters_answer_501(self):
        class Plain:
            capabilities = {"delayedRetry": False, "leaseRenewal": False, "durable": True, "failedAdmin": False}

        queue = Queue(Plain())  # type: ignore[arg-type]
        self.assertEqual(queue.status()["supported"], False)
        with self.assertRaises(HttpError) as caught:
            queue.inspect({"limit": 0})
        self.assertEqual(caught.exception.status, 501)


if __name__ == "__main__":
    unittest.main()
