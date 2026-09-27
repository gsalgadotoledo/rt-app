"""Observer: logs, metrics and events delivered to outputs (TypeScript is the reference).

``Observer(outputs, timeout_ms=1500, *, now=clock, new_id=uuid4)`` builds one sanitized event per
call and delivers it to every subscribed output in parallel, each bounded by ``timeout_ms`` and a
per-minute budget. Delivery failures only count in ``observer.health``; they never reach the caller
and never reveal their message. ``ObserverStore(store, now=clock)`` keeps events in daily NoSQL
partitions with a seven-day TTL and answers reports and log searches; ``observer_feature`` serves
them (``GET /admin/app/observer/report|logs`` for the owner, ``POST /observer/events`` for page
views)::

    storage = ObserverStore(MemoryStore())
    observer = Observer([Output(storage), Output(ConsoleOutput(), levels=["info", "warn", "error"])])
    observer.info("Import completed", {"count": 42})
    with_request = observer.with_context({"requestId": "r1"}, lambda: observer.error("Declined"))
    app = App([observer_feature(observer, storage)], local_admin=True)

The log context (``category``, ``requestId``, ``sessionId``) lives in a ``contextvars.ContextVar``,
so concurrent requests (threads or tasks) never mix their fields. Everything is synchronous;
handlers may return awaitables, which run on the shared event loop.
"""
from __future__ import annotations

import contextvars
import copy
import hashlib
import inspect
import math
import re
import threading
import time
import urllib.error
import urllib.request
import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Final, Literal, Protocol, TypedDict, TypeVar

from .. import _js
from .._jsnum import js_round, js_string, utf16_slice, utf8
from ..contracts import JS_WHITESPACE, Clock, epoch_ms, to_datetime
from ..errors import HttpError
from ..nosql import NoSQL
from ..web.app import Context, Endpoint, Feature
from . import _url
from ._json import ordered_items, stringify

T = TypeVar("T")

LogLevel = Literal["debug", "info", "warn", "error"]
EventKind = Literal["log", "request", "pageview", "timing", "analytics"]
LEVELS: Final = ("debug", "info", "warn", "error")
KINDS: Final = ("log", "request", "pageview", "timing", "analytics")
CONTEXT_KEYS: Final = ("category", "requestId", "sessionId")
DEFAULT_TIMEOUT_MS: Final = 1500
DEFAULT_PER_MINUTE: Final = 600
MAX_IN_FLIGHT: Final = 32
TTL_SECONDS: Final = 7 * 86400
PARTITION: Final = "OBSERVER#"

_BASE = _url.parse("http://observer.local")


# ---------------------------------------------------------------- redaction


_WS = JS_WHITESPACE
_FLAGS = re.IGNORECASE | re.ASCII  # JavaScript /i without /u folds ASCII letters only
_BEARER = re.compile(f"Bearer[{_WS}]+[^{_WS}]+", _FLAGS)
_EMAIL = re.compile(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", _FLAGS)
_KEY_VALUE = re.compile(f"((?:password|token|secret|api[_-]?key)[{_WS}]*[=:][{_WS}]*)[^{_WS},;]+", _FLAGS)
_SECRET_KEY = re.compile(r"password|secret|token|authorization|cookie|credential|email|phone|body|headers|ip|code", _FLAGS)


def sanitize(value: Any, depth: int = 0) -> Any:
    """Redact secret keys and strings and bound sizes (1000 units, 20 items, 30 keys, depth 4)."""
    if depth > 4:
        return "[truncated]"
    if isinstance(value, BaseException):
        return {"name": type(value).__name__}
    if isinstance(value, str):
        text = utf16_slice(value, 1000)
        text = _BEARER.sub("Bearer [redacted]", text)
        text = _EMAIL.sub("[email]", text)
        return _KEY_VALUE.sub(r"\1[redacted]", text)
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, (list, tuple)):
        return [sanitize(item, depth + 1) for item in list(value)[:20]]
    if isinstance(value, Mapping):
        return {
            key: "[redacted]" if _SECRET_KEY.search(key) else sanitize(item, depth + 1)
            for key, item in ordered_items(value)[:30]
        }
    return str(value)


