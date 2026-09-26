"""AWS Lambda adapter for API Gateway events (HTTP API v2 and REST API v1). No dependencies."""
from __future__ import annotations

import base64
import urllib.parse
from collections.abc import Callable, Mapping
from typing import Any

from .app import App, serve_raw

LambdaHandler = Callable[[Mapping[str, Any], Any], dict[str, Any]]


def _headers(event: Mapping[str, Any]) -> dict[str, str]:
    headers: dict[str, str] = {}
    multi = event.get("multiValueHeaders") or {}
    for name, values in multi.items():
        if values:
            headers[name.lower()] = ", ".join(str(v) for v in values)
    for name, value in (event.get("headers") or {}).items():
        if value is not None and name.lower() not in headers:
            headers[name.lower()] = str(value)
    cookies = event.get("cookies")
    if cookies and "cookie" not in headers:
        headers["cookie"] = "; ".join(cookies)
    return headers


def _query(event: Mapping[str, Any], v2: bool) -> str:
    if v2 and isinstance(event.get("rawQueryString"), str):
        return event["rawQueryString"]
    pairs: list[tuple[str, str]] = []
    multi = event.get("multiValueQueryStringParameters")
    if multi:
        for name, values in multi.items():
            if values:
                pairs.append((name, values[-1]))
    else:
        pairs.extend((event.get("queryStringParameters") or {}).items())
    return urllib.parse.urlencode(pairs)


def parse_event(event: Mapping[str, Any]) -> tuple[str, str, dict[str, str], bytes, str]:
    """API Gateway event → (method, target, lowercase headers, raw body, source ip)."""
    context = event.get("requestContext") or {}
    v2 = event.get("version") == "2.0" or "http" in context
    if v2:
        method = context.get("http", {}).get("method", "GET")
        path = event.get("rawPath") or context.get("http", {}).get("path") or "/"
        ip = context.get("http", {}).get("sourceIp", "")
    else:
        method = event.get("httpMethod", "GET")
        path = event.get("path") or "/"
        ip = (context.get("identity") or {}).get("sourceIp", "")
    body = event.get("body") or ""
    raw = base64.b64decode(body) if event.get("isBase64Encoded") else body.encode("utf-8")
    query = _query(event, v2)
    return method, path + ("?" + query if query else ""), _headers(event), raw, ip or ""


def handler_for(app: App) -> LambdaHandler:
    """``handler = handler_for(app)``: the Lambda entry point for API Gateway v1/v2 events."""

    def handler(event: Mapping[str, Any], context: Any = None) -> dict[str, Any]:
        method, target, headers, raw, ip = parse_event(event)
        response = serve_raw(app, method, target, headers, raw, ip)
        return {
            "statusCode": response.status,
            "headers": {"content-type": "application/json", "cache-control": "no-store"},
            "body": response.text(),
            "isBase64Encoded": False,
        }

    return handler
