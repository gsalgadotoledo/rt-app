"""Transport-independent application: features, endpoints and dispatch (TypeScript semantics)."""
from __future__ import annotations

import inspect
import logging
import re
import urllib.parse
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from typing import Any, Literal, NotRequired, Protocol, TypedDict

from .. import _js
from ..errors import HttpError

log = logging.getLogger("rt_app.web")

Access = Literal["guest", "authenticated", "permission", "owner", "service"]
DEFAULT_BODY_LIMIT = 16 * 1024
ADMIN_PREFIX = "/admin/app"
#: Service endpoints (scoped service keys) live under this prefix, and nothing else does.
SERVICE_PREFIX = "/service/"


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
    #: The query string as received (without ``?``) and the body bytes, for proxies.
    query_string: str = ""
    body_bytes: bytes = b""


@dataclass
class Response:
    """A JSON response, or a raw one (``raw`` bytes with their own ``headers``) from a fallback."""

    status: int
    body: Any
    headers: list[tuple[str, str]] | None = None
    raw: bytes | None = None

    def text(self) -> str:
        """Body text: the raw bytes as UTF-8, or JSON; ``None`` (JavaScript undefined) is empty."""
        if self.raw is not None:
            return self.raw.decode("utf-8", "replace")
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


class ServicePolicy(Protocol):
    """What ``App`` needs to serve ``access="service"`` endpoints (``rt_app.service_keys.ServiceKeys``):
    the service actor of a request and the scope check."""

    def actor_from_request(self, request: Request) -> Any: ...

    def check(self, endpoint: Endpoint, actor: Any = None) -> None: ...


class AccessPolicy(Protocol):
    """What ``App`` needs to authorize a request (``rt_app.acl.ACL`` implements it)."""

    def check(self, endpoint: Endpoint, actor: Any = None) -> None: ...


#: Serves requests that match no endpoint (e.g. ``proxy_to("http://127.0.0.1:4000")``).
Fallback = Callable[[Request], Response]

_ACCESS_LEVELS = ("guest", "authenticated", "permission", "owner")
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


def admin_only(endpoint: Endpoint) -> bool:
    """Endpoints the TypeScript framework serves only under /admin/app (same list)."""
    path = endpoint.path
    return (
        (endpoint.access == "owner" and (path.startswith("/feature-flags") or path.startswith("/visits") or path == "/health/report"))
        or path.startswith("/infra")
        or path.startswith("/aws/")
        or path in ("/observer/report", "/observer/logs")
        or path.startswith("/subscriptions/admin/")
        or path.startswith("/service-keys")
    )