def safe_path(value: str) -> str:
    """The path of an HTTP URL or path (``new URL(value, "http://observer.local")``), 160 units.

    Raises ``ValueError``: "Invalid URL" when it does not parse, "Observer expects an HTTP URL or
    path" for other schemes. Credentials, host, query and fragment are dropped.
    """
    url = _url.parse(value, _BASE)
    if url.scheme not in ("http", "https"):
        raise ValueError("Observer expects an HTTP URL or path")
    return utf16_slice(url.pathname, 160)


# ---------------------------------------------------------------- events and outputs


class ObserverEvent(TypedDict, total=False):
    category: str
    id: str
    at: str
    level: str
    kind: str
    source: str
    message: str
    data: dict[str, Any]
    requestId: str
    sessionId: str


class OutputHandler(Protocol):
    """A destination. ``write`` gets its own copy of the event; ``signal`` is set on timeout."""

    id: str

    def write(self, event: ObserverEvent, signal: threading.Event | None = None) -> object: ...


@dataclass
class Output:
    """A subscription: ``None`` lists mean every level, kind, source or category.

    ``filter`` is trusted synchronous server code (never received from clients); it gets a copy.
    ``max_per_minute`` defaults to 600 per clock minute; 0 drops everything.
    """

    handler: OutputHandler
    enabled: bool = True
    levels: Sequence[str] | None = None
    kinds: Sequence[str] | None = None
    sources: Sequence[str] | None = None
    categories: Sequence[str] | None = None
    max_per_minute: int | None = None
    filter: Callable[[ObserverEvent], object] | None = None


class RequestMetric(TypedDict):
    method: str
    url: str
    durationMs: float
    status: int


def _resolve(value: object) -> object:
    return _js.run_sync(value) if inspect.isawaitable(value) else value  # type: ignore[arg-type]


