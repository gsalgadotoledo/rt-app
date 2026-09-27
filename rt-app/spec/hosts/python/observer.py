"""Subjects: observer, observer-rules, observer-console, observer-webhook, observer-slack,
observer-email, observer-email-local, observer-sms.

Each subject is a small facade with the surface of spec/hosts/node/observer.mjs; helpers are
documented in the contracts and docs/polyglot/observer.md. Transports are fakes configured by init:
nothing leaves the host. Contract method names are camelCase and map to these snake_case names.
"""
from __future__ import annotations

import contextvars
import copy
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from storage import memory_store, rows_of

from rt_app.observer import (
    Observer,
    ObserverStore,
    Output,
    matches_log,
    observer_feature,
    safe_path,
    sanitize,
    validate_log_query,
)
from rt_app.observer.console import ConsoleOutput
from rt_app.observer.email import EmailOutput, LocalEmailOutput
from rt_app.observer.slack import SlackOutput
from rt_app.observer.sms import SmsOutput
from rt_app.observer.webhook import WebhookOutput
from rt_app.web.app import Context, Request

_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


def _init(init: Any) -> dict[str, Any]:
    return init if isinstance(init, dict) else {}


def _parse_iso(value: Any) -> int:
    if not isinstance(value, str):
        raise ValueError("not a date")
    moment = datetime.fromisoformat(value[:-1] + "+00:00" if value.endswith(("Z", "z")) else value)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return (moment - _EPOCH) // timedelta(milliseconds=1)


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

    def advance(self, ms: float) -> None:
        self.fixed = self.now() + int(ms)


class _Scripted:
    """A scripted output: ok, fail (a secret-looking error), hang (until aborted), slow, mutate."""

    def __init__(self, id: str, behavior: str | None) -> None:
        self.id = id
        self.behavior = behavior or "ok"
        self.delivered: list[Any] = []
        self.signal: threading.Event | None = None
        self._lock = threading.Lock()

    def write(self, event: Any, signal: threading.Event | None = None) -> None:
        self.signal = signal
        if self.behavior == "fail":
            raise RuntimeError("password=hunter2 at hooks.internal")
        if self.behavior == "hang":
            assert signal is not None
            signal.wait()
            return
        if self.behavior == "slow":
            time.sleep(0.02)
        with self._lock:
            self.delivered.append(copy.deepcopy(event))
        if self.behavior == "mutate":
            event["message"] = "mutated by output"
            event["data"]["mutated"] = True


def _filter(spec: Any) -> Any:
    if spec is None:
        return None
    if spec.get("throws"):
        def throws(event: Any) -> bool:
            raise RuntimeError("filter failed")
        return throws
    if spec.get("mutates"):
        def mutates(event: Any) -> bool:
            event["message"] = "mutated by filter"
            event["data"]["mutated"] = True
            return True
        return mutates
    if isinstance(spec.get("messageIncludes"), str):
        return lambda event: spec["messageIncludes"] in event["message"]
    raise ValueError("Unknown filter spec")


def _present(value: Any) -> Any:
    return {k: v for k, v in value.items() if v is not None} if isinstance(value, dict) else value


