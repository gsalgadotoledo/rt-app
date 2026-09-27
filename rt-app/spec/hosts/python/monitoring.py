"""Subjects: health, health-monitor, health-http-probe, analytics, visits.

Each subject is a small facade with the surface of spec/hosts/node/monitoring.mjs; helpers are
documented in the contracts and docs/polyglot/{health,analytics,visits}.md. Contract method names
are camelCase and map to these snake_case names.
"""
from __future__ import annotations

import contextvars
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from rt_app.analytics import Analytics
from rt_app.health import AvailabilityMonitor, HealthChecks, Probe, http_health_probe
from rt_app.visits import Visits
from storage import memory_store, rows_of

_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


def _parse_iso(value: Any) -> int:
    """``Date.parse`` for the ISO 8601 instants contracts use → epoch milliseconds."""
    if isinstance(value, str):
        value = datetime.fromisoformat(value[:-1] + "+00:00" if value.endswith(("Z", "z")) else value)
    if not isinstance(value, datetime):
        raise ValueError("not a date")
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return (value - _EPOCH) // timedelta(milliseconds=1)


class _Clock:
    """A settable clock starting at init.now (ISO 8601); the system clock when absent."""

    def __init__(self, now: Any) -> None:
        try:
            self.fixed: int | None = None if now is None else _parse_iso(now)
        except (ValueError, TypeError):
            raise ValueError("init.now must be an ISO 8601 date") from None

    def now(self) -> int:
        return time.time_ns() // 1_000_000 if self.fixed is None else self.fixed

    def set(self, iso: Any) -> None:
        try:
            self.fixed = _parse_iso(iso)
        except (ValueError, TypeError):
            raise ValueError("setNow needs an ISO 8601 date") from None


def _init(init: Any) -> dict[str, Any]:
    return init if isinstance(init, dict) else {}


class _Scripted:
    """Scripted probes: up, down (a secret-looking failure), slow (50 ms) and hang (until aborted)."""

    BEHAVIORS = ("up", "down", "slow", "hang")

    def __init__(self, specs: Any) -> None:
        self.state: dict[str, dict[str, Any]] = {}
        self.probes: list[Probe] = []
        for spec in specs or []:
            entry: dict[str, Any] = {"behavior": spec.get("behavior") or "up", "calls": 0, "signal": None}
            self.state[spec["id"]] = entry
            required = spec.get("required")
            self.probes.append(Probe(spec["id"], self._check(entry), required is not False))

    @staticmethod
    def _check(entry: dict[str, Any]):  # noqa: ANN205
        def check(signal: threading.Event) -> None:
            entry["calls"] += 1
            entry["signal"] = signal
            if entry["behavior"] == "down":
                raise RuntimeError("password=hunter2 at db.internal")
            if entry["behavior"] == "slow":
                time.sleep(0.05)
            if entry["behavior"] == "hang":
                signal.wait()

        return check

    def find(self, id: Any) -> dict[str, Any]:
        if id not in self.state:
            raise ValueError(f"Unknown probe {id}")
        return self.state[id]

    def set_probe(self, id: Any, behavior: Any) -> None:
        if behavior not in self.BEHAVIORS:
            raise ValueError("Unknown probe behavior")
        self.find(id)["behavior"] = behavior


def _checks(init: dict[str, Any], scripted: _Scripted, clock: _Clock, cache_ms: Any) -> HealthChecks:
    options: dict[str, Any] = {}
    if init.get("timeoutMs") is not None:
        options["timeout_ms"] = init["timeoutMs"]
    if cache_ms is not None:
        options["cache_ms"] = cache_ms
    return HealthChecks(scripted.probes, **options, now=clock.now)