class Observer:
    """Structured logs, request metrics, page views and timings with isolated delivery."""

    def __init__(
        self,
        outputs: Sequence[Output] = (),
        timeout_ms: float = DEFAULT_TIMEOUT_MS,
        *,
        now: Clock | None = None,
        new_id: Callable[[], str] | None = None,
    ) -> None:
        outputs = list(outputs)
        if len({output.handler.id for output in outputs}) != len(outputs):
            raise ValueError("Duplicate observer output id")
        self.outputs = outputs
        self.timeout_ms = timeout_ms
        self._now = now
        self._new_id = new_id or (lambda: str(uuid.uuid4()))
        self.health = {"failed": 0, "dropped": 0}
        self._lock = threading.Lock()
        self._in_flight = 0
        self._budgets: dict[str, dict[str, int]] = {}
        self._context: contextvars.ContextVar[dict[str, Any]] = contextvars.ContextVar(f"rt_app_observer_{id(self)}", default={})
        self.console = _Console(self)

    # Context -------------------------------------------------------------------------------

    def with_context(self, context: Mapping[str, Any] | None, operation: Callable[[], T]) -> T:
        """Run ``operation`` with ``context`` merged over the current log context."""
        token = self._context.set({**self._context.get(), **(context or {})})
        try:
            return operation()
        finally:
            self._context.reset(token)

    def write(self, level: str, message: str, context: Mapping[str, Any] | None = None, data: Mapping[str, Any] | None = None) -> None:
        """A structured log (kind "log", source "app") under an explicit context."""
        self.with_context(context or {}, lambda: self.emit(level, "log", "app", message, {} if data is None else data))

    # Delivery ------------------------------------------------------------------------------

    def _count(self, key: str) -> None:
        with self._lock:
            self.health[key] += 1

    def emit(self, level: str, kind: str, source: str, message: Any, data: Any = None) -> None:
        """Build one sanitized event and deliver it to the subscribed outputs (never raises for them)."""
        if not any(output.enabled is not False for output in self.outputs):
            return
        with self._lock:
            if self._in_flight >= MAX_IN_FLIGHT:
                self.health["dropped"] += 1
                return
            self._in_flight += 1
        try:
            event = self._event(level, kind, source, message, {} if data is None else data)
            pending = [self._deliver(output, level, kind, source, event) for output in self.outputs]
            for finish in pending:
                if finish is not None:
                    finish()
        finally:
            with self._lock:
                self._in_flight -= 1

    def _event(self, level: str, kind: str, source: str, message: Any, data: Any) -> ObserverEvent:
        event: dict[str, Any] = {
            "category": "app",
            "id": self._new_id(),
            "at": _js.iso_timestamp(to_datetime(epoch_ms(self._now))),
            "level": level,
            "kind": kind,
            "source": utf16_slice(source, 80),
            "message": js_string(sanitize(message)),
            "data": sanitize(data),
        }
        for key, value in self._context.get().items():
            if key in CONTEXT_KEYS and isinstance(value, str):
                event[key] = utf16_slice(js_string(sanitize(value)), 120)
        return event  # type: ignore[return-value]

    def _deliver(self, output: Output, level: str, kind: str, source: str, event: ObserverEvent) -> Callable[[], None] | None:
        """Checks run in order (subscription, filter, budget); the write runs on a daemon thread."""
        if (
            output.enabled is False
            or (output.levels is not None and level not in output.levels)
            or (output.kinds is not None and kind not in output.kinds)
            or (output.sources is not None and source not in output.sources)
            or (output.categories is not None and event.get("category", "") not in output.categories)
        ):
            return None
        if output.filter is not None:
            try:
                if not output.filter(copy.deepcopy(event)):
                    return None
            except Exception:  # noqa: BLE001 - a broken predicate is a failed delivery
                self._count("failed")
                return None
        if not self._spend(output):
            return None
        signal, done = threading.Event(), threading.Event()
        outcome = {"ok": False}
        copied = copy.deepcopy(event)
        deadline = time.monotonic() + self.timeout_ms / 1000

        def work() -> None:
            try:
                _resolve(output.handler.write(copied, signal))
                # Like Promise.race: a write that ends after the timeout has already failed.
                outcome["ok"] = time.monotonic() <= deadline
            except BaseException:  # noqa: BLE001 - failures stay private
                outcome["ok"] = False
            finally:
                done.set()

        threading.Thread(target=work, name=f"rt-app-observer-{output.handler.id}", daemon=True).start()

        def finish() -> None:
            # Outputs are awaited one after the other: a write that already ended in time counts.
            if not done.wait(max(0.0, deadline - time.monotonic())):
                signal.set()
                self._count("failed")
            elif not outcome["ok"]:
                self._count("failed")

        return finish

    def _spend(self, output: Output) -> bool:
        """Per-output budget per clock minute; over budget counts as dropped."""
        minute = math.floor(epoch_ms(self._now) / 60000)
        limit = DEFAULT_PER_MINUTE if output.max_per_minute is None else output.max_per_minute
        with self._lock:
            budget = self._budgets.get(output.handler.id)
            if budget is None or budget["minute"] != minute:
                budget = {"minute": minute, "count": 0}
                self._budgets[output.handler.id] = budget
            budget["count"] += 1
            if budget["count"] - 1 >= limit:
                self.health["dropped"] += 1
                return False
        return True

    # Helpers -------------------------------------------------------------------------------

    def _write_log(self, level: str, values: tuple[Any, ...]) -> None:
        first = values[0] if values else None
        rest = list(values[1:])
        metadata = rest[0] if rest and isinstance(rest[0], Mapping) else {}
        context = {key: metadata[key] for key in CONTEXT_KEYS if isinstance(metadata.get(key), str)}
        is_text = bool(values) and isinstance(first, str)
        self.with_context(
            context,
            lambda: self.emit(level, "log", "app", first if is_text else "Application log", {"values": rest if is_text else list(values)}),
        )

    def log(self, *values: Any) -> None:
        self._write_log("info", values)

    def info(self, *values: Any) -> None:
        self._write_log("info", values)

    def debug(self, *values: Any) -> None:
        self._write_log("debug", values)

    def warn(self, *values: Any) -> None:
        self._write_log("warn", values)

    def warning(self, *values: Any) -> None:
        self.warn(*values)

    def error(self, *values: Any) -> None:
        self._write_log("error", values)

    def count_view(self, message: str, options: Mapping[str, Any]) -> None:
        """A page view ``{url, apiUrl?, source="spa"}`` in the analytics category (paths only)."""
        source = options.get("source")
        source = "spa" if source is None else source

        def run() -> None:
            data = {"path": safe_path(options.get("url"))}  # type: ignore[arg-type]
            api_url = options.get("apiUrl")
            if api_url:
                data["endpointPath"] = safe_path(api_url)
            self.emit("info", "pageview", source, message, data)

        self.with_context({"category": "analytics"}, run)

    def record_request(self, metric: Mapping[str, Any]) -> None:
        """An API request ``{method, url, durationMs, status}``; the level follows the status."""
        duration, status = metric.get("durationMs"), metric.get("status")
        if not (
            _js.is_finite_number(duration)
            and duration >= 0  # type: ignore[operator]
            and _js.is_finite_number(status)
            and float(status).is_integer()  # type: ignore[arg-type]
            and 100 <= status <= 599  # type: ignore[operator]
        ):
            raise ValueError("Invalid request metric")
        level = "error" if status >= 500 else "warn" if status >= 400 else "info"  # type: ignore[operator]
        data = {"method": metric["method"].upper(), "path": safe_path(metric["url"]), "status": status, "durationMs": duration}
        self.emit(level, "request", "api", "HTTP request", data)

    def measure(self, name: str, operation: Callable[[], T], source: str | None = None) -> T:
        """Return the operation's result (or raise its error unchanged) and record its duration."""
        start = self._elapsed()
        failed = False
        try:
            return _resolve(operation())  # type: ignore[return-value]
        except BaseException:
            failed = True
            raise
        finally:
            self.emit(
                "error" if failed else "info",
                "timing",
                "app" if source is None else source,
                name,
                {"name": name, "durationMs": self._elapsed() - start, "failed": failed},
            )

    def _elapsed(self) -> float:
        """Milliseconds from the injected clock, or a monotonic clock by default."""
        return epoch_ms(self._now) if self._now is not None else time.perf_counter() * 1000


