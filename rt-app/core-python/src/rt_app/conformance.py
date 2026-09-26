"""Contract host, protocol v1: serve module implementations to ``rta-contract`` over loopback HTTP.

    GET    /rt-contract/v1                           → {protocol, language, runtime, subjects}
    POST   /rt-contract/v1/instances                 {subject, init} → {ok, id} | {ok:false, error}
    POST   /rt-contract/v1/instances/<id>/<method>   {args:[…]}      → {ok, value} | {ok:false, error}
    DELETE /rt-contract/v1/instances/<id>                             → {ok}

Errors raised by a module are results ``{type, status?, code?, message}``, not protocol failures.
Contract method names are camelCase and map to snake_case; names starting with ``_`` are never
callable. Unknown subjects, instances or methods answer HTTP 404 with ``{protocolError}``.
"""
from __future__ import annotations

import base64
import dataclasses
import enum
import inspect
import math
import platform
import re
import signal
import sys
import threading
import urllib.parse
from collections.abc import Callable, Mapping
from datetime import date, datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from . import _js

PROTOCOL = 1
READY = "RT_CONTRACT_READY"
BASE = "/rt-contract/v1"
MAX_BODY = 5 * 1024 * 1024
MAX_INSTANCES = 1000

SubjectFactory = Callable[[Any], Any]


class ProtocolError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


# --- wire values -----------------------------------------------------------------------------


def encode(value: Any) -> Any:
    """Native value → wire JSON: datetime → {"$date"}, bytes → {"$bytes"}, dataclasses → objects."""
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("Non-finite numbers cannot be encoded")
        return value
    if isinstance(value, datetime):
        return {"$date": _js.iso_timestamp(value)}
    if isinstance(value, date):
        return {"$date": _js.iso_timestamp(datetime(value.year, value.month, value.day, tzinfo=timezone.utc))}
    if isinstance(value, (bytes, bytearray, memoryview)):
        return {"$bytes": base64.b64encode(bytes(value)).decode("ascii")}
    if isinstance(value, enum.Enum):
        return encode(value.value)
    if isinstance(value, Mapping):
        return {str(k): encode(v) for k, v in value.items() if not callable(v)}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [encode(v) for v in value]
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return {f.name: encode(getattr(value, f.name)) for f in dataclasses.fields(value)}
    if hasattr(value, "__dict__"):
        return {k: encode(v) for k, v in vars(value).items() if not k.startswith("_") and not callable(v)}
    raise ValueError(f"Cannot encode {type(value).__name__}")


def _parse_date(text: str) -> datetime:
    moment = datetime.fromisoformat(text[:-1] + "+00:00" if text.endswith(("Z", "z")) else text)
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


def decode(value: Any) -> Any:
    """Wire JSON → native value: {"$date"} → aware datetime, {"$bytes"} → bytes, {"$bigint"} → int."""
    if isinstance(value, list):
        return [decode(v) for v in value]
    if isinstance(value, dict):
        if len(value) == 1:
            if isinstance(value.get("$bigint"), str):
                return int(value["$bigint"])
            if isinstance(value.get("$date"), str):
                return _parse_date(value["$date"])
            if isinstance(value.get("$bytes"), str):
                return base64.b64decode(value["$bytes"])
        return {k: decode(v) for k, v in value.items()}
    return value


def describe_error(error: BaseException) -> dict[str, Any]:
    """Exception raised by a module → wire error ``{type, status?, code?, message}``."""
    described: dict[str, Any] = {"type": type(error).__name__}
    status = getattr(error, "status", None)
    if isinstance(status, int) and not isinstance(status, bool):
        described["status"] = status
    code = getattr(error, "code", None)
    if isinstance(code, str):
        described["code"] = code
    message = getattr(error, "message", None)
    described["message"] = message if isinstance(message, str) else str(error)
    return described


# --- host ------------------------------------------------------------------------------------

_NAME = re.compile(r"[A-Za-z][A-Za-z0-9_]*")


def snake_case(name: str) -> str:
    """``listPage`` → ``list_page``."""
    return re.sub(r"(?<=[a-z0-9])([A-Z])|(?<=[A-Z])([A-Z])(?=[a-z])", r"_\1\2", name).lower()


def _method(instance: Any, name: str) -> Callable[..., Any] | None:
    """A public callable attribute; never private (``_x``) names."""
    if not name or name.startswith("_") or not _NAME.fullmatch(name):
        return None
    fn = getattr(instance, name, None)
    return fn if callable(fn) else None


def _resolve(value: Any) -> Any:
    return _js.run_sync(value) if inspect.isawaitable(value) else value


