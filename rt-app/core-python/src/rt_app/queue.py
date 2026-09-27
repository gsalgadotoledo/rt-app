"""At-least-once work queue with an in-memory adapter (port of ``@gsalgadotoledo/rt-app-queue``).

    queue = Queue(MemoryQueue())
    queue.send("email", {"to": "a@example.com"})          # → message id
    queue.work_once(handle)                                # handle(delivery) raises to retry
    Queue(adapter).feature()                               # owner DLQ endpoints

Rules shared with TypeScript (see rt-app/docs/polyglot/queue.md and the queue contract):

- Messages are JSON envelopes ``{id, type, payload, createdAt, traceId?}``: ids are non-blank
  strings of at most 200 UTF-16 units, types 120, trace ids 200 (``None`` present is invalid),
  ``createdAt`` a date string ``Date.parse`` accepts, and the canonical JSON at most 240000 UTF-8
  bytes. Validation returns the normalized copy (canonical JSON parsed back).
- ``MemoryQueue`` keeps publish order, leases received messages for ``lease_seconds`` and has no
  deduplication. A delivery is stale once redelivered, retried, settled or at its lease expiry.
- ``Queue.work_once`` runs the handlers concurrently (threads), acknowledges successes, retries
  failures with jittered exponential backoff and dead-letters them at ``max_attempts``.
- Time is epoch milliseconds from an injectable clock (``now``); jitter from ``random``.
"""
from __future__ import annotations

import copy
import math
import random as _random
import re
import threading
import uuid
from collections.abc import Callable, Mapping
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Final, NotRequired, Protocol, TypedDict, runtime_checkable

from . import _canonical, _js, _jsnum
from .contracts import Clock, epoch_ms, js_trim, to_datetime
from .errors import HttpError
from .web.app import Context, Endpoint, Feature

MAX_MESSAGE_BYTES: Final = 240000
MAX_DELAY_SECONDS: Final = 43200
MAX_TOKEN_LENGTH: Final = 400000

INVALID_MESSAGE: Final = "Invalid queue message"
MESSAGE_TOO_LARGE: Final = "Queue message exceeds 240 KB"
LIMIT_MESSAGE: Final = "Limit must be between 1 and 10"
NOT_AVAILABLE: Final = "Message is no longer available; refresh the list"

ADMIN: Final[Mapping[str, Any]] = {
    "id": "queue",
    "title": "Queue",
    "resource": "queue.read",
    "path": "/queue/status",
    "component": "queue",
    "ownerOnly": True,
    "fields": [],
    "actions": [],
}
MIGRATIONS: Final[tuple[Any, ...]] = ()


class QueueMessage(TypedDict):
    id: str
    type: str
    payload: NotRequired[Any]
    createdAt: str
    traceId: NotRequired[str]


class FailedMessage(TypedDict):
    token: str
    id: str
    message: QueueMessage | None
    retryable: bool
    expiresAt: NotRequired[str]


