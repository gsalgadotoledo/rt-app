"""Subject: queue (mirrors hosts/node/queue.mjs). Not named queue.py: this folder is on sys.path
and would shadow the standard library module `queue`.

A facade over Queue(adapter, now=clock, random=jitter) on a MemoryQueue with a settable ISO clock.
The facade adapter numbers every delivery it hands out (receive, work_once, run) 0, 1, 2…;
ack/retry/extend/deadLetter take that number. See docs/polyglot/queue.md.
"""
from __future__ import annotations

import threading
import time
from collections.abc import Mapping
from datetime import datetime, timedelta, timezone
from typing import Any

from rt_app.queue import MemoryQueue, Queue, validate_failure_limit, validate_message

_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
# Wire option names → keyword arguments.
_WORKER_OPTIONS = {
    "concurrency": "concurrency",
    "maxAttempts": "max_attempts",
    "baseDelaySeconds": "base_delay_seconds",
    "maxDelaySeconds": "max_delay_seconds",
}


def _parse_iso(value: Any, what: str) -> int:
    try:
        if isinstance(value, str):
            value = datetime.fromisoformat(value[:-1] + "+00:00" if value.endswith(("Z", "z")) else value)
        if not isinstance(value, datetime):
            raise ValueError
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return (value - _EPOCH) // timedelta(milliseconds=1)
    except (ValueError, TypeError):
        raise TypeError(f"{what} must be an ISO 8601 date") from None


class _Clock:
    """A settable clock in epoch milliseconds starting at init.now; the system clock when absent."""

    def __init__(self, now: Any) -> None:
        self.fixed: int | None = None if now is None else _parse_iso(now, "init.now")

    def __call__(self) -> int:
        return time.time_ns() // 1_000_000 if self.fixed is None else self.fixed

    def set(self, iso: Any) -> None:
        self.fixed = _parse_iso(iso, "setNow")


class _Adapter:
    """Delegates to the MemoryQueue, records deliveries and may declare other capabilities."""

    def __init__(self, memory: MemoryQueue, capabilities: Any) -> None:
        self.memory = memory
        self.capabilities = capabilities if isinstance(capabilities, Mapping) else memory.capabilities
        self.deliveries: list[Any] = []
        self._lock = threading.Lock()

    def publish(self, message: Any) -> None:
        self.memory.publish(message)

    def receive(self, limit: Any, stop: threading.Event | None = None) -> list[Any]:
        deliveries = self.memory.receive(limit, stop)
        with self._lock:
            self.deliveries.extend(deliveries)
        return deliveries

    def number(self, delivery: Any) -> int:
        with self._lock:
            return next(i for i, d in enumerate(self.deliveries) if d is delivery)

    def inspect_failures(self, limit: Any) -> Any:
        return self.memory.inspect_failures(limit)

    def retry_failure(self, token: Any) -> None:
        self.memory.retry_failure(token)


def _worker_options(options: Any) -> dict[str, Any]:
    options = options if isinstance(options, Mapping) else {}
    return {kw: options[name] for name, kw in _WORKER_OPTIONS.items() if options.get(name) is not None}