class _Console:
    """``observer.console``: the logging helpers under console names (does not patch print)."""

    def __init__(self, observer: Observer) -> None:
        self.log, self.info, self.debug = observer.log, observer.info, observer.debug
        self.warn, self.error = observer.warn, observer.error


# ---------------------------------------------------------------- log queries


_DAY = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")
_DAYS_IN_MONTH = (31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)


class LogQuery(TypedDict, total=False):
    day: str
    level: str
    category: str
    requestId: str
    sessionId: str
    text: str
    cursor: str


def valid_day(day: object) -> bool:
    """``YYYY-MM-DD`` naming a real proleptic Gregorian date (year 0000 included)."""
    if not isinstance(day, str) or not _DAY.fullmatch(day):
        return False
    year, month, date = int(day[:4]), int(day[5:7]), int(day[8:])
    if not 1 <= month <= 12 or date < 1:
        return False
    leap = year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)
    return date <= (29 if month == 2 and leap else _DAYS_IN_MONTH[month - 1])


def validate_log_query(query: Mapping[str, Any]) -> None:
    """400 "Invalid day", "Invalid level" or "Invalid log filter", checked in that order."""
    if not valid_day(query.get("day")):
        raise HttpError(400, "Invalid day")
    level = query.get("level")
    if _truthy(level) and level not in LEVELS:
        raise HttpError(400, "Invalid level")
    for key in ("category", "requestId", "sessionId", "text", "cursor"):
        value = query.get(key)
        if value is not None and (not isinstance(value, str) or _js.utf16_length(value) > (8192 if key == "cursor" else 200)):
            raise HttpError(400, "Invalid log filter")


def matches_log(event: Mapping[str, Any], query: Mapping[str, Any]) -> bool:
    """Level (debug hidden by default), exact correlation filters and a text search of the JSON."""
    level = query.get("level")
    if not (event.get("level") != "debug" if not _truthy(level) else event.get("level") == level):
        return False
    for key in ("category", "requestId", "sessionId"):
        if _truthy(query.get(key)) and event.get(key) != query[key]:
            return False
    text = query.get("text")
    return not _truthy(text) or text.lower() in stringify(event).lower()


def _truthy(value: object) -> bool:
    return value is not None and value is not False and value != "" and value != 0


# ---------------------------------------------------------------- storage