class QueueError(RuntimeError):
    """A queue failure without an HTTP status (TypeScript ``Error``)."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class StaleReceipt(QueueError):
    def __init__(self) -> None:
        super().__init__("Stale queue receipt")


class Aborted(QueueError):
    def __init__(self) -> None:
        super().__init__("This operation was aborted")


class Delivery(Protocol):
    """One received message. Settle it exactly once: ack, retry or dead_letter."""

    message: QueueMessage
    attempts: int

    def ack(self) -> None: ...

    def retry(self, delay_seconds: int) -> None: ...

    def dead_letter(self) -> None: ...

    def extend(self, seconds: int) -> None:
        """Renew long work explicitly. Unsupported brokers raise rather than pretend."""
        ...


@runtime_checkable
class QueueAdapter(Protocol):
    """A broker: MemoryQueue here; SQS and RabbitMQ adapters implement the same surface.

    ``inspect_failures(limit)`` and ``retry_failure(token)`` are optional (``failedAdmin``)."""

    capabilities: Mapping[str, bool]

    def publish(self, message: QueueMessage) -> None: ...

    def receive(self, limit: int, stop: threading.Event | None = None) -> list[Delivery]: ...


# --- validation ------------------------------------------------------------------------------


def _is_integer(value: object) -> bool:
    """``Number.isInteger``: finite, integral, not a bool (``1.0`` counts)."""
    return _js.is_finite_number(value) and float(value).is_integer()  # type: ignore[arg-type]


_DATE = re.compile(
    r"([+-]\d{6}|\d{4})(?:-(\d{2})(?:-(\d{2}))?)?"
    r"(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?"
    r"([Zz]|[+-]\d{2}:?\d{2})?",
    re.ASCII,
)
_MAX_TIME = 8.64e15


def _days_from_civil(year: int, month: int) -> int:
    """Days from 1970-01-01 to the first day of the month (proleptic Gregorian)."""
    y = year - (month <= 2)
    era = y // 400  # floor division, also for negative years
    yoe = y - era * 400
    mp = (month + 9) % 12
    doy = (153 * mp + 2) // 5
    doe = yoe * 365 + yoe // 4 - yoe // 100 + doy
    return era * 146097 + doe - 719468


def parse_date(text: str) -> float | None:
    """``Date.parse`` for the ECMAScript date-time format; ``None`` where it returns NaN.

    Accepts ``YYYY[-MM[-DD]]`` or ``±YYYYYY`` (not ``-000000``), an optional ``[Tt ]HH:mm[:ss[.f]]``
    (``24:00:00`` only as midnight) and an optional ``Z`` or ``±HH[:]mm`` offset, with V8's day
    rollover (``2026-02-30`` is March 2). Times without an offset are read as UTC here (V8 reads
    them as local time; only the ±8.64e15 ms range check can tell). V8's legacy fallback formats
    (``Jan 2 2026``, ``2026/01/02``…) are not accepted.
    """
    match = _DATE.fullmatch(text)
    if not match:
        return None
    y, mo, d, h, mi, s, frac, zone = match.groups()
    if y == "-000000":
        return None
    month, day = int(mo or 1), int(d or 1)
    hour, minute, second = int(h or 0), int(mi or 0), int(s or 0)
    ms = int((frac or "0")[:3].ljust(3, "0"))
    if not (1 <= month <= 12 and 1 <= day <= 31 and minute <= 59 and second <= 59 and hour <= 24):
        return None
    if hour == 24 and (minute or second or ms):
        return None
    offset = 0
    if zone and zone not in "Zz":
        digits = zone[1:].replace(":", "")
        zh, zm = int(digits[:2]), int(digits[2:])
        if zh > 23 or zm > 59:
            return None
        offset = (zh * 60 + zm) * (1 if zone[0] == "+" else -1)
    days = _days_from_civil(int(y), month) + day - 1
    value = ((days * 24 + hour) * 60 + minute - offset) * 60000 + second * 1000 + ms
    return float(value) if abs(value) <= _MAX_TIME else None


def _fail(kind: str) -> TypeError:
    if kind == "object":
        return TypeError("Cache accepts plain objects only")
    return TypeError("Cache requires finite, acyclic JSON values")


def _text(value: object, limit: int) -> bool:
    return isinstance(value, str) and bool(js_trim(value)) and _js.utf16_length(value) <= limit


def validate_message(message: Any) -> QueueMessage:
    """JSON-only envelopes, stable logical ids and bounded payloads across transports.

    Returns the normalized copy (canonical JSON parsed back; unknown fields are kept)."""
    if (
        not isinstance(message, Mapping)
        or not _text(message.get("id"), 200)
        or not _text(message.get("type"), 120)
        or not isinstance(message.get("createdAt"), str)
        or parse_date(message["createdAt"]) is None
        or ("traceId" in message and (not isinstance(message["traceId"], str) or _js.utf16_length(message["traceId"]) > 200))
    ):
        raise TypeError(INVALID_MESSAGE)
    serialized = _canonical.canonical(message, _fail)
    if len(_canonical.utf8(serialized)) > MAX_MESSAGE_BYTES:
        raise TypeError(MESSAGE_TOO_LARGE)
    return _canonical.parse(serialized)


def validate_failure_limit(limit: Any) -> None:
    """Keep broker inspection bounded and predictable: an integer from 1 to 10 (400)."""
    if not _is_integer(limit) or not 1 <= limit <= 10:
        raise HttpError(400, LIMIT_MESSAGE)


def _check_delay(seconds: Any) -> None:
    if not _is_integer(seconds) or not 0 <= seconds <= MAX_DELAY_SECONDS:
        raise TypeError("Invalid visibility delay")


# --- memory adapter ---------------------------------------------------------------------------


@dataclass(eq=False)
class _Entry:
    message: QueueMessage
    attempts: int
    available: float
    receipt: str | None = None


@dataclass(eq=False)
class _MemoryDelivery:
    """A MemoryQueue delivery: operations check the receipt and the lease first."""

    message: QueueMessage
    attempts: int
    _queue: MemoryQueue = field(repr=False)
    _entry: _Entry = field(repr=False)
    _receipt: str = field(repr=False)

    def _check(self) -> None:
        entry = self._entry
        if entry.receipt != self._receipt or not self._queue._holds(entry) or entry.available <= self._queue._now():
            raise StaleReceipt()

    def ack(self) -> None:
        with self._queue._lock:
            self._check()
            self._queue._entries.remove(self._entry)

    def retry(self, delay_seconds: int) -> None:
        with self._queue._lock:
            self._check()
            _check_delay(delay_seconds)
            self._entry.receipt = None
            self._entry.available = self._queue._now() + delay_seconds * 1000

    def extend(self, seconds: int) -> None:
        with self._queue._lock:
            self._check()
            _check_delay(seconds)
            self._entry.available = self._queue._now() + seconds * 1000

    def dead_letter(self) -> None:
        with self._queue._lock:
            self._check()
            if len(self._queue._failed) >= self._queue._capacity:
                raise QueueError("Dead-letter capacity exceeded")
            self._queue._failed.append((str(uuid.uuid4()), self._entry.message))
            self._queue._entries.remove(self._entry)


class MemoryQueue:
    """Bounded ephemeral adapter for development; no durability across process restarts. Thread-safe."""

    def __init__(self, capacity: int = 1000, lease_seconds: int = 30, *, now: Clock | None = None) -> None:
        if not _is_integer(capacity) or capacity < 1 or not _is_integer(lease_seconds) or lease_seconds < 1:
            raise TypeError("Invalid memory queue limits")
        self.capabilities: dict[str, bool] = {"delayedRetry": True, "leaseRenewal": True, "durable": False, "failedAdmin": True}
        self._capacity = capacity
        self._lease_ms = lease_seconds * 1000
        self._clock = now
        self._entries: list[_Entry] = []
        self._failed: list[tuple[str, QueueMessage]] = []
        self._lock = threading.RLock()

    def _now(self) -> float:
        return epoch_ms(self._clock)

    def _holds(self, entry: _Entry) -> bool:
        return any(e is entry for e in self._entries)

    def publish(self, message: QueueMessage) -> None:
        with self._lock:
            if len(self._entries) >= self._capacity:
                raise QueueError("Queue capacity exceeded")
            self._entries.append(_Entry(validate_message(message), 0, self._now()))

    def receive(self, limit: int, stop: threading.Event | None = None) -> list[Delivery]:
        """Lease up to ``limit`` (1-10) visible messages in publish order."""
        if stop is not None and stop.is_set():
            raise Aborted()
        if not _is_integer(limit) or not 1 <= limit <= 10:
            raise TypeError("Invalid receive limit")
        with self._lock:
            now = self._now()
            deliveries: list[Delivery] = []
            for entry in [e for e in self._entries if e.available <= now][: int(limit)]:
                entry.receipt = str(uuid.uuid4())
                entry.attempts += 1
                entry.available = self._now() + self._lease_ms
                deliveries.append(_MemoryDelivery(copy.deepcopy(entry.message), entry.attempts, self, entry, entry.receipt))
            return deliveries

    def inspect_failures(self, limit: int) -> list[FailedMessage]:
        """Local inspection is a non-destructive bounded snapshot."""
        validate_failure_limit(limit)
        with self._lock:
            return [
                {"token": token, "id": message["id"], "message": copy.deepcopy(message), "retryable": True}
                for token, message in self._failed[: int(limit)]
            ]

    def retry_failure(self, token: Any) -> None:
        """Atomically move a failed message back to pending; a reused token cannot enqueue twice."""
        with self._lock:
            index = next((i for i, (t, _) in enumerate(self._failed) if isinstance(token, str) and t == token), -1)
            if index < 0:
                raise HttpError(409, NOT_AVAILABLE)
            if len(self._entries) >= self._capacity:
                raise HttpError(409, "Queue capacity exceeded")
            self._entries.append(_Entry(self._failed[index][1], 0, self._now()))
            del self._failed[index]

    def dead_letters(self) -> list[QueueMessage]:
        """Diagnostic copies only; production dead letters belong to the broker's configured DLQ."""
        with self._lock:
            return copy.deepcopy([message for _, message in self._failed])


