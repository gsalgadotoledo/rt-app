"""Subject: serviceKeys (rt_app.service_keys.ServiceKeys; mirrors hosts/node/service-keys.mjs).

init: {now?, secret, keys?, scopes, rows?}. Random bytes are deterministic: call n returns
``bytes`` bytes of value n % 256 as base64url, so generated ids and tokens match every language.
"""
from __future__ import annotations

from typing import Any

from identity import _Clock, _init
from storage import memory_store, rows_of

from rt_app import _js
from rt_app.service_keys import ServiceKeys, parse_service_keys, service_key_audit, service_key_hash

_DEFAULT_NOW = "2026-01-01T00:00:00.000Z"


class ServiceKeysFacade:
    def __init__(self, init: Any) -> None:
        init = _init(init)
        self._clock = _Clock(init.get("now") or _DEFAULT_NOW)
        self._store = memory_store(rows_of(init))
        self._calls = 0

        def random(size: int) -> str:
            self._calls += 1
            return _js.base64url_encode(bytes([self._calls % 256]) * size)

        self._keys = ServiceKeys(
            self._store,
            init.get("secret"),
            keys=init.get("keys"),
            scopes=init.get("scopes") or [],
            now=self._clock.now,
            random=random,
        )
        self._keys.validate()
        self._feature = self._keys.feature()

    def parse(self, config: Any, scopes: Any = None) -> Any:
        return [
            {k: key[k] for k in ("id", "secretHash", "scopes", "description", "rateLimit")}
            for key in parse_service_keys(config, scopes or [])
        ]

    def list(self) -> Any:
        return self._keys.list()

    def create(self, input: Any, actor_id: Any) -> Any:
        return self._keys.create(input, actor_id)

    def rotate(self, key_id: Any, actor_id: Any) -> Any:
        return self._keys.rotate(key_id, actor_id)

    def revoke(self, key_id: Any, actor_id: Any) -> Any:
        return self._keys.revoke(key_id, actor_id)

    def actor(self, authorization: Any = None) -> Any:
        return self._keys.actor(authorization)

    def check(self, endpoint: Any, actor: Any = None) -> None:
        self._keys.check(endpoint, actor)
        return None

    def authorize(self, authorization: Any, endpoint: Any) -> Any:
        actor = self._keys.actor(authorization)
        self._keys.check(endpoint, actor)
        return actor

    def hash(self, token: Any) -> Any:
        return service_key_hash(token)

    def endpoints(self) -> Any:
        return [
            {"method": e.method, "path": e.path, "access": e.access, "resource": e.resource, "tool": e.tool.get("name") if e.tool else None}
            for e in self._feature.endpoints
        ]

    def admin(self) -> Any:
        return self._feature.admin

    def self(self_, actor: Any) -> Any:  # noqa: N805 - the contract method is named "self"
        from rt_app.web import Context, Request

        endpoint = next(e for e in self_._feature.endpoints if e.path == "/service/keys/self")
        return endpoint.handle(Context(request=Request(method="GET", path=endpoint.path), params={}, actor=actor))

    def audit(self, key_id: Any) -> Any:
        rows = []
        cursor = None
        while True:
            page = self._store.list(service_key_audit(key_id), cursor)
            rows.extend({"sk": r["sk"], **r["data"]} for r in page["items"])
            cursor = page.get("cursor")
            if not cursor:
                return rows

    def row(self, pk: Any, sk: Any) -> Any:
        return self._store.get(pk, sk)

    def set_now(self, iso: Any) -> None:
        return self._clock.set(iso)


SUBJECTS = {"serviceKeys": ServiceKeysFacade}
