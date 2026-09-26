"""Transport-independent application: features, endpoints and dispatch (TypeScript semantics)."""
from __future__ import annotations

import inspect
import logging
import re
import urllib.parse
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from typing import Any, Literal, NotRequired, TypedDict

from .. import _js
from ..errors import HttpError

log = logging.getLogger("rt_app.web")

Access = Literal["guest", "authenticated", "permission", "owner"]
DEFAULT_BODY_LIMIT = 16 * 1024
ADMIN_PREFIX = "/admin/app"


class Actor(TypedDict):
    id: str
    role: str  # "owner" | "admin" | "user"
    grants: NotRequired[list[str]]


LOCAL_OWNER: Actor = {"id": "rt-app-root", "role": "owner"}


@dataclass
class Request:
    method: str
    path: str
    body: dict[str, Any] = field(default_factory=dict)
    query: dict[str, str] = field(default_factory=dict)
    headers: dict[str, str] = field(default_factory=dict)
    raw_body: str | None = None
    ip: str = ""


@dataclass
class Response:
    status: int
    body: Any

    def text(self) -> str:
        """JSON text of the body; ``None`` (JavaScript undefined) is an empty body."""
        return "" if self.body is None else _js.stringify(self.body)


@dataclass
class Context:
    request: Request
    params: dict[str, str]
    actor: Actor | None = None


@dataclass(frozen=True)
class Endpoint:
    method: str
    path: str
    resource: str
    access: Access
    handle: Callable[[Context], Any]
    tool: Mapping[str, Any] | None = None
    #: Require an explicit grant even for owners (permission endpoints only).
    explicit_grant: bool = False
    #: Largest request body accepted, in bytes.
    max_body_bytes: int = DEFAULT_BODY_LIMIT


@dataclass(frozen=True)
class Feature:
    id: str
    endpoints: Sequence[Endpoint]
    admin: Mapping[str, Any] | None = None


_BAD_PERCENT = re.compile(r"%(?![0-9A-Fa-f]{2})")


def decode_uri_component(text: str) -> str:
    """JavaScript ``decodeURIComponent``: raises ``ValueError`` on bad escapes or invalid UTF-8."""
    if _BAD_PERCENT.search(text):
        raise ValueError("Malformed percent escape")
    if "%" not in text:
        return text
    return urllib.parse.unquote_to_bytes(text).decode("utf-8")


@dataclass(frozen=True)
class _Route:
    endpoint: Endpoint
    names: tuple[str, ...]
    pattern: re.Pattern[str]


def _compile(endpoint: Endpoint) -> _Route:
    names: list[str] = []
    parts: list[str] = []
    for part in endpoint.path.split("/"):
        if part.startswith(":"):
            names.append(part[1:])
            parts.append("([^/]+)")
        else:
            parts.append(re.escape(part))
    return _Route(endpoint, tuple(names), re.compile("/".join(parts) + "/?"))