class ContractHost:
    """Contract host state: subjects, live instances and the HTTP server."""

    def __init__(
        self,
        subjects: Mapping[str, SubjectFactory],
        *,
        language: str = "python",
        port: int = 0,
        method_name: Callable[[str], str] = snake_case,
    ) -> None:
        self.subjects = dict(subjects)
        self.language = language
        self.method_name = method_name
        self.instances: dict[str, Any] = {}
        self._next = 0
        self._lock = threading.Lock()
        self.server = ThreadingHTTPServer(("127.0.0.1", port), self._handler())
        self.server.daemon_threads = True
        host, bound = self.server.server_address[:2]
        self.url = f"http://{host}:{bound}{BASE}"

    def serve_forever(self) -> None:
        self.server.serve_forever()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    # Request handling ----------------------------------------------------------------------

    def _route(self, method: str, target: str, headers: Mapping[str, str], read: Callable[[], Any]) -> tuple[int, Any]:
        if headers.get("origin"):
            raise ProtocolError(403, "Browsers may not call a contract host")
        path = urllib.parse.urlsplit(target).path
        if not path.startswith(BASE):
            raise ProtocolError(404, "Not a contract host path")
        parts = [urllib.parse.unquote(p, errors="strict") for p in path[len(BASE) :].split("/") if p]
        if method == "GET" and not parts:
            return 200, {
                "protocol": PROTOCOL,
                "language": self.language,
                "runtime": f"{sys.implementation.name} {platform.python_version()}",
                "subjects": sorted(self.subjects),
            }
        if method == "POST" and parts == ["instances"]:
            body = read()
            body = body if isinstance(body, dict) else {}
            subject = body.get("subject")
            factory = self.subjects.get(subject) if isinstance(subject, str) else None
            if not callable(factory):
                raise ProtocolError(404, f"Unknown subject: {_js_string(subject)}")
            with self._lock:
                if len(self.instances) >= MAX_INSTANCES:
                    raise ProtocolError(429, "Too many live instances; delete them after each case")
            try:
                instance = _resolve(factory(decode(body.get("init", {}))))
            except Exception as error:
                return 200, {"ok": False, "error": describe_error(error)}
            with self._lock:
                self._next += 1
                instance_id = str(self._next)
                self.instances[instance_id] = instance
            return 200, {"ok": True, "id": instance_id}
        if parts and parts[0] == "instances" and len(parts) == 2 and method == "DELETE":
            with self._lock:
                instance = self.instances.pop(parts[1], None)
            close = _method(instance, "dispose") or _method(instance, "close") or _method(instance, "aclose")
            if close is not None:
                try:
                    _resolve(close())
                except Exception:
                    pass  # closing errors are not part of a case
            return 200, {"ok": True}
        if parts and parts[0] == "instances" and len(parts) == 3 and method == "POST":
            with self._lock:
                if parts[1] not in self.instances:
                    raise ProtocolError(404, f"Unknown instance: {parts[1]}")
                instance = self.instances[parts[1]]
            fn = _method(instance, self.method_name(parts[2])) if _NAME.fullmatch(parts[2]) else None
            if fn is None:
                raise ProtocolError(404, f"Unknown method: {parts[2]}")
            body = read()
            args = body.get("args", []) if isinstance(body, dict) else None
            if not isinstance(args, list):
                raise ProtocolError(400, "args must be a list")
            try:
                value = _resolve(fn(*(decode(a) for a in args)))
                return 200, {"ok": True, "value": encode(value)}
            except Exception as error:
                return 200, {"ok": False, "error": describe_error(error)}
        raise ProtocolError(404, "Unknown contract host route")

    def _handler(self) -> type[BaseHTTPRequestHandler]:
        host = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"
            server_version = "rt-app-contract-host"

            def _read(self) -> Any:
                length = int(self.headers.get("content-length") or 0)
                if length > MAX_BODY:
                    self.close_connection = True
                    raise ProtocolError(413, "Body too large")
                raw = self.rfile.read(length) if length > 0 else b""
                self._consumed = True
                if not raw:
                    return {}
                try:
                    return _js.parse(raw.decode("utf-8"))
                except ValueError:
                    raise ProtocolError(400, "Invalid JSON") from None

            def _serve(self) -> None:
                self._consumed = False
                headers = {k.lower(): v for k, v in self.headers.items()}
                try:
                    status, value = host._route(self.command, self.path, headers, self._read)
                except ProtocolError as error:
                    status, value = error.status, {"protocolError": str(error)}
                except Exception as error:
                    status, value = 500, {"protocolError": str(error)}
                if not self._consumed:
                    # Drain an unread body so the connection stays usable.
                    length = int(self.headers.get("content-length") or 0)
                    if 0 < length <= MAX_BODY:
                        self.rfile.read(length)
                    elif length:
                        self.close_connection = True
                try:
                    text = _js.stringify(value)
                except Exception as error:
                    status, text = 500, _js.stringify({"protocolError": str(error)})
                data = text.encode("utf-8")
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = _serve

            def log_message(self, format: str, *args: object) -> None:  # noqa: A002
                pass

        return Handler


def _js_string(value: Any) -> str:
    """``String(value)`` for protocol messages."""
    if value is None:
        return "undefined"
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def serve_contracts(
    subjects: Mapping[str, SubjectFactory],
    *,
    language: str = "python",
    port: int = 0,
    method_name: Callable[[str], str] = snake_case,
) -> ContractHost:
    """Start a contract host on 127.0.0.1 in a background thread; ``host.url`` ends with /rt-contract/v1."""
    host = ContractHost(subjects, language=language, port=port, method_name=method_name)
    threading.Thread(target=host.serve_forever, name="rt-contract-host", daemon=True).start()
    return host


def run_host(
    subjects: Mapping[str, SubjectFactory],
    *,
    language: str = "python",
    port: int = 0,
    method_name: Callable[[str], str] = snake_case,
) -> None:
    """Serve, print ``RT_CONTRACT_READY <url>`` and block until SIGTERM/SIGINT."""
    host = ContractHost(subjects, language=language, port=port, method_name=method_name)
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    threading.Thread(target=host.serve_forever, name="rt-contract-host", daemon=True).start()
    print(f"{READY} {host.url}", flush=True)
    while not stop.wait(0.5):
        pass
    host.close()


__all__ = [
    "PROTOCOL",
    "READY",
    "BASE",
    "ContractHost",
    "ProtocolError",
    "encode",
    "decode",
    "describe_error",
    "snake_case",
    "serve_contracts",
    "run_host",
]