class QueueFacade:
    def __init__(self, init: Any) -> None:
        init = init if isinstance(init, dict) else {}
        self._clock = _Clock(init.get("now"))
        capacity, lease = init.get("capacity"), init.get("leaseSeconds")
        self._memory = MemoryQueue(1000 if capacity is None else capacity, 30 if lease is None else lease, now=self._clock)
        self._adapter = _Adapter(self._memory, init.get("capabilities"))
        jitter = init.get("random")
        self._queue = Queue(self._adapter, now=self._clock, random=(lambda: jitter) if isinstance(jitter, (int, float)) else None)
        self._log: list[dict[str, Any]] = []
        self._log_lock = threading.Lock()

    def _delivery(self, n: Any) -> Any:
        if not isinstance(n, int) or isinstance(n, bool) or not 0 <= n < len(self._adapter.deliveries):
            raise TypeError(f"Unknown delivery {n}")
        return self._adapter.deliveries[n]

    def _wire(self, delivery: Any) -> dict[str, Any]:
        return {"delivery": self._adapter.number(delivery), "attempts": delivery.attempts, "message": delivery.message}

    def _handler(self, outcomes: Any, after: Any = None) -> Any:
        """outcomes[messageId]: "ok" (default), "fail", "ack" (acks itself) or "nested"."""
        outcomes = outcomes if isinstance(outcomes, Mapping) else {}

        def handle(delivery: Any) -> None:
            entry: dict[str, Any] = {"delivery": self._adapter.number(delivery), "id": delivery.message["id"], "attempts": delivery.attempts}
            with self._log_lock:
                self._log.append(entry)
            try:
                outcome = outcomes.get(delivery.message["id"]) or "ok"
                if outcome == "fail":
                    raise RuntimeError("fail")
                if outcome == "ack":
                    delivery.ack()
                if outcome == "nested":
                    try:
                        self._queue.work_once(lambda d: None)
                        entry["nested"] = {"value": "no error"}
                    except Exception as error:  # noqa: BLE001 - logged for the contract
                        entry["nested"] = {"error": getattr(error, "message", str(error))}
            finally:
                if after:
                    after()

        return handle

    # Adapter surface.
    def publish(self, message: Any) -> None:
        self._adapter.publish(message)

    def receive(self, limit: Any) -> list[dict[str, Any]]:
        return [self._wire(d) for d in self._adapter.receive(limit)]

    def ack(self, n: Any) -> None:
        self._delivery(n).ack()

    def retry(self, n: Any, seconds: Any) -> None:
        self._delivery(n).retry(seconds)

    def extend(self, n: Any, seconds: Any) -> None:
        self._delivery(n).extend(seconds)

    def dead_letter(self, n: Any) -> None:
        self._delivery(n).dead_letter()

    def inspect_failures(self, limit: Any) -> Any:
        return self._adapter.inspect_failures(limit)

    def retry_failure(self, token: Any) -> None:
        self._adapter.retry_failure(token)

    def dead_letters(self) -> Any:
        return self._memory.dead_letters()

    def capabilities(self) -> Any:
        return self._adapter.capabilities

    # Queue surface.
    def send(self, type: Any, payload: Any, options: Any = None) -> str:
        options = options if isinstance(options, Mapping) else {}
        return self._queue.send(type, payload, id=options.get("id"), trace_id=options.get("traceId"))

    def work_once(self, outcomes: Any, options: Any = None) -> int:
        return self._queue.work_once(self._handler(outcomes), **_worker_options(options))

    def run(self, outcomes: Any, options: Any, stop_after: Any) -> None:
        stop = threading.Event()
        handled = [0]
        if not (isinstance(stop_after, (int, float)) and stop_after > 0):
            stop.set()

        def after() -> None:
            handled[0] += 1
            if handled[0] >= stop_after:
                stop.set()

        idle = options.get("idleMs") if isinstance(options, Mapping) else None
        self._queue.run(self._handler(outcomes, after), stop, idle_ms=idle, **_worker_options(options))

    def handled(self) -> list[dict[str, Any]]:
        return sorted(self._log, key=lambda e: e["delivery"])

    # Endpoint handlers (null bodies are {}).
    def status(self) -> Any:
        return self._queue.status()

    def inspect(self, body: Any = None) -> Any:
        return self._queue.inspect(body if isinstance(body, Mapping) else {})

    def retry_failed(self, body: Any = None) -> Any:
        return self._queue.retry_failed(body if isinstance(body, Mapping) else {})

    def endpoints(self) -> list[dict[str, str]]:
        return [{"method": e.method, "path": e.path, "resource": e.resource, "access": e.access} for e in self._queue.feature().endpoints]

    def admin(self) -> Any:
        return self._queue.feature().admin

    def migrations(self) -> list[Any]:
        return []

    # Pure helpers.
    def validate_message(self, message: Any) -> Any:
        return validate_message(message)

    def validate_failure_limit(self, limit: Any) -> None:
        validate_failure_limit(limit)

    def set_now(self, iso: Any) -> None:
        self._clock.set(iso)


SUBJECTS = {"queue": QueueFacade}