class App:
    """Features mounted into one API with the dispatch rules of the TypeScript framework.

    - guest and authenticated endpoints are served at their path;
    - owner and permission endpoints are served only under ``/admin/app<path>``;
    - literal routes win over ``:param`` routes; params are URL-decoded (400 "Invalid URL");
    - ``local_admin`` makes admin routes run as ``{"id": "rt-app-root", "role": "owner"}``;
    - ``authenticate(request)`` returns the actor for other protected routes (or None).
    """

    def __init__(
        self,
        features: Sequence[Feature],
        *,
        local_admin: bool = False,
        authenticate: Callable[[Request], Actor | None] | None = None,
    ) -> None:
        self.features = tuple(features)
        self.local_admin = local_admin
        self.authenticate = authenticate
        endpoints: list[Endpoint] = []
        for feature in self.features:
            for endpoint in feature.endpoints:
                if endpoint.access in ("owner", "permission"):
                    endpoint = replace(endpoint, path=ADMIN_PREFIX + endpoint.path)
                endpoints.append(endpoint)
        seen: set[str] = set()
        for endpoint in endpoints:
            signature = f"{endpoint.method} {endpoint.path}"
            if signature in seen:
                raise ValueError(f"Duplicate endpoint {signature}")
            seen.add(signature)
        # Literal routes take precedence over parameter routes (stable sort keeps feature order).
        endpoints.sort(key=lambda e: ":" in e.path)
        self.endpoints: tuple[Endpoint, ...] = tuple(endpoints)
        self._routes = tuple(_compile(e) for e in endpoints)

    def _match(self, method: str, path: str) -> tuple[Endpoint, dict[str, str]] | None:
        for route in self._routes:
            if route.endpoint.method != method:
                continue
            match = route.pattern.fullmatch(path)
            if match:
                try:
                    params = {n: decode_uri_component(v) for n, v in zip(route.names, match.groups())}
                except ValueError:
                    raise HttpError(400, "Invalid URL") from None
                return route.endpoint, params
        return None

    def body_limit(self, method: str, path: str) -> int:
        """Body limit of the endpoint that would serve this request (16 KiB by default)."""
        for route in self._routes:
            if route.endpoint.method == method and route.pattern.fullmatch(path):
                return route.endpoint.max_body_bytes
        return DEFAULT_BODY_LIMIT

    def _actor(self, endpoint: Endpoint, request: Request) -> Actor | None:
        if endpoint.access == "guest":
            return None
        if self.local_admin and endpoint.path.startswith("/admin/"):
            return dict(LOCAL_OWNER)  # type: ignore[return-value]
        return self.authenticate(request) if self.authenticate else None

    @staticmethod
    def _check(endpoint: Endpoint, actor: Actor | None) -> None:
        if endpoint.access == "guest":
            return
        if actor is None:
            raise HttpError(401, "Sign in")
        if endpoint.access == "owner" and actor.get("role") != "owner":
            raise HttpError(403, "Only the owner can perform this operation")
        if endpoint.access == "permission":
            grants = actor.get("grants") or []
            allowed = (
                endpoint.resource in grants
                if endpoint.explicit_grant
                else actor.get("role") == "owner" or endpoint.resource in grants
            )
            if not allowed:
                raise HttpError(403, "You do not have permission to access this resource")

    def handle(self, request: Request) -> Response:
        """Dispatch one request. Never raises: errors become ``{"error": message}`` responses."""
        try:
            found = self._match(request.method, request.path)
            if found is None:
                raise HttpError(404, "Endpoint not found")
            endpoint, params = found
            actor = self._actor(endpoint, request)
            self._check(endpoint, actor)
            result = endpoint.handle(Context(request=request, params=params, actor=actor))
            if inspect.isawaitable(result):
                result = _js.run_sync(result)
            return Response(200, None if result is None else _js.to_json(result))
        except HttpError as error:
            return Response(error.status, {"error": error.message})
        except Exception:
            log.exception("Unhandled error in %s %s", request.method, request.path)
            return Response(500, {"error": "Internal error"})


def parse_body(raw: bytes) -> dict[str, Any]:
    """Request body rules shared by every adapter: empty is ``{}``, otherwise a JSON object."""
    if not raw:
        return {}
    try:
        body = _js.parse(raw.decode("utf-8", "replace"))
    except ValueError:
        raise HttpError(400, "Invalid JSON") from None
    if not isinstance(body, dict):
        raise HttpError(400, "Invalid JSON")
    return body


def parse_query(query: str) -> dict[str, str]:
    """``Object.fromEntries(new URLSearchParams(query))``: the last value of a repeated name wins."""
    return dict(urllib.parse.parse_qsl(query, keep_blank_values=True))


def split_target(target: str) -> tuple[str, str]:
    """``/path?query#hash`` → (path, query)."""
    target = target.split("#", 1)[0]
    path, _, query = target.partition("?")
    return path or "/", query


def serve_raw(
    app: App,
    method: str,
    target: str,
    headers: Mapping[str, str],
    raw: bytes,
    ip: str = "",
) -> Response:
    """Apply the adapter rules (body limit, JSON object bodies) and dispatch."""
    path, query = split_target(target)
    if len(raw) > app.body_limit(method, path):
        return Response(413, {"error": "Request body too large"})
    try:
        body = parse_body(raw)
    except HttpError as error:
        return Response(error.status, {"error": error.message})
    request = Request(
        method=method.upper(),
        path=path,
        body=body,
        query=parse_query(query),
        headers={k.lower(): v for k, v in headers.items()},
        raw_body=raw.decode("utf-8", "replace"),
        ip=ip,
    )
    return app.handle(request)