class HealthFacade:
    def __init__(self, init: Any) -> None:
        init = _init(init)
        self._clock = _Clock(init.get("now"))
        self._scripted = _Scripted(init.get("probes"))
        self._health = _checks(init, self._scripted, self._clock, init.get("cacheMs"))
        self._endpoints = {e.path: e for e in self._health.feature().endpoints}

    def report(self) -> Any:
        return self._health.report()

    def concurrent_reports(self, count: int) -> list[Any]:
        results: list[Any] = [None] * count
        barrier = threading.Barrier(count)

        def call(i: int) -> None:
            barrier.wait()
            results[i] = self._health.report()

        threads = [threading.Thread(target=call, args=(i,)) for i in range(count)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        return results

    def live(self) -> Any:
        return self._endpoints["/health/live"].handle(None)

    def ready(self) -> Any:
        return self._endpoints["/health/ready"].handle(None)

    def health_report(self) -> Any:
        return self._endpoints["/health/report"].handle(None)

    def endpoints(self) -> list[dict[str, str]]:
        return [{"method": e.method, "path": e.path, "resource": e.resource, "access": e.access} for e in self._health.feature().endpoints]

    def set_probe(self, id: Any, behavior: Any) -> None:
        self._scripted.set_probe(id, behavior)

    def calls(self, id: Any) -> int:
        return self._scripted.find(id)["calls"]

    def aborted(self, id: Any) -> bool:
        signal = self._scripted.find(id)["signal"]
        return signal is not None and signal.is_set()

    def set_now(self, iso: Any) -> None:
        self._clock.set(iso)


class HealthMonitorFacade:
    def __init__(self, init: Any) -> None:
        init = _init(init)
        self._clock = _Clock(init.get("now"))
        self._scripted = _Scripted(init.get("probes"))
        cache_ms = init.get("cacheMs")
        checks = _checks(init, self._scripted, self._clock, 0 if cache_ms is None else cache_ms)
        self._alerts: list[Any] = []
        self._failures = 0
        self._monitor = AvailabilityMonitor(checks, self._notify)

    def _notify(self, alert: Any) -> None:
        if self._failures > 0:
            self._failures -= 1
            raise RuntimeError("mail offline")
        self._alerts.append(alert)

    def poll(self) -> Any:
        return self._monitor.poll()

    def alerts(self) -> list[Any]:
        return self._alerts

    def fail_notifications(self, count: int) -> None:
        self._failures = count

    def set_probe(self, id: Any, behavior: Any) -> None:
        self._scripted.set_probe(id, behavior)

    def set_now(self, iso: Any) -> None:
        self._clock.set(iso)


class HealthHttpProbeFacade:
    def __init__(self, init: Any) -> None:
        pass

    def probe(self, id: Any, url: Any) -> dict[str, Any]:
        return {"id": http_health_probe(id, url, lambda _url, _signal: 200).id}

    def check(self, url: Any, status: int) -> None:
        http_health_probe("probe", url, lambda _url, _signal: status).check(threading.Event())


class _SpyObserver:
    """Records every call with the log context active when it was made."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self._context: contextvars.ContextVar[dict[str, str]] = contextvars.ContextVar("context", default={})

    def with_context(self, context: Any, operation: Any) -> Any:
        token = self._context.set({**self._context.get(), **context})
        try:
            return operation()
        finally:
            self._context.reset(token)

    def emit(self, level: str, kind: str, source: str, message: str, data: Any) -> None:
        self.calls.append({"method": "emit", "level": level, "kind": kind, "source": source, "message": message, "data": data, "context": dict(self._context.get())})

    def count_view(self, message: str, options: Any) -> None:
        self.calls.append({"method": "countView", "message": message, "options": options, "context": dict(self._context.get())})


class AnalyticsFacade:
    def __init__(self, init: Any) -> None:
        self._observer = _SpyObserver()
        self._analytics = Analytics(self._observer)

    def track(self, name: Any, properties: Any = None, source: Any = None) -> None:
        self._analytics.track(name, properties, source)

    def page_view(self, title: Any, options: Any) -> None:
        self._analytics.page_view(title, options)

    def calls(self) -> list[dict[str, Any]]:
        return self._observer.calls


class VisitsFacade:
    def __init__(self, init: Any) -> None:
        init = _init(init)
        self._clock = _Clock(init.get("now"))
        self._store = memory_store(rows_of(init))
        ids = list(init.get("ids") or [])
        new_id = (lambda: ids.pop(0) if ids else str(uuid.uuid4())) if ids else (lambda: str(uuid.uuid4()))
        pages = init.get("pages")
        options: dict[str, Any] = {} if pages is None else {"pages": pages}
        self._visits = Visits(self._store, init.get("secret"), **options, now=self._clock.now, new_id=new_id)

    def start(self, ip: Any) -> Any:
        return self._visits.start(ip)

    def ingest(self, input: Any, ip: Any) -> Any:
        return self._visits.ingest(input, ip)

    def list(self) -> Any:
        return self._visits.list()

    def detail(self, id: Any) -> Any:
        return self._visits.detail(id)

    def remove(self, id: Any) -> Any:
        return self._visits.remove(id)

    def start_each(self, ips: Any) -> None:
        for ip in ips:
            self._visits.start(ip)

    def row(self, pk: Any, sk: Any) -> Any:
        return self._store.get(pk, sk)

    def set_now(self, iso: Any) -> None:
        self._clock.set(iso)

    def sign(self, payload: Any) -> str:
        return self._visits.sign(payload)


SUBJECTS = {
    "health": HealthFacade,
    "health-monitor": HealthMonitorFacade,
    "health-http-probe": HealthHttpProbeFacade,
    "analytics": AnalyticsFacade,
    "visits": VisitsFacade,
}
