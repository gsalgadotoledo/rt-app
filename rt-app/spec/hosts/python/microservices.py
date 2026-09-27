"""Subjects: microservice, session-authenticator, signed-jwt-authenticator, remote-feature
(mirrors hosts/node/microservices.mjs).

Features, authenticators, metering and remote responses are declared as data in init, so every
language builds the same service (microservices contract).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from rt_app import _js
from rt_app.errors import HttpError
from rt_app.jwt import JwtTokens
from rt_app.microservices import (
    MeteredEndpoint,
    Microservice,
    RemoteRequest,
    RemoteResponse,
    SessionAuthenticator,
    SignedJwtAuthenticator,
    remote_feature,
    remote_jwt_authenticator,
)
from rt_app.web import Context, Request

_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


def _ms(iso: str) -> int:
    moment = datetime.fromisoformat(iso[:-1] + "+00:00" if iso.endswith(("Z", "z")) else iso)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return (moment - _EPOCH) // timedelta(milliseconds=1)


def _failure(error: dict[str, Any]) -> Exception:
    status = error.get("status")
    if _js.is_number(status):
        return HttpError(int(status), error.get("message"))
    return RuntimeError(error.get("message"))


def _handler(reply: Any) -> Any:
    def handle(context: Context) -> Any:
        if isinstance(reply, dict) and reply.get("error"):
            raise _failure(reply["error"])
        if isinstance(reply, dict) and "value" in reply:
            return reply["value"]
        return {"params": context.params, "actor": context.actor, "headers": context.request.headers}

    return handle


def _endpoint(declared: dict[str, Any]) -> MeteredEndpoint:
    return MeteredEndpoint(
        method=declared.get("method"),
        path=declared.get("path"),
        resource=declared.get("resource"),
        access=declared.get("access"),
        handle=_handler(declared.get("reply")),
        tool=declared.get("tool"),
        explicit_grant=bool(declared.get("explicitGrant")),
        subscription=declared.get("subscription"),
    )


@dataclass(frozen=True)
class _Feature:
    id: str
    endpoints: Any
    migrations: Any = ()
    seeds: Any = None


def _feature(declared: dict[str, Any]) -> _Feature:
    return _Feature(
        id=declared.get("id"),
        endpoints=[_endpoint(e) for e in declared.get("endpoints") or []],
        migrations=declared.get("migrations") or (),
        seeds=declared.get("seeds"),
    )


def _request(r: Any) -> Request:
    r = r if isinstance(r, dict) else {}
    return Request(
        method=r.get("method") or "GET",
        path=r.get("path") or "/",
        headers=r.get("headers") or {},
        query=r.get("query") or {},
        body=r["body"] if r.get("body") is not None else {},
        ip=r.get("ip") or "127.0.0.1",
    )


class MicroserviceFacade:
    def __init__(self, init: Any) -> None:
        init = init if isinstance(init, dict) else {}
        self._authentications: list[str] = []
        self._observations: list[dict[str, Any]] = []
        self._metered: list[dict[str, Any]] = []
        tokens = init.get("tokens") or {}
        outer = self

        class Table:
            def authenticate(self, token: str) -> Any:
                outer._authentications.append(token)
                if token not in tokens:
                    raise HttpError(401, "Unknown token")
                entry = tokens[token]
                if isinstance(entry, dict) and entry.get("error"):
                    raise _failure(entry["error"])
                return entry

        metering = init.get("metering")

        def invoke_metered(endpoint: Any, actor: Any, work: Any) -> Any:
            self._metered.append({"resource": endpoint.resource, "subscription": endpoint.subscription, "actor": actor.get("id") if actor else None})
            if isinstance(metering, dict) and metering.get("error"):
                raise _failure(metering["error"])
            return work()

        observe = init.get("observe")

        def record(metric: dict[str, Any]) -> None:
            self._observations.append(metric)
            if observe == "fail":
                raise RuntimeError("telemetry down")

        self._service = Microservice(
            [_feature(f) for f in init.get("features") or []],
            Table(),
            invoke_metered=None if metering is None else invoke_metered,
            observe=None if observe == "none" else record,
        )

    def handle(self, request: Any) -> dict[str, Any]:
        response = self._service.handle(_request(request))
        return {"status": response.status, "body": response.body, "headers": dict(response.headers or [])}

    def authentications(self) -> list[str]:
        return self._authentications

    def observations(self) -> list[dict[str, Any]]:
        return self._observations

    def metered(self) -> list[dict[str, Any]]:
        return self._metered


class SessionFacade:
    def __init__(self, init: Any) -> None:
        self._now = _ms(init["now"])
        extra = {k: init[k] for k in ("issuer", "audience") if init.get(k) is not None}
        self._tokens = JwtTokens(init["secret"], **extra, now=lambda: self._now)
        self._resolved: list[Any] = []
        actors = init.get("actors") or {}

        def resolve(id: str) -> Any:
            self._resolved.append(id)
            return actors.get(id)

        self._auth = SessionAuthenticator(self._tokens, resolve)

    def authenticate(self, token: Any) -> Any:
        return self._auth.authenticate(token)

    def issue(self, user: Any) -> str:
        return self._tokens.issue(user)

    def resolved(self) -> list[Any]:
        return self._resolved

    def set_now(self, iso: str) -> None:
        self._now = _ms(iso)


def _js_key(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return "undefined" if value is None else str(value)


class SignedFacade:
    def __init__(self, init: Any) -> None:
        self._resolved: list[Any] = []
        self._actors = init.get("actors") or {}
        self._auth = SignedJwtAuthenticator(init.get("jwks"), init.get("issuer") or "", init.get("audience") or "", self._resolve)

    def _resolve(self, claims: dict[str, Any]) -> Any:
        self._resolved.append(claims)
        return self._actors.get(_js_key(claims.get("sub")))

    def authenticate(self, token: Any) -> Any:
        return self._auth.authenticate(token)

    def resolved(self) -> list[Any]:
        return self._resolved

    def remote(self, url: Any, issuer: Any = None, audience: Any = None) -> None:
        remote_jwt_authenticator(url, issuer or "", audience or "", self._resolve)


@dataclass
class _Recorder:
    responses: list[dict[str, Any]]
    requests: list[dict[str, Any]] = field(default_factory=list)

    def __call__(self, request: RemoteRequest) -> RemoteResponse:
        self.requests.append(
            {
                "url": request.url,
                "method": request.method,
                "headers": request.headers,
                "body": request.body,
                "redirect": request.redirect,
                "timeout": request.timeout_ms is not None,
            }
        )
        if not self.responses:
            raise RuntimeError("No response left")
        next = self.responses.pop(0)
        if next.get("network"):
            raise RuntimeError(next["network"])
        if "json" in next:
            return RemoteResponse(next["status"], _js.stringify(next["json"]).encode("utf-8"))
        return RemoteResponse(next["status"], (next.get("text") or "").encode("utf-8"))


class RemoteFacade:
    def __init__(self, init: Any) -> None:
        self._transport = _Recorder(list(init.get("responses") or []))
        timeout = init.get("timeoutMs")
        self._feature = remote_feature(_feature(init.get("feature") or {}), init.get("baseUrl"), self._transport, 10000 if timeout is None else timeout)

    def call(self, index: int, context: Any = None) -> Any:
        context = context if isinstance(context, dict) else {}
        endpoint = self._feature.endpoints[int(index)]
        return endpoint.handle(Context(request=_request(context.get("request")), params=context.get("params") or {}))

    def requests(self) -> list[dict[str, Any]]:
        return self._transport.requests

    def feature(self) -> dict[str, Any]:
        endpoints = []
        for e in self._feature.endpoints:
            item: dict[str, Any] = {"method": e.method, "path": e.path, "resource": e.resource, "access": e.access}
            if e.explicit_grant:
                item["explicitGrant"] = True
            if e.subscription is not None:
                item["subscription"] = e.subscription
            if e.tool is not None:
                item["tool"] = e.tool
            endpoints.append(item)
        out: dict[str, Any] = {"id": self._feature.id, "migrations": list(self._feature.migrations), "endpoints": endpoints}
        if self._feature.seeds is not None:
            out["seeds"] = self._feature.seeds
        return out


SUBJECTS = {
    "microservice": MicroserviceFacade,
    "session-authenticator": SessionFacade,
    "signed-jwt-authenticator": SignedFacade,
    "remote-feature": RemoteFacade,
}