class ObserverFacade:
    def __init__(self, init: Any) -> None:
        init = _init(init)
        self._clock = _Clock(init.get("now"))
        ids = list(init.get("ids") or [])
        self._store = memory_store(rows_of(init))
        self._storage = ObserverStore(self._store, now=self._clock.now)
        self._scripted: dict[str, _Scripted] = {}
        outputs = []
        for raw in init.get("outputs") or []:
            spec = _present(raw)
            if spec.get("type") == "store":
                handler: Any = self._storage
            else:
                handler = self._scripted.setdefault(spec["id"], _Scripted(spec["id"], spec.get("behavior")))
            outputs.append(
                Output(
                    handler,
                    enabled=spec.get("enabled") is not False,
                    levels=spec.get("levels"),
                    kinds=spec.get("kinds"),
                    sources=spec.get("sources"),
                    categories=spec.get("categories"),
                    max_per_minute=spec.get("maxPerMinute"),
                    filter=_filter(spec.get("filter")),
                )
            )
        options: dict[str, Any] = {} if init.get("timeoutMs") is None else {"timeout_ms": init["timeoutMs"]}
        self._observer = Observer(outputs, **options, now=self._clock.now, new_id=lambda: ids.pop(0) if ids else str(uuid.uuid4()))
        self._feature = observer_feature(self._observer, self._storage, now=self._clock.now)
        self._endpoints = {(e.method, e.path): e for e in self._feature.endpoints}

    # Observer ------------------------------------------------------------------------------

    def emit(self, level: Any, kind: Any, source: Any, message: Any, data: Any = None) -> None:
        self._observer.emit(level, kind, source, message, data)

    def write(self, level: Any, message: Any, context: Any = None, data: Any = None) -> None:
        self._observer.write(level, message, context, data)

    def log(self, *values: Any) -> None:
        self._observer.log(*values)

    def info(self, *values: Any) -> None:
        self._observer.info(*values)

    def debug(self, *values: Any) -> None:
        self._observer.debug(*values)

    def warn(self, *values: Any) -> None:
        self._observer.warn(*values)

    def warning(self, *values: Any) -> None:
        self._observer.warning(*values)

    def error(self, *values: Any) -> None:
        self._observer.error(*values)

    def count_view(self, message: Any, options: Any) -> None:
        self._observer.count_view(message, _present(options))

    def record_request(self, metric: Any) -> None:
        self._observer.record_request(metric)

    def measure(self, name: Any, operation: Any, options: Any = None) -> Any:
        operation = operation or {}

        def run() -> Any:
            if operation.get("advanceMs"):
                self._clock.advance(operation["advanceMs"])
            if isinstance(operation.get("fail"), str):
                raise RuntimeError(operation["fail"])
            return operation.get("value")

        return self._observer.measure(name, run, (options or {}).get("source"))

    def with_context(self, context: Any, steps: Any) -> list[Any]:
        return self._observer.with_context(context, lambda: [self._call(step) for step in steps])

    def _call(self, step: Any) -> Any:
        from rt_app.conformance import snake_case

        return getattr(self, snake_case(step["call"]))(*(step.get("args") or []))

    def parallel(self, branches: Any) -> None:
        errors: list[BaseException] = []

        def run(branch: Any) -> None:
            def body() -> None:
                time.sleep((branch.get("delayMs") or 0) / 1000)
                for step in branch["steps"]:
                    self._call(step)

            try:
                self._observer.with_context(branch.get("context"), body)
            except BaseException as error:  # noqa: BLE001
                errors.append(error)

        threads = [threading.Thread(target=contextvars.copy_context().run, args=(run, b)) for b in branches]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        if errors:
            raise errors[0]

    def burst(self, count: int, level: Any, message: Any) -> None:
        barrier = threading.Barrier(count)

        def run() -> None:
            barrier.wait()
            self._observer.emit(level, "log", "app", message, {})

        threads = [threading.Thread(target=run) for _ in range(count)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

    def emit_many(self, count: int, level: Any, message: Any) -> None:
        for _ in range(count):
            self._observer.emit(level, "log", "app", message, {})

    def _find(self, id: Any) -> _Scripted:
        if id not in self._scripted:
            raise ValueError(f"Unknown output {id}")
        return self._scripted[id]

    def delivered(self, id: Any) -> list[Any]:
        return self._find(id).delivered

    def aborted(self, id: Any) -> bool:
        signal = self._find(id).signal
        return signal is not None and signal.is_set()

    def set_behavior(self, id: Any, behavior: Any) -> None:
        self._find(id).behavior = behavior

    def health(self) -> dict[str, int]:
        return dict(self._observer.health)

    def set_now(self, iso: Any) -> None:
        self._clock.set(iso)

    # Storage -------------------------------------------------------------------------------

    def search(self, query: Any) -> Any:
        return self._storage.search(query)

    def store_report(self, day: Any) -> Any:
        return self._storage.report(day)

    def store_write(self, event: Any) -> None:
        self._storage.write(event)

    def list(self, pk: Any, cursor: Any = None) -> Any:
        return self._store.list(pk, cursor)

    # Endpoints -----------------------------------------------------------------------------

    def _handle(self, method: str, path: str, *, query: Any = None, body: Any = None, ip: Any = None) -> Any:
        request = Request(method=method, path=path, query=_present(query) or {}, body=body if body is not None else {}, ip=ip)
        return self._endpoints[(method, path)].handle(Context(request=request, params={}))

    def report(self, query: Any = None) -> Any:
        return self._handle("GET", "/observer/report", query=query)

    def logs(self, query: Any = None) -> Any:
        return self._handle("GET", "/observer/logs", query=query)

    def ingest(self, body: Any, ip: Any = None) -> Any:
        return self._handle("POST", "/observer/events", body=body, ip=ip)

    def ingest_each(self, ips: Any, body: Any) -> None:
        for ip in ips:
            self.ingest(body, ip)

    def endpoints(self) -> list[dict[str, str]]:
        return [{"method": e.method, "path": e.path, "resource": e.resource, "access": e.access} for e in self._feature.endpoints]

    def admin(self) -> Any:
        return self._feature.admin


class RulesFacade:
    def __init__(self, init: Any) -> None:
        pass

    def sanitize(self, value: Any) -> Any:
        return sanitize(value)

    def safe_path(self, url: Any) -> str:
        return safe_path(url)

    def validate_log_query(self, query: Any) -> None:
        validate_log_query(query)

    def matches_log(self, event: Any, query: Any) -> bool:
        return matches_log(event, query)


class ConsoleFacade:
    def __init__(self, init: Any) -> None:
        self._lines: list[dict[str, str]] = []
        self._output = ConsoleOutput(lambda level, line: self._lines.append({"level": level, "line": line}))

    def id(self) -> str:
        return self._output.id

    def write(self, event: Any) -> None:
        self._output.write(event)

    def lines(self) -> list[dict[str, str]]:
        return self._lines


class _FakeTransport:
    """Records {url, method, headers, body}; answers init.status (200) or raises init.fail."""

    def __init__(self, init: dict[str, Any]) -> None:
        self.requests: list[Any] = []
        self.status = init.get("status") or 200
        self.failure = init.get("fail")

    def __call__(self, request: Any, signal: Any = None) -> int:
        self.requests.append(dict(request))
        if self.failure is not None:
            raise RuntimeError(self.failure)
        return self.status


class _HttpFacade:
    def __init__(self, output: Any, transport: _FakeTransport) -> None:
        self._output, self._transport = output, transport

    def id(self) -> str:
        return self._output.id

    def write(self, event: Any) -> None:
        self._output.write(event)

    def requests(self) -> list[Any]:
        return self._transport.requests

    def set_status(self, status: int) -> None:
        self._transport.status = status

    def set_failure(self, message: Any) -> None:
        self._transport.failure = message


def webhook_facade(init: Any) -> _HttpFacade:
    init = _init(init)
    transport = _FakeTransport(init)
    return _HttpFacade(WebhookOutput(init.get("id"), init.get("url"), init.get("headers"), transport), transport)


def slack_facade(init: Any) -> _HttpFacade:
    init = _init(init)
    transport = _FakeTransport(init)
    return _HttpFacade(SlackOutput(init.get("webhook"), transport), transport)


class _FakeAws:
    """A boto3-like client recording each call's keyword arguments, or raising init.fail."""

    def __init__(self, failure: Any) -> None:
        self.sent: list[Any] = []
        self.failure = failure

    def _record(self, **kwargs: Any) -> dict[str, Any]:
        if self.failure is not None:
            raise RuntimeError(self.failure)
        self.sent.append(copy.deepcopy(kwargs))
        return {}

    send_email = _record
    publish = _record


class _AwsFacade:
    def __init__(self, output: Any, client: _FakeAws) -> None:
        self._output, self._client = output, client

    def id(self) -> str:
        return self._output.id

    def write(self, event: Any) -> None:
        self._output.write(event)

    def sent(self) -> list[Any]:
        return self._client.sent


def email_facade(init: Any) -> _AwsFacade:
    init = _init(init)
    client = _FakeAws(init.get("fail"))
    return _AwsFacade(EmailOutput(init.get("from"), init.get("to"), client), client)


def sms_facade(init: Any) -> _AwsFacade:
    init = _init(init)
    client = _FakeAws(init.get("fail"))
    return _AwsFacade(SmsOutput(init.get("phone"), client), client)


class LocalEmailFacade:
    def __init__(self, init: Any) -> None:
        init = _init(init)
        self._sent: list[Any] = []
        self._failure = init.get("fail")
        port = 1025 if init.get("port") is None else init["port"]
        self._output = LocalEmailOutput(init.get("from"), init.get("to"), port, send=self._send, production=bool(init.get("production")))

    def _send(self, mail: Any) -> None:
        if self._failure is not None:
            raise RuntimeError(self._failure)
        self._sent.append(dict(mail))

    def id(self) -> str:
        return self._output.id

    def write(self, event: Any) -> None:
        self._output.write(event)

    def sent(self) -> list[Any]:
        return self._sent

    def set_failure(self, message: Any) -> None:
        self._failure = message


SUBJECTS = {
    "observer": ObserverFacade,
    "observer-rules": RulesFacade,
    "observer-console": ConsoleFacade,
    "observer-webhook": webhook_facade,
    "observer-slack": slack_facade,
    "observer-email": email_facade,
    "observer-email-local": LocalEmailFacade,
    "observer-sms": sms_facade,
}