class App:
    """Features mounted into one API with the dispatch rules of the TypeScript framework.

    - every endpoint is served at its path, except the admin-only ones (``admin_only``);
    - owner and permission endpoints are also served under ``/admin/app<path>``;
    - literal routes win over ``:param`` routes; params are URL-decoded (400 "Invalid URL");
    - admin routes (``/admin/...``) only admit the admin root ``{"id": "rt-app-root"}``: the local
      owner with ``local_admin``, or whoever ``admin_authenticate(request)`` returns (401 "Sign in
      to admin" otherwise), like the TypeScript AdminIdentity;
    - ``authenticate(request)`` returns the actor for other protected routes (or None), e.g.
      ``auth.actor_from_request``; it may raise ``HttpError`` (401 for a bad token);
    - ``acl`` (e.g. ``rt_app.acl.ACL``) authorizes requests instead of the built-in policy;
    - ``fallback(request)`` answers requests that match no endpoint instead of 404, e.g.
      ``proxy_to("http://127.0.0.1:4000")`` forwards not-yet-ported routes to the Node core;
    - ``access="service"`` endpoints (paths under ``/service/``, never under ``/admin/app``) take
      only scoped service keys through ``service`` (e.g. ``rt_app.service_keys.ServiceKeys``);
      without it they answer 401.
    """

    def __init__(
        self,
        features: Sequence[Feature],
        *,
        local_admin: bool = False,
        authenticate: Callable[[Request], Actor | None] | None = None,
        admin_authenticate: Callable[[Request], Actor | None] | None = None,
        acl: AccessPolicy | None = None,
        fallback: Fallback | None = None,
        service: ServicePolicy | None = None,
    ) -> None:
        self.features = tuple(features)
        self.local_admin = local_admin
        self.authenticate = authenticate
        self.admin_authenticate = admin_authenticate
        self.acl = acl
        self.fallback = fallback
        self.service = service
        declared = [endpoint for feature in self.features for endpoint in feature.endpoints]
        endpoints: list[Endpoint] = [e for e in declared if not admin_only(e)] + [
            replace(e, path=ADMIN_PREFIX + e.path) for e in declared if e.access in ("owner", "permission")
        ]
        seen: set[str] = set()
        for endpoint in endpoints:
            # Service endpoints live under /service/ and nothing else does: one prefix, one credential.
            if (endpoint.access == "service") != endpoint.path.startswith(SERVICE_PREFIX):
                raise ValueError(f"Service endpoints must use /service/ paths: {endpoint.method} {endpoint.path}")
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

    def matches(self, method: str, path: str) -> bool:
        """Whether an endpoint serves this method and path."""
        return any(r.endpoint.method == method and r.pattern.fullmatch(path) for r in self._routes)

    def fallback_body_limit(self) -> int:
        """Body limit of requests handed to the fallback (its ``max_body_bytes``, else 16 KiB)."""
        return int(getattr(self.fallback, "max_body_bytes", DEFAULT_BODY_LIMIT))

    def body_limit(self, method: str, path: str) -> int:
        """Body limit of the endpoint that would serve this request (16 KiB by default)."""
        for route in self._routes:
            if route.endpoint.method == method and route.pattern.fullmatch(path):
                return route.endpoint.max_body_bytes
        return self.fallback_body_limit() if self.fallback else DEFAULT_BODY_LIMIT

    def _actor(self, endpoint: Endpoint, request: Request) -> Actor | None:
        if endpoint.access == "guest":
            return None
        if endpoint.access == "service":
            if self.service is not None:
                return self.service.actor_from_request(request)
            if not request.headers.get("authorization"):
                raise HttpError(401, "Service key required")
            raise HttpError(401, "Invalid service key")
        if endpoint.path.startswith("/admin/"):
            # The admin has its own identity (TypeScript AdminIdentity): the local root in local
            # mode, otherwise admin_authenticate (e.g. the admin password session).
            if self.local_admin:
                return dict(LOCAL_OWNER)  # type: ignore[return-value]
            return self.admin_authenticate(request) if self.admin_authenticate else None
        return self.authenticate(request) if self.authenticate else None

    def _check(self, endpoint: Endpoint, actor: Actor | None) -> None:
        if endpoint.access == "service":
            assert self.service is not None
            self.service.check(endpoint, actor)
            return
        # Admin routes use the admin identity's policy (TypeScript AdminIdentity.acl): only the
        # admin root may call them; roles, grants and explicit grants do not apply there.
        if endpoint.path.startswith("/admin/"):
            if endpoint.access != "guest" and (actor is None or actor.get("id") != "rt-app-root"):
                raise HttpError(401, "Sign in to admin")
            return
        if self.acl is not None:
            self.acl.check(endpoint, actor)
            return
        if endpoint.access == "guest":
            return
        # Fail closed like the TypeScript ACL: an unknown access value never opens an endpoint.
        if endpoint.access not in _ACCESS_LEVELS:
            raise HttpError(403, "You do not have permission to access this resource")
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
                if self.fallback is not None:
                    return self.fallback(request)
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
    method = method.upper()
    path, query = split_target(target)
    if len(raw) > app.body_limit(method, path):
        return Response(413, {"error": "Request body too large"})
    # Requests for the fallback keep their body as received (it may not be JSON).
    forwarded = app.fallback is not None and not app.matches(method, path)
    try:
        body = {} if forwarded else parse_body(raw)
    except HttpError as error:
        return Response(error.status, {"error": error.message})
    request = Request(
        method=method,
        path=path,
        body=body,
        query=parse_query(query),
        headers={k.lower(): v for k, v in headers.items()},
        raw_body=raw.decode("utf-8", "replace"),
        ip=ip,
        query_string=query,
        body_bytes=raw,
    )
    return app.handle(request)
