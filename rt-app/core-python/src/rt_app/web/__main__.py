"""Command line for RT-App web applications.

    python -m rt_app.web serve app:app                 # HTTP on 127.0.0.1:$PORT
    python -m rt_app.web lambda-local app:app          # HTTP → API Gateway v2 events → Lambda handler
    python -m rt_app.web call app:app GET /health/live [--body JSON] [--header k:v]

``module:attr`` is imported from the current directory; ``attr`` may be an App or a function
returning one (``app:create_app``).
"""
from __future__ import annotations

import argparse
import base64
import importlib
import json
import os
import sys
import time
import uuid
from collections.abc import Sequence

from .app import App, serve_raw, split_target
from .aws_lambda import handler_for
from .server import make_server, run_forever, serve


def load_app(spec: str) -> App:
    """Import ``module:attr`` (from the current directory) and return the App it names."""
    module_name, _, attr = spec.partition(":")
    if not module_name or not attr:
        raise SystemExit(f"Expected module:attr, got {spec!r}")
    cwd = os.getcwd()
    if cwd not in sys.path:
        sys.path.insert(0, cwd)
    target: object = importlib.import_module(module_name)
    for part in attr.split("."):
        target = getattr(target, part)
    if not isinstance(target, App) and callable(target):
        target = target()
    if not isinstance(target, App):
        raise SystemExit(f"{spec} is not an rt_app.web.App")
    return target


def api_gateway_v2_event(method: str, target: str, headers: dict[str, str], raw: bytes, ip: str) -> dict[str, object]:
    """The event API Gateway (HTTP API, payload 2.0) sends for this request."""
    path, query = split_target(target)
    cookies = [c.strip() for c in headers.get("cookie", "").split(";") if c.strip()]
    now = time.time()
    return {
        "version": "2.0",
        "routeKey": "$default",
        "rawPath": path,
        "rawQueryString": query,
        **({"cookies": cookies} if cookies else {}),
        "headers": {k: v for k, v in headers.items() if k != "cookie"},
        "requestContext": {
            "accountId": "local",
            "apiId": "local",
            "domainName": headers.get("host", "localhost"),
            "http": {
                "method": method,
                "path": path,
                "protocol": "HTTP/1.1",
                "sourceIp": ip,
                "userAgent": headers.get("user-agent", ""),
            },
            "requestId": str(uuid.uuid4()),
            "routeKey": "$default",
            "stage": "$default",
            "time": time.strftime("%d/%b/%Y:%H:%M:%S +0000", time.gmtime(now)),
            "timeEpoch": int(now * 1000),
        },
        "body": base64.b64encode(raw).decode("ascii"),
        "isBase64Encoded": True,
    }


def lambda_local(app: App, port: int | None = None) -> None:
    """Serve HTTP by converting each request to an API Gateway v2 event for ``handler_for(app)``."""
    handler = handler_for(app)

    def handle(method: str, target: str, headers: dict[str, str], raw: bytes, ip: str) -> tuple[int, dict[str, str], str]:
        result = handler(api_gateway_v2_event(method, target, headers, raw, ip), None)
        body = result.get("body", "")
        if result.get("isBase64Encoded"):
            body = base64.b64decode(body).decode("utf-8", "replace")
        return int(result["statusCode"]), dict(result.get("headers") or {}), body

    port = int(os.environ.get("PORT", "4010")) if port is None else port
    # API Gateway accepts up to 10 MB; the handler itself enforces the endpoint limit (16 KiB).
    server = make_server(handle, port, max_read=10 * 1024 * 1024)
    run_forever(server, "RT-App API (Lambda local)")


def call(app: App, method: str, target: str, body: str | None, headers: Sequence[str]) -> int:
    parsed: dict[str, str] = {}
    for header in headers:
        name, sep, value = header.partition(":")
        if not sep:
            raise SystemExit(f"Headers are name:value, got {header!r}")
        parsed[name.strip().lower()] = value.strip()
    raw = (body or "").encode("utf-8")
    if raw and "content-type" not in parsed:
        parsed["content-type"] = "application/json"
    response = serve_raw(app, method, target, parsed, raw, "127.0.0.1")
    text = response.text()
    if text:
        print(json.dumps(json.loads(text), indent=2, ensure_ascii=False))
    return 0 if response.status < 400 else 1


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m rt_app.web", description="Run an RT-App Python API.")
    commands = parser.add_subparsers(dest="command", required=True)
    serve_cmd = commands.add_parser("serve", help="HTTP server on 127.0.0.1:$PORT")
    serve_cmd.add_argument("app", help="module:attr")
    local_cmd = commands.add_parser("lambda-local", help="HTTP server that invokes the Lambda handler")
    local_cmd.add_argument("app", help="module:attr")
    call_cmd = commands.add_parser("call", help="call one endpoint and print the JSON body")
    call_cmd.add_argument("app", help="module:attr")
    call_cmd.add_argument("method")
    call_cmd.add_argument("path", help="path with an optional ?query")
    call_cmd.add_argument("--body", help="JSON object")
    call_cmd.add_argument("--header", action="append", default=[], help="name:value (repeatable)")
    args = parser.parse_args(argv)

    app = load_app(args.app)
    if args.command == "serve":
        serve(app)
        return 0
    if args.command == "lambda-local":
        lambda_local(app)
        return 0
    return call(app, args.method.upper(), args.path, args.body, args.header)


if __name__ == "__main__":
    sys.exit(main())
