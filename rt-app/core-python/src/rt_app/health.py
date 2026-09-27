"""Health checks: liveness, readiness and an owner-only dependency report (TypeScript is the reference).

``HealthChecks(probes, timeout_ms, cache_ms, now=clock)`` runs dependency probes in parallel, each
bounded by ``timeout_ms`` and never exposing failure details, and caches the report for ``cache_ms``.
Its feature serves ``GET /health/live`` and ``GET /health/ready`` to guests and ``GET /health/report``
to the owner (mounted under ``/admin/app``)::

    store = Singleton(MemoryStore)
    health = HealthChecks([Probe("database", lambda signal: store.get().get("SCHEMA", "users"))])
    app = App([health.feature()], local_admin=True)

``AvailabilityMonitor`` alerts outages and recoveries from an independent scheduler and
``http_health_probe`` checks another service over HTTP. ``Health`` is the earlier liveness/readiness
feature without dependency checks, kept for compatibility.
"""
from __future__ import annotations

import copy
import inspect
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Sequence
from concurrent.futures import Future
from dataclasses import dataclass
from typing import Any, Literal, Protocol, TypedDict

from . import _js
from ._jsnum import js_round
from .contracts import Clock, epoch_ms, to_datetime
from .errors import HttpError
from .web.app import Endpoint, Feature

MAX_PROBES = 20
Status = Literal["up", "down"]


class HealthProbe(Protocol):
    """A dependency check. ``check`` raises (or returns a failing awaitable) when unhealthy.

    ``signal`` is set when the check timed out: long checks should stop then. An optional
    ``required`` attribute set to ``False`` keeps a failure from failing readiness.
    """

    id: str

    def check(self, signal: threading.Event) -> object: ...


@dataclass(frozen=True)
class Probe:
    """A probe from a function: ``Probe("database", lambda signal: store.get("SCHEMA", "users"))``."""

    id: str
    run: Callable[[threading.Event], object]
    required: bool = True

    def check(self, signal: threading.Event) -> object:
        return self.run(signal)


class HealthCheck(TypedDict):
    id: str
    required: bool
    status: Status
    durationMs: int


class HealthReport(TypedDict):
    ok: bool
    at: str
    checks: list[HealthCheck]


class AvailabilityAlert(TypedDict):
    service: str
    status: Status
    at: str


def _resolve(value: object) -> object:
    """Wait for awaitables (async probes and notifiers) on the shared event loop."""
    return _js.run_sync(value) if inspect.isawaitable(value) else value  # type: ignore[arg-type]


def _valid_number(value: object, minimum: float) -> bool:
    """``Number.isFinite(value) && value >= minimum`` (booleans and strings are not numbers)."""
    return _js.is_finite_number(value) and value >= minimum  # type: ignore[operator]