def _parse_at(at: object) -> float | None:
    """``Date.parse`` of the ISO 8601 forms events use; None (NaN) for anything else."""
    if not isinstance(at, str):
        return None
    try:
        moment = datetime.fromisoformat(at[:-1] + "+00:00" if at.endswith("Z") else at)
    except ValueError:
        return None
    if moment.tzinfo is None:
        if len(at) != 10:
            return None  # JavaScript reads date-times without an offset as local time
        moment = moment.replace(tzinfo=timezone.utc)  # a date alone is UTC midnight
    return moment.timestamp() * 1000


def _number(value: Any, present: bool = True) -> float:
    """JavaScript ``Number(value)`` for JSON values (missing is NaN)."""
    if not present:
        return math.nan
    if value is None or value is False:
        return 0.0
    if value is True:
        return 1.0
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, list):
        value = js_string(value)
    if isinstance(value, str):
        text = value.strip(_WS)
        if text == "":
            return 0.0
        try:
            if re.fullmatch(r"[+-]?(Infinity|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)", text):
                return float(text.replace("Infinity", "inf"))
            if re.fullmatch(r"0[xX][0-9a-fA-F]+|0[oO][0-7]+|0[bB][01]+", text):
                return float(int(text, 0))
        except ValueError:
            return math.nan
    return math.nan


def _field(data: Mapping[str, Any], key: str) -> str:
    """``String(data[key])`` where a missing field is "undefined"."""
    return js_string(data[key]) if key in data else "undefined"


class ObserverStore:
    """Daily partitions with a seven-day TTL; bounded reads report partial results explicitly."""

    id = "store"

    def __init__(self, store: NoSQL, *, now: Clock | None = None) -> None:
        self.store = store
        self._now = now

    def write(self, event: Mapping[str, Any], signal: threading.Event | None = None) -> None:
        """Create the event row (a duplicate is a Conflict)."""
        at = event["at"]
        parsed = _parse_at(at)
        self.store.transact([
            {
                "row": {
                    "pk": PARTITION + at[:10],
                    "sk": at + "#" + event["id"],
                    "version": 1,
                    "ttl": None if parsed is None else math.floor(parsed / 1000) + TTL_SECONDS,
                    "data": dict(event),
                },
                "expected": None,
            }
        ])

    def _live(self, rows: list[Any]) -> list[dict[str, Any]]:
        now = epoch_ms(self._now) / 1000
        return [row["data"] for row in rows if not row.get("ttl") or row["ttl"] > now]

    def search(self, query: Mapping[str, Any]) -> dict[str, Any]:
        """One storage page per call; a filtered page can be empty with a continuation cursor."""
        validate_log_query(query)
        page = self.store.list(PARTITION + query["day"], query.get("cursor"))
        result: dict[str, Any] = {"events": [event for event in self._live(page["items"]) if matches_log(event, query)]}
        if page.get("cursor"):
            result["cursor"] = page["cursor"]
        return result

    def report(self, day: object) -> dict[str, Any]:
        """Totals, rankings, metrics and the newest 100 of at most 20 pages of one UTC day."""
        if not valid_day(day):
            raise HttpError(400, "Invalid day")
        events: list[dict[str, Any]] = []
        cursor = None
        for _ in range(20):
            page = self.store.list(PARTITION + str(day), cursor)
            events.extend(self._live(page["items"]))
            cursor = page.get("cursor")
            if not cursor:
                break
        return _Report(events).build(str(day), bool(cursor))


