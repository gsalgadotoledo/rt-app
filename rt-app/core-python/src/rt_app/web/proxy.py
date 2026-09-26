"""Forward requests no Python endpoint serves to an upstream RT-App core (``App(fallback=...)``).

    app = App(features, authenticate=auth.actor_from_request, fallback=proxy_to("http://127.0.0.1:4000"))

A native Python API can serve the modules already ported and forward everything else to the Node
core running next to it. The upstream must be loopback (the core is never exposed through this
hop); hop-by-hop headers are stripped both ways, redirects are passed through, and an unreachable
or slow (15 s) upstream answers 502 ``{"error": "RT-App core is unavailable"}``.
"""
from __future__ import annotations

import http.client
import ipaddress
import logging
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Iterable

from .app import Request, Response

log = logging.getLogger("rt_app.web")

#: RFC 9110 hop-by-hop headers (plus ones the transport recomputes).
HOP_BY_HOP = frozenset({
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "trailers",
    "transfer-encoding",
    "upgrade",
})
_RECOMPUTED = frozenset({"host", "content-length"})
UNAVAILABLE = {"error": "RT-App core is unavailable"}


def is_loopback(host: str) -> bool:
    """``localhost`` or a loopback IP literal (127.0.0.0/8, ::1)."""
    if host.lower() in ("localhost", "localhost."):
        return True
    try:
        return ipaddress.ip_address(host.strip("[]")).is_loopback
    except ValueError:
        return False


def _connection_tokens(headers: Iterable[tuple[str, str]]) -> set[str]:
    """Header names listed in ``Connection`` are hop-by-hop too."""
    return {
        token.strip().lower()
        for name, value in headers
        if name.lower() == "connection"
        for token in value.split(",")
        if token.strip()
    }


def strip_hop_by_hop(headers: Iterable[tuple[str, str]]) -> list[tuple[str, str]]:
    headers = list(headers)
    drop = HOP_BY_HOP | _RECOMPUTED | _connection_tokens(headers)
    return [(name.lower(), value) for name, value in headers if name.lower() not in drop]


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Pass 3xx answers to the client instead of following them."""

    def redirect_request(self, *args: object, **kwargs: object) -> None:
        return None


class Proxy:
    """A fallback that forwards the request to ``upstream`` + its path and query."""

    def __init__(self, upstream: str, *, timeout: float = 15.0, max_body_bytes: int = 1024 * 1024) -> None:
        parts = urllib.parse.urlsplit(upstream)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise ValueError("proxy_to needs an http(s) URL such as http://127.0.0.1:4000")
        if not is_loopback(parts.hostname):
            raise ValueError("proxy_to only forwards to a loopback upstream (localhost, 127.0.0.1 or ::1)")
        if parts.query or parts.fragment:
            raise ValueError("The upstream URL cannot have a query or fragment")
        self.upstream = f"{parts.scheme}://{parts.netloc}{parts.path.rstrip('/')}"
        self.timeout = timeout
        self.max_body_bytes = max_body_bytes
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())

    def __repr__(self) -> str:
        return f"proxy_to({self.upstream!r})"

    def __call__(self, request: Request) -> Response:
        url = self.upstream + request.path + (f"?{request.query_string}" if request.query_string else "")
        headers = dict(strip_hop_by_hop(request.headers.items()))
        if request.ip:
            prior = headers.get("x-forwarded-for")
            headers["x-forwarded-for"] = f"{prior}, {request.ip}" if prior else request.ip
        if request.headers.get("host"):
            headers.setdefault("x-forwarded-host", request.headers["host"])
        data = request.body_bytes if request.body_bytes or request.method not in ("GET", "HEAD", "DELETE", "OPTIONS") else None
        upstream = urllib.request.Request(url, data=data, method=request.method, headers=headers)
        try:
            try:
                answer = self._opener.open(upstream, timeout=self.timeout)
            except urllib.error.HTTPError as error:  # 3xx/4xx/5xx are answers, not failures
                answer = error
            with answer:
                status, raw_headers, body = answer.status, answer.headers.items(), answer.read()
        except (urllib.error.URLError, http.client.HTTPException, OSError) as error:
            log.warning("RT-App core at %s is unavailable: %s", self.upstream, error)
            return Response(502, UNAVAILABLE)
        return Response(status or 502, None, headers=strip_hop_by_hop(raw_headers), raw=body)


def proxy_to(upstream: str, *, timeout: float = 15.0, max_body_bytes: int = 1024 * 1024) -> Proxy:
    """``App(fallback=proxy_to("http://127.0.0.1:4000"))``: forward unmatched requests to the core."""
    return Proxy(upstream, timeout=timeout, max_body_bytes=max_body_bytes)


__all__ = ["HOP_BY_HOP", "Proxy", "proxy_to", "is_loopback", "strip_hop_by_hop"]