class _Shared:
    """One in-flight computation shared by concurrent callers (a pending Promise)."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._pending: Future[Any] | None = None

    def run(self, compute: Callable[[], Any]) -> Any:
        with self._lock:
            owner = self._pending is None
            if owner:
                self._pending = Future()
            pending = self._pending
        assert pending is not None
        if owner:
            try:
                pending.set_result(compute())
            except BaseException as error:
                pending.set_exception(error)
            finally:
                with self._lock:
                    self._pending = None
        return pending.result()


class HealthChecks:
    """Cached, bounded probes; failures never expose provider credentials or error bodies."""

    def __init__(
        self,
        probes: Sequence[HealthProbe] = (),
        timeout_ms: float = 1000,
        cache_ms: float = 10000,
        *,
        now: Clock | None = None,
    ) -> None:
        probes = list(probes)
        if (
            len(probes) > MAX_PROBES
            or len({probe.id for probe in probes}) != len(probes)
            or not _valid_number(timeout_ms, 1)
            or not _valid_number(cache_ms, 0)
        ):
            raise ValueError("Invalid health configuration")
        self.probes = probes
        self.timeout_ms = timeout_ms
        self.cache_ms = cache_ms
        self._now = now
        self._lock = threading.Lock()
        self._snapshot: HealthReport | None = None
        self._expires = 0.0
        self._shared = _Shared()

    def report(self) -> HealthReport:
        """A copy of the cached report, or a new run shared with concurrent callers."""
        with self._lock:
            if self._snapshot is not None and self._expires > epoch_ms(self._now):
                return copy.deepcopy(self._snapshot)
        return copy.deepcopy(self._shared.run(self._run))

    def _run(self) -> HealthReport:
        """Run independent checks in parallel; redact errors and abort timed-out work."""
        started = [self._start(probe) for probe in self.probes]
        checks = [finish() for finish in started]
        report: HealthReport = {
            "ok": all(not check["required"] or check["status"] == "up" for check in checks),
            "at": _js.iso_timestamp(to_datetime(epoch_ms(self._now))),
            "checks": checks,
        }
        with self._lock:
            self._snapshot = report
            self._expires = epoch_ms(self._now) + self.cache_ms
        return report

    def _start(self, probe: HealthProbe) -> Callable[[], HealthCheck]:
        """Start one probe on its own daemon thread; the result waits for it at most timeout_ms."""
        signal = threading.Event()
        done = threading.Event()
        outcome: dict[str, Any] = {"up": False}
        start = time.perf_counter()

        def work() -> None:
            try:
                _resolve(probe.check(signal))
                outcome["up"] = True
            except BaseException:  # noqa: BLE001 - any failure is "down", never shown
                outcome["up"] = False
            finally:
                outcome["end"] = time.perf_counter()
                done.set()

        threading.Thread(target=work, name=f"rt-app-health-{probe.id}", daemon=True).start()
        deadline = start + self.timeout_ms / 1000

        def finish() -> HealthCheck:
            finished = done.wait(max(0.0, deadline - time.perf_counter()))
            if not finished:
                signal.set()
            up = finished and outcome["up"]
            end = outcome["end"] if finished else time.perf_counter()
            return {
                "id": probe.id,
                "required": getattr(probe, "required", True) is not False,
                "status": "up" if up else "down",
                "durationMs": int(js_round((end - start) * 1000)),
            }

        return finish

    def feature(self) -> Feature:
        """Public liveness/readiness expose only availability; dependency detail is owner-only."""

        def ready(_: Any) -> dict[str, bool]:
            if not self.report()["ok"]:
                raise HttpError(503, "Service unavailable")
            return {"ok": True}

        return Feature(
            id="health",
            admin={
                "id": "health",
                "title": "Service health",
                "resource": "health.read",
                "path": "/health/report",
                "component": "health",
                "ownerOnly": True,
                "fields": [],
                "actions": [],
            },
            endpoints=[
                Endpoint(method="GET", path="/health/live", resource="health.live", access="guest", handle=lambda _: {"ok": True}),
                Endpoint(method="GET", path="/health/ready", resource="health.ready", access="guest", handle=ready),
                Endpoint(method="GET", path="/health/report", resource="health.read", access="owner", handle=lambda _: self.report()),
            ],
        )


class AvailabilityMonitor:
    """Run from an independent worker or scheduler: a stopped API cannot report its own outage.

    ``poll()`` notifies initial failures and later transitions; a failing notification makes the
    poll fail and is retried by the next one. Concurrent polls share one run.
    """

    def __init__(self, checks: HealthChecks, notify: Callable[[AvailabilityAlert], object]) -> None:
        self.checks = checks
        self.notify = notify
        self._states: dict[str, Status] = {}
        self._shared = _Shared()

    def poll(self) -> HealthReport:
        return self._shared.run(self._run)

    def _run(self) -> HealthReport:
        report = self.checks.report()
        for check in report["checks"]:
            previous = self._states.get(check["id"])
            if previous != check["status"] and (previous is not None or check["status"] == "down"):
                _resolve(self.notify({"service": check["id"], "status": check["status"], "at": report["at"]}))
            self._states[check["id"]] = check["status"]
        return report


#: ``transport(url, signal) -> HTTP status``; it must not follow redirects.
Transport = Callable[[str, threading.Event], int]
_SPECIAL_SCHEMES = ("ftp", "http", "https", "ws", "wss")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None  # the 3xx response is raised as an HTTPError


def urllib_transport(timeout: float = 5.0) -> Transport:
    """A stdlib transport: one GET, redirects rejected, the body discarded."""
    opener = urllib.request.build_opener(_NoRedirect)

    def transport(url: str, signal: threading.Event) -> int:
        try:
            with opener.open(urllib.request.Request(url, method="GET"), timeout=timeout) as response:
                return int(response.status)
        except urllib.error.HTTPError as error:
            error.close()
            return int(error.code)

    return transport


def _check_url(url: object) -> str:
    """``new URL(url)`` for the URLs health probes accept: absolute, with a host when needed."""
    if not isinstance(url, str):
        raise ValueError("Invalid URL")
    try:
        parts = urllib.parse.urlsplit(url)
        parts.port  # noqa: B018 - raises ValueError on an invalid port
    except ValueError:
        raise ValueError("Invalid URL") from None
    if not parts.scheme or (parts.scheme in _SPECIAL_SCHEMES and not parts.hostname):
        raise ValueError("Invalid URL")
    return parts.scheme


def http_health_probe(id: str, url: str, transport: Transport | None = None) -> Probe:
    """A probe that GETs ``url`` and is up on 2xx. URLs are trusted configuration, never user input.

    Only http(s) URLs without credentials are accepted ("Invalid health URL"); redirects are
    deliberately not followed.
    """
    scheme = _check_url(url)
    parts = urllib.parse.urlsplit(url)
    if scheme not in ("http", "https") or parts.username or parts.password:
        raise ValueError("Invalid health URL")
    send = transport or urllib_transport()

    def check(signal: threading.Event) -> None:
        status = send(url, signal)
        if not 200 <= status <= 299:
            raise RuntimeError("Service unavailable")

    return Probe(id, check)


class Health:
    """``GET /health/live`` and ``GET /health/ready`` answer ``{"ok": true}`` to guests.

    Kept for compatibility; ``HealthChecks`` adds dependency probes and the owner report.
    """

    def feature(self) -> Feature:
        return Feature(
            id="health",
            endpoints=[
                Endpoint(method="GET", path="/health/live", resource="health.live", access="guest", handle=lambda _: {"ok": True}),
                Endpoint(method="GET", path="/health/ready", resource="health.ready", access="guest", handle=lambda _: {"ok": True}),
            ],
        )


__all__ = [
    "AvailabilityAlert",
    "AvailabilityMonitor",
    "Health",
    "HealthCheck",
    "HealthChecks",
    "HealthProbe",
    "HealthReport",
    "Probe",
    "Transport",
    "http_health_probe",
    "urllib_transport",
]