class _Report:
    """The aggregation of ObserverStore.report (JavaScript Number and String semantics)."""

    def __init__(self, events: list[dict[str, Any]]) -> None:
        self.events = events
        self.counts = {"requests": 0, "errors": 0, "spa": 0, "ssr": 0}
        self.hours = [{"hour": hour, "requests": 0, "views": 0} for hour in range(24)]
        self.pages: dict[str, dict[str, Any]] = {}
        self.analytics: dict[Any, dict[str, Any]] = {}
        self.requests: dict[str, dict[str, Any]] = {}
        self.operations: dict[str, dict[str, Any]] = {}
        self.duration = 0.0

    @staticmethod
    def _aggregate(metrics: dict[str, dict[str, Any]], key: str, label: str, ms: Any, failed: bool, source: Any) -> None:
        if not _js.is_finite_number(ms) or ms < 0:
            return
        metric = metrics.setdefault(key, {"name": label, "source": source, "count": 0, "totalMs": 0.0, "minMs": ms, "maxMs": ms, "errors": 0})
        metric["count"] += 1
        metric["totalMs"] += ms
        metric["minMs"] = min(metric["minMs"], ms)
        metric["maxMs"] = max(metric["maxMs"], ms)
        if failed:
            metric["errors"] += 1

    @staticmethod
    def _metrics(metrics: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
        out = [
            {**{k: v for k, v in m.items() if k != "totalMs"}, "averageMs": js_round(m["totalMs"] / m["count"] * 100) / 100}
            for m in metrics.values()
        ]
        return sorted(out, key=lambda m: -m["count"])

    def _add(self, event: dict[str, Any]) -> None:
        at = _parse_at(event.get("at"))
        hour = self.hours[to_datetime(at).hour] if at is not None else None
        data = event.get("data") if isinstance(event.get("data"), Mapping) else {}
        kind, source = event.get("kind"), event.get("source")
        if event.get("level") == "error":
            self.counts["errors"] += 1
        if kind == "analytics":
            message = event.get("message")
            key = message if isinstance(message, (str, int, float, type(None))) else stringify(message)
            self.analytics.setdefault(key, {"name": message, "count": 0})["count"] += 1
        if kind == "request":
            self.counts["requests"] += 1
            ms = _number(data.get("durationMs"), "durationMs" in data)
            self.duration += 0 if math.isnan(ms) else ms
            label = _field(data, "method") + " " + _field(data, "path")
            self._aggregate(self.requests, label, label, data.get("durationMs"), _number(data.get("status"), "status" in data) >= 500, source)
            if hour is not None:
                hour["requests"] += 1
        if kind == "timing":
            name = _field(data, "name")
            self._aggregate(self.operations, _field(event, "source") + ":" + name, name, data.get("durationMs"), data.get("failed") is True, source)
        if kind == "pageview" and source in ("spa", "ssr"):
            self.counts[source] += 1  # type: ignore[index]
            if hour is not None:
                hour["views"] += 1
            path = _field(data, "path")
            self.pages.setdefault(source + path, {"source": source, "path": path, "views": 0})["views"] += 1

    def build(self, day: str, partial: bool) -> dict[str, Any]:
        for event in self.events:
            self._add(event)
        requests = self.counts["requests"]
        return {
            "day": day,
            "counts": self.counts,
            "analytics": sorted(self.analytics.values(), key=lambda a: -a["count"]),
            "requestMetrics": self._metrics(self.requests),
            "operationMetrics": self._metrics(self.operations),
            "averageMs": js_round(self.duration / requests) if requests else 0,
            "hours": self.hours,
            "pages": sorted(self.pages.values(), key=lambda p: -p["views"])[:30],
            # Newest first; ties keep storage order (a stable sort by code point).
            "events": sorted(self.events, key=lambda e: js_string(e.get("at")), reverse=True)[:100],
            "partial": partial,
        }


# ---------------------------------------------------------------- endpoints


_PAGE_PATH = re.compile(r"/[a-zA-Z0-9/_-]*")
RATE_PER_MINUTE: Final = 60
RATE_PURGE: Final = 2000
RATE_CLIENTS: Final = 4000


def observer_feature(
    observer: Observer,
    storage: ObserverStore,
    logs: Any = None,
    *,
    now: Clock | None = None,
) -> Feature:
    """Owner reports and log search (admin-only) plus public, rate-limited page-view ingestion."""
    reader = logs if logs is not None else storage
    rates: dict[str, dict[str, int]] = {}
    lock = threading.Lock()

    def today() -> str:
        return _js.iso_timestamp(to_datetime(epoch_ms(now)))[:10]

    def report(ctx: Context) -> Any:
        day = ctx.request.query.get("day")
        result = storage.report(today() if day is None else day)
        result["health"] = dict(observer.health)
        result["outputs"] = [
            {
                "id": output.handler.id,
                "enabled": output.enabled is not False,
                "levels": list(output.levels) if output.levels is not None else list(LEVELS),
                "kinds": list(output.kinds) if output.kinds is not None else list(KINDS),
            }
            for output in observer.outputs
        ]
        return result

    def search(ctx: Context) -> Any:
        return reader.search({"day": today(), **ctx.request.query})

    def ingest(ctx: Context) -> Any:
        body = ctx.request.body if isinstance(ctx.request.body, Mapping) else {}
        if "message" in body:
            message = body["message"]
            if not isinstance(message, str) or _js.utf16_length(message) > 200:
                raise HttpError(400, "Invalid page message")
        source, path = body.get("source"), body.get("path")
        if (
            source not in ("spa", "ssr")
            or not isinstance(path, str)
            or _js.utf16_length(path) > 160
            or not _PAGE_PATH.fullmatch(path)
            # "//host/x" is protocol-relative: it names a host (or none) instead of a page.
            or path.startswith("//")
        ):
            raise HttpError(400, "Invalid page event")
        _limit(ctx.request.ip)
        message = body.get("message")
        observer.count_view("Page viewed" if message is None else message, {"source": source, "url": path})
        return {"ok": True}

    def _limit(ip: str | None) -> None:
        """Per instance: 60 events per client per clock minute, 4000 clients at most."""
        minute = math.floor(epoch_ms(now) / 60000)
        key = hashlib.sha256(utf8("unknown" if ip is None else ip)).hexdigest()
        with lock:
            if len(rates) > RATE_PURGE:
                for known in [k for k, v in rates.items() if v["minute"] != minute]:
                    del rates[known]
            if len(rates) >= RATE_CLIENTS and key not in rates:
                raise HttpError(429, "Too many events")
            rate = rates.get(key)
            if rate is None or rate["minute"] != minute:
                rate = {"minute": minute, "count": 0}
                rates[key] = rate
            rate["count"] += 1
            if rate["count"] - 1 >= RATE_PER_MINUTE:
                raise HttpError(429, "Too many events")

    return Feature(
        id="observer",
        admin={
            "id": "observer",
            "title": "Observer",
            "resource": "observer.read",
            "path": "/observer/report",
            "component": "observer",
            "ownerOnly": True,
            "fields": [],
            "actions": [],
        },
        endpoints=[
            Endpoint(method="GET", path="/observer/report", resource="observer.read", access="owner", handle=report),
            Endpoint(method="GET", path="/observer/logs", resource="observer.read", access="owner", handle=search),
            Endpoint(method="POST", path="/observer/events", resource="observer.pageview", access="guest", handle=ingest),
        ],
    )


# ---------------------------------------------------------------- HTTP delivery


class OutputRequest(TypedDict):
    url: str
    method: str
    headers: dict[str, str]
    body: str


#: Sends one request and returns its status; must not follow redirects. ``signal`` is set when
#: the Observer gave up on the delivery.
Transport = Callable[[OutputRequest, "threading.Event | None"], int]


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


def urllib_transport(request: OutputRequest, signal: threading.Event | None = None, timeout: float = 10) -> int:
    """The default transport: urllib without redirects; the response body is discarded."""
    opener = urllib.request.build_opener(_NoRedirect)
    outgoing = urllib.request.Request(request["url"], data=request["body"].encode("utf-8"), headers=request["headers"], method=request["method"])
    try:
        with opener.open(outgoing, timeout=timeout) as response:
            return response.status
    except urllib.error.HTTPError as error:
        error.close()
        return error.code


def post_output(
    url: str,
    body: str,
    headers: Mapping[str, str],
    signal: threading.Event | None = None,
    transport: Transport | None = None,
) -> None:
    """POST to an HTTPS destination without URL credentials; a non-2xx status is an error.

    Never include destination credentials in diagnostics: errors name the status only.
    """
    destination = _url.parse(url)
    if destination.scheme != "https" or destination.password or destination.username:
        raise ValueError("Observer destinations require HTTPS without URL credentials")
    status = (transport or urllib_transport)({"url": destination.href, "method": "POST", "headers": dict(headers), "body": body}, signal)
    if not 200 <= status <= 299:
        raise RuntimeError(f"Observer destination returned HTTP {status}")


__all__ = [
    "Observer",
    "Output",
    "OutputHandler",
    "ObserverEvent",
    "ObserverStore",
    "RequestMetric",
    "LogQuery",
    "observer_feature",
    "sanitize",
    "safe_path",
    "validate_log_query",
    "matches_log",
    "valid_day",
    "post_output",
    "urllib_transport",
    "Transport",
    "OutputRequest",
    "stringify",
    "LEVELS",
    "KINDS",
]
