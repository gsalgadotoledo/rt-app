"""Local HTTP server for an App (stdlib ``http.server``), bound to 127.0.0.1."""
from __future__ import annotations

import os
import signal
import sys
import threading
from collections.abc import Callable
from typing import Any
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .app import App, Response, serve_raw

JSON_HEADERS = {"content-type": "application/json", "cache-control": "no-store"}

#: (method, target, headers, raw body, client ip) → (status, headers, body text or bytes).
#: Headers are a mapping or (name, value) pairs (repeated names such as set-cookie).
RawHandler = Callable[
    [str, str, dict[str, str], bytes, str],
    tuple[int, "dict[str, str] | list[tuple[str, str]]", "str | bytes"],
]


class _TooLarge(Exception):
    pass


def _handler_class(handle: RawHandler, max_read: int) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "rt-app"

        def _read_body(self) -> bytes:
            if "chunked" in (self.headers.get("transfer-encoding") or "").lower():
                chunks: list[bytes] = []
                size = 0
                while True:
                    length = int(self.rfile.readline().split(b";", 1)[0].strip() or b"0", 16)
                    if length == 0:
                        while self.rfile.readline() not in (b"\r\n", b"\n", b""):
                            pass
                        return b"".join(chunks)
                    size += length
                    if size > max_read:
                        raise _TooLarge()
                    chunks.append(self.rfile.read(length))
                    self.rfile.readline()
            length = int(self.headers.get("content-length") or 0)
            if length > max_read:
                raise _TooLarge()
            return self.rfile.read(length) if length > 0 else b""

        def _send(self, status: int, headers: dict[str, str] | list[tuple[str, str]], body: str | bytes) -> None:
            data = body.encode("utf-8") if isinstance(body, str) else body
            self.send_response(status)
            for name, value in headers.items() if isinstance(headers, dict) else headers:
                self.send_header(name, value)
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(data)

        def _serve(self) -> None:
            try:
                raw = self._read_body()
            except _TooLarge:
                self.close_connection = True
                self._send(413, JSON_HEADERS, '{"error":"Request body too large"}')
                return
            except ValueError:
                self.close_connection = True
                self._send(400, JSON_HEADERS, '{"error":"Invalid request"}')
                return
            headers: dict[str, str] = {}
            for name, value in self.headers.items():
                key = name.lower()
                headers[key] = f"{headers[key]}, {value}" if key in headers else value
            status, response_headers, text = handle(self.command, self.path, headers, raw, self.client_address[0])
            self._send(status, response_headers, text)

        do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = do_HEAD = _serve

        def log_message(self, format: str, *args: object) -> None:  # noqa: A002 - stdlib signature
            if os.environ.get("RT_APP_ACCESS_LOG"):
                super().log_message(format, *args)

    return Handler


def app_handler(app: App) -> RawHandler:
    def handle(method: str, target: str, headers: dict[str, str], raw: bytes, ip: str) -> tuple[int, Any, str | bytes]:
        response: Response = serve_raw(app, method, target, headers, raw, ip)
        if response.raw is not None:  # a fallback answer (e.g. proxied), sent as received
            return response.status, list(response.headers or []), response.raw
        return response.status, dict(JSON_HEADERS), response.text()

    return handle


def make_server(handle: RawHandler, port: int = 0, *, host: str = "127.0.0.1", max_read: int = 16 * 1024) -> ThreadingHTTPServer:
    """A threading HTTP server; ``max_read`` bodies larger than this are refused with 413 unread."""
    server = ThreadingHTTPServer((host, port), _handler_class(handle, max_read))
    server.daemon_threads = True
    return server


def run_forever(server: ThreadingHTTPServer, label: str) -> None:
    """Serve until SIGTERM/SIGINT, announcing the URL on stdout."""
    host, port = server.server_address[:2]
    print(f"{label}: http://{host}:{port}", flush=True)

    def stop(*_: object) -> None:
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        server.serve_forever()
    finally:
        server.server_close()


def serve(app: App, port: int | None = None, *, host: str = "127.0.0.1") -> None:
    """Serve ``app`` on 127.0.0.1:``port`` (default ``$PORT`` or 4010) until stopped.

    Bodies over the endpoint limit (16 KiB by default) answer 413; bodies must be JSON objects.
    """
    port = int(os.environ.get("PORT", "4010")) if port is None else port
    limit = max([e.max_body_bytes for e in app.endpoints] + [app.fallback_body_limit() if app.fallback else 16 * 1024])
    server = make_server(app_handler(app), port, host=host, max_read=limit)
    run_forever(server, "RT-App API")
    sys.stdout.flush()