# --- worker -----------------------------------------------------------------------------------

Handler = Callable[[Delivery], Any]


class Queue:
    """At-least-once delivery. Handlers own business idempotency; enqueue acceptance is not completion."""

    def __init__(self, adapter: QueueAdapter, *, now: Clock | None = None, random: Callable[[], float] | None = None) -> None:
        self.adapter = adapter
        self._clock = now
        self._random = random or _random.random
        self._lock = threading.Lock()
        self._working = False

    def send(self, type: str, payload: Any, *, id: str | None = None, trace_id: str | None = None) -> str:
        """Publish and return the logical message id. Reuse a supplied id on retries."""
        message: dict[str, Any] = {
            "id": str(uuid.uuid4()) if id is None else id,
            "type": type,
            "payload": payload,
            "createdAt": _js.iso_timestamp(to_datetime(epoch_ms(self._clock))),
        }
        if _jsnum.truthy(trace_id):
            message["traceId"] = trace_id
        validated = validate_message(message)
        self.adapter.publish(validated)
        return validated["id"]

    def work_once(
        self,
        handler: Handler,
        *,
        concurrency: int | None = None,
        max_attempts: int | None = None,
        base_delay_seconds: int | None = None,
        max_delay_seconds: int | None = None,
        stop: threading.Event | None = None,
    ) -> int:
        """Pull only as many messages as can run; acknowledge strictly after successful work.

        Returns the number of deliveries. Settlement failures (ack, retry, dead-letter) are raised
        together after every delivery settled, as ``ExceptionGroup("Queue settlement failed")``."""
        limit = 4 if concurrency is None else concurrency
        attempts_max = 5 if max_attempts is None else max_attempts
        base = 1 if base_delay_seconds is None else base_delay_seconds
        cap = 60 if max_delay_seconds is None else max_delay_seconds
        if (
            not _is_integer(limit)
            or not 1 <= limit <= 10
            or not _is_integer(attempts_max)
            or attempts_max < 1
            or not all(_is_integer(n) and 0 <= n <= MAX_DELAY_SECONDS for n in (base, cap))
            or base > cap
        ):
            raise TypeError("Invalid worker limits")
        with self._lock:
            if self._working:
                raise QueueError("Worker already receiving")
            self._working = True
        try:
            if stop is not None and stop.is_set():
                raise Aborted()
            deliveries = self.adapter.receive(int(limit), stop)
            if not deliveries:
                return 0
            delayed = bool(self.adapter.capabilities.get("delayedRetry"))

            def settle(delivery: Delivery) -> None:
                try:
                    handler(delivery)
                except Exception:  # noqa: BLE001 - any handler failure retries the message
                    if delivery.attempts >= attempts_max:
                        delivery.dead_letter()
                    else:
                        ceiling = min(cap, base * 2 ** min(delivery.attempts - 1, 20))
                        delivery.retry(math.floor(self._random() * (ceiling + 1)) if delayed else 0)
                    return
                # If acknowledgement fails, do not immediately retry a successful side effect.
                delivery.ack()

            with ThreadPoolExecutor(max_workers=len(deliveries), thread_name_prefix="rt-queue") as pool:
                futures = [pool.submit(settle, d) for d in deliveries]
            failures = [f.exception() for f in futures if f.exception() is not None]
            if failures:
                raise ExceptionGroup("Queue settlement failed", failures)  # type: ignore[arg-type]
            return len(deliveries)
        finally:
            with self._lock:
                self._working = False

    def run(self, handler: Handler, stop: threading.Event, *, idle_ms: float | None = None, **options: Any) -> None:
        """Work until ``stop`` is set; sleep ``idle_ms`` when nothing was received.

        Setting ``stop`` stops new pulls; current work drains. Errors after a stop are swallowed."""
        idle = 250 if idle_ms is None else idle_ms
        if not _js.is_finite_number(idle) or idle < 1:
            raise TypeError("Invalid poll interval")
        while not stop.is_set():
            try:
                if not self.work_once(handler, stop=stop, **options):
                    stop.wait(idle / 1000)
            except Exception:
                if stop.is_set():
                    return
                raise

    # --- endpoints ---------------------------------------------------------------------------

    def status(self) -> dict[str, Any]:
        return {"supported": self._supported(), "capabilities": self.adapter.capabilities}

    def inspect(self, body: Mapping[str, Any]) -> dict[str, Any]:
        inspect_failures = getattr(self.adapter, "inspect_failures", None)
        if not self._supported() or inspect_failures is None:
            raise HttpError(501, "Failed-message inspection is not configured")
        limit = body.get("limit") if isinstance(body, Mapping) else None
        limit = 10 if limit is None else limit
        if not _is_integer(limit) or not 1 <= limit <= 10:
            raise HttpError(400, LIMIT_MESSAGE)
        return {"items": inspect_failures(int(limit))}

    def retry_failed(self, body: Mapping[str, Any]) -> dict[str, Any]:
        retry_failure = getattr(self.adapter, "retry_failure", None)
        if not self._supported() or retry_failure is None:
            raise HttpError(501, "Failed-message retry is not configured")
        token = body.get("token") if isinstance(body, Mapping) else None
        if not isinstance(token, str) or not token or _js.utf16_length(token) > MAX_TOKEN_LENGTH:
            raise HttpError(400, "Invalid retry token")
        retry_failure(token)
        return {"queued": True}

    def _supported(self) -> bool:
        return self.adapter.capabilities.get("failedAdmin") is True

    def feature(self) -> Feature:
        """Owner-only DLQ controls. Inspection is POST because brokers may reserve messages."""
        return Feature(
            id="queue",
            admin=ADMIN,
            endpoints=[
                Endpoint("GET", "/queue/status", "queue.read", "owner", lambda c: self.status()),
                Endpoint("POST", "/queue/failed/inspect", "queue.inspect", "owner", lambda c: self.inspect(_body(c))),
                Endpoint("POST", "/queue/failed/retry", "queue.retry", "owner", lambda c: self.retry_failed(_body(c))),
            ],
        )


def _body(context: Context) -> Mapping[str, Any]:
    body = context.request.body
    return body if isinstance(body, Mapping) else {}


__all__ = [
    "ADMIN",
    "MIGRATIONS",
    "Aborted",
    "Delivery",
    "FailedMessage",
    "MemoryQueue",
    "Queue",
    "QueueAdapter",
    "QueueError",
    "QueueMessage",
    "StaleReceipt",
    "parse_date",
    "validate_failure_limit",
    "validate_message",
]
