"""Scoped service keys: credentials for backends (port of ``packages/auth/src/service-keys.ts``).

A backend (an agent server metering credits) presents ``Authorization: Bearer
rtsk_<id>.<secret>`` and reaches ONLY endpoints with ``access="service"`` (paths under
``/service/``) whose ``resource`` is one of the key's scopes. It never reaches ``/admin/*``, users,
settings or plans. Keys come from the configuration (``RT_APP_SERVICE_KEYS`` JSON or the file named
by ``RT_APP_SERVICE_KEYS_FILE``) or are managed by the admin (the token is shown once; rotate;
revoke). Only ``sha256hex(token)`` is stored.

Rows (shared with the TypeScript and Go implementations; contract
``spec/contracts/service-keys.contract.yaml``, notes in ``docs/polyglot/service-keys.md``):

- ``SERVICE_KEYS/<id>`` ``{id, description, scopes, rateLimit, secretHash, source: "admin",
  createdAt, createdBy, rotatedAt, revokedAt, revokedBy}``;
- ``SERVICE_KEY_USE/<id>`` ``{lastUsedAt}`` (at most one write per minute);
- ``SERVICE_KEY_AUDIT#<id>/pad15(at)-pad10(version)`` ``{keyId, action, actorId, at, ...}``;
- ``RATE`` rows of ``"service-key:<id>"`` (the auth rate limit).
"""
from __future__ import annotations

import hashlib
import hmac
import os
import re
import secrets
from collections.abc import Callable, Mapping, Sequence
from typing import Any, Final

from . import _js
from ._jsnum import js_string, js_trim
from .auth_sessions import rate_limit
from .contracts import Clock, epoch_ms
from .errors import Conflict, HttpError
from .nosql import NoSQL, Row, Write

SERVICE_KEY_PREFIX: Final = "rtsk_"
_TOKEN = re.compile(r"rtsk_([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{32,128})")
_KEY_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")
_SECRET = re.compile(r"[A-Za-z0-9_-]{32,128}")
_HASH = re.compile(r"[0-9a-f]{64}")
#: Compared when the key id is unknown, so every failure costs one hash and one compare.
_NO_HASH: Final = "0" * 64

SERVICE_KEYS: Final = "SERVICE_KEYS"
SERVICE_KEY_USE: Final = "SERVICE_KEY_USE"
DEFAULT_SERVICE_RATE_LIMIT: Final = 600
MAX_SERVICE_RATE_LIMIT: Final = 100_000
SERVICE_KEY_TOUCH_MS: Final = 60_000
#: Resource of ``GET /service/keys/self``.
SERVICE_SELF: Final = "service-keys.self"

INVALID_SERVICE_KEY: Final = "Invalid service key"
SERVICE_KEY_REQUIRED: Final = "Service key required"
SERVICE_KEY_SCOPE: Final = "Service key not allowed for this resource"
_INVALID_CONFIGURATION: Final = "Invalid service key configuration"


def service_key_audit(key_id: str) -> str:
    """Partition of a key's management audit rows."""
    return "SERVICE_KEY_AUDIT#" + key_id


def service_key_hash(token: str) -> str:
    """sha256 hex of the UTF-8 token: the stored form of a key (lone surrogates as U+FFFD)."""
    return hashlib.sha256(token.encode("utf-8", "replace")).hexdigest()


def _base64url(size: int) -> str:
    return _js.base64url_encode(secrets.token_bytes(size))


def _pad(value: Any, width: int) -> str:
    return js_string(value).rjust(width, "0")


def _scope_list(value: Any, known: Sequence[str]) -> list[str] | None:
    """A non-empty list (at most 20) of known scopes; duplicates removed, order kept."""
    if not isinstance(value, list) or not 1 <= len(value) <= 20:
        return None
    if any(not isinstance(s, str) or s not in known for s in value):
        return None
    return list(dict.fromkeys(value))


def _rate_limit_of(value: Any) -> Any:
    if value is None:
        return DEFAULT_SERVICE_RATE_LIMIT
    if _js.is_safe_integer(value) and 1 <= value <= MAX_SERVICE_RATE_LIMIT:
        return value
    return None


def parse_service_keys(value: Any, known_scopes: Sequence[str]) -> list[dict[str, Any]]:
    """Validate configured keys (the parsed RT_APP_SERVICE_KEYS value); 400 "Invalid service key
    configuration" on any problem, [] for None."""

    def fail() -> HttpError:
        return HttpError(400, _INVALID_CONFIGURATION)

    if value is None:
        return []
    if not isinstance(value, list) or len(value) > 100:
        raise fail()
    keys: list[dict[str, Any]] = []
    for entry in value:
        if not isinstance(entry, Mapping):
            raise fail()
        key_id = entry.get("id")
        if not isinstance(key_id, str) or not _KEY_ID.fullmatch(key_id):
            raise fail()
        secret_hash, secret = entry.get("secretHash"), entry.get("secret")
        if (secret_hash is not None) == (secret is not None):
            raise fail()
        if secret_hash is not None and (not isinstance(secret_hash, str) or not _HASH.fullmatch(secret_hash)):
            raise fail()
        if secret is not None and (not isinstance(secret, str) or not _SECRET.fullmatch(secret)):
            raise fail()
        scopes = _scope_list(entry.get("scopes"), known_scopes)
        if scopes is None:
            raise fail()
        description = entry.get("description")
        description = "" if description is None else description
        if not isinstance(description, str) or _js.utf16_length(js_trim(description)) > 200:
            raise fail()
        limit = _rate_limit_of(entry.get("rateLimit"))
        if limit is None:
            raise fail()
        if any(k["id"] == key_id for k in keys):
            raise fail()
        keys.append(
            {
                "id": key_id,
                "secretHash": secret_hash if secret_hash is not None else service_key_hash(SERVICE_KEY_PREFIX + key_id + "." + secret),
                "scopes": scopes,
                "description": js_trim(description),
                "rateLimit": limit,
                "source": "env",
                "createdAt": None,
                "createdBy": None,
                "rotatedAt": None,
                "revokedAt": None,
                "revokedBy": None,
            }
        )
    return keys


def service_keys_from_env(env: Mapping[str, str] | None = None) -> Any:
    """Configured keys from RT_APP_SERVICE_KEYS (JSON) or the file named by
    RT_APP_SERVICE_KEYS_FILE; None when nothing is configured. Bad JSON: 400 "Invalid service key
    configuration"."""
    env = os.environ if env is None else env
    text = env.get("RT_APP_SERVICE_KEYS")
    if not text and env.get("RT_APP_SERVICE_KEYS_FILE"):
        with open(env["RT_APP_SERVICE_KEYS_FILE"], encoding="utf-8") as file:
            text = file.read()
    if not text or not js_trim(text):
        return None
    try:
        return _js.parse(text)
    except ValueError:
        raise HttpError(400, _INVALID_CONFIGURATION) from None


def _revoked(key: Mapping[str, Any]) -> bool:
    return key.get("revokedAt") is not None


class ServiceKeys:
    """Service key policy, management and admin feature.

    ``keys`` are the configured keys (validated on first use and by ``validate()``); ``scopes``
    the scopes a key may hold (a list or a function returning one); ``now`` the clock;
    ``random(size)`` returns ``size`` random bytes as base64url (tests pass a deterministic one).
    """

    def __init__(
        self,
        store: NoSQL,
        secret: str,
        *,
        keys: Any = None,
        scopes: Sequence[str] | Callable[[], Sequence[str]] = (),
        now: Clock | None = None,
        random: Callable[[int], str] | None = None,
    ) -> None:
        self.store = store
        self._secret = secret
        self._keys = keys
        self._scopes = scopes
        self._clock = now
        self._random = random or _base64url
        self._configured: list[dict[str, Any]] | None = None

    def scopes(self) -> list[str]:
        """Scopes a key may hold."""
        return list(self._scopes() if callable(self._scopes) else self._scopes)

    def validate(self) -> list[str]:
        """Validate the configured keys now (call it at startup); returns their ids."""
        if self._configured is None:
            self._configured = parse_service_keys(self._keys, self.scopes())
        return [k["id"] for k in self._configured]

    @property
    def _env(self) -> list[dict[str, Any]]:
        self.validate()
        assert self._configured is not None
        return self._configured

    def _now(self) -> Any:
        return epoch_ms(self._clock)

    def _record(self, key_id: str) -> Mapping[str, Any] | None:
        configured = next((k for k in self._env if k["id"] == key_id), None)
        if configured is not None:
            return configured
        row = self.store.get(SERVICE_KEYS, key_id)
        return row["data"] if row else None

    @staticmethod
    def _view(key: Mapping[str, Any], last_used_at: Any) -> dict[str, Any]:
        return {
            "id": key["id"],
            "description": key.get("description"),
            "scopes": key.get("scopes"),
            "rateLimit": key.get("rateLimit"),
            "source": key.get("source"),
            "prefix": SERVICE_KEY_PREFIX + key["id"] + ".",
            "active": key.get("revokedAt") is None,
            "createdAt": key.get("createdAt"),
            "createdBy": key.get("createdBy"),
            "rotatedAt": key.get("rotatedAt"),
            "revokedAt": key.get("revokedAt"),
            "revokedBy": key.get("revokedBy"),
            "lastUsedAt": last_used_at,
        }

    def _all(self, pk: str) -> list[Row]:
        rows: list[Row] = []
        cursor = None
        while True:
            page = self.store.list(pk, cursor)
            rows.extend(page["items"])
            cursor = page.get("cursor")
            if not cursor:
                return rows

    def _last_used(self, key_id: str) -> Any:
        row = self.store.get(SERVICE_KEY_USE, key_id)
        return row["data"].get("lastUsedAt") if row else None

    def list(self) -> dict[str, Any]:
        """Every key (configured first, then admin-managed by id) and the scopes; never secrets."""
        used = {r["sk"]: r["data"].get("lastUsedAt") for r in self._all(SERVICE_KEY_USE)}
        managed = [r["data"] for r in self._all(SERVICE_KEYS)]
        return {"items": [self._view(k, used.get(k["id"])) for k in [*self._env, *managed]], "scopes": self.scopes()}

    @staticmethod
    def _audit(key_id: str, version: int, data: Mapping[str, Any]) -> Write:
        return {
            "row": {"pk": service_key_audit(key_id), "sk": _pad(data["at"], 15) + "-" + _pad(version, 10), "version": 1, "data": {"keyId": key_id, **data}},
            "expected": None,
        }

    def create(self, input: Any, actor_id: str) -> dict[str, Any]:
        """Create an admin-managed key ``{id?, description, scopes, rateLimit?}``; returns ``{key,
        token}`` (the token is shown only here)."""
        source = input if isinstance(input, Mapping) else {}
        given = source.get("id")
        if given is not None and (not isinstance(given, str) or not _KEY_ID.fullmatch(given)):
            raise HttpError(400, "Invalid service key id")
        raw = source.get("description")
        description = js_trim(raw) if isinstance(raw, str) else ""
        if not description or _js.utf16_length(description) > 200:
            raise HttpError(400, "A short description is required")
        scopes = _scope_list(source.get("scopes"), self.scopes())
        if scopes is None:
            raise HttpError(400, "Invalid service key scopes")
        limit = _rate_limit_of(source.get("rateLimit"))
        if limit is None:
            raise HttpError(400, "Invalid service key rate limit")
        key_id = given if given is not None else self._random(9)
        if any(k["id"] == key_id for k in self._env) or self.store.get(SERVICE_KEYS, key_id):
            raise HttpError(409, "Service key id already used")
        token = SERVICE_KEY_PREFIX + key_id + "." + self._random(32)
        at = self._now()
        key = {
            "id": key_id,
            "description": description,
            "scopes": scopes,
            "rateLimit": limit,
            "secretHash": service_key_hash(token),
            "source": "admin",
            "createdAt": at,
            "createdBy": actor_id,
            "rotatedAt": None,
            "revokedAt": None,
            "revokedBy": None,
        }
        try:
            self.store.transact(
                [
                    {"row": {"pk": SERVICE_KEYS, "sk": key_id, "version": 1, "data": key}, "expected": None},
                    self._audit(key_id, 1, {"action": "create", "actorId": actor_id, "at": at, "scopes": scopes, "rateLimit": limit}),
                ]
            )
        except Conflict:
            raise HttpError(409, "Service key id already used") from None
        return {"key": self._view(key, None), "token": token}

    def _managed(self, key_id: Any, action: str) -> Row:
        if not isinstance(key_id, str) or not _KEY_ID.fullmatch(key_id):
            raise HttpError(404, "Service key not found")
        if any(k["id"] == key_id for k in self._env):
            raise HttpError(
                409,
                "Keys from the configuration are rotated in the configuration"
                if action == "rotate"
                else "Keys from the configuration are revoked by removing them from the configuration",
            )
        row = self.store.get(SERVICE_KEYS, key_id)
        if row is None:
            raise HttpError(404, "Service key not found")
        return row

    def rotate(self, key_id: Any, actor_id: str) -> dict[str, Any]:
        """New secret for an admin-managed key; the old token stops working at once."""
        row = self._managed(key_id, "rotate")
        key = row["data"]
        if _revoked(key):
            raise HttpError(409, "Service key is revoked")
        token = SERVICE_KEY_PREFIX + key_id + "." + self._random(32)
        at = self._now()
        nxt = {**key, "secretHash": service_key_hash(token), "rotatedAt": at}
        self.store.transact(
            [
                {"row": {**row, "version": row["version"] + 1, "data": nxt}, "expected": row["version"]},
                self._audit(key_id, row["version"] + 1, {"action": "rotate", "actorId": actor_id, "at": at}),
            ]
        )
        return {"key": self._view(nxt, self._last_used(key_id)), "token": token}

    def revoke(self, key_id: Any, actor_id: str) -> dict[str, Any]:
        """Revoke an admin-managed key (rejected from the next request on). Idempotent."""
        row = self._managed(key_id, "revoke")
        key = row["data"]
        if _revoked(key):
            return {"key": self._view(key, self._last_used(key_id))}
        at = self._now()
        nxt = {**key, "revokedAt": at, "revokedBy": actor_id}
        self.store.transact(
            [
                {"row": {**row, "version": row["version"] + 1, "data": nxt}, "expected": row["version"]},
                self._audit(key_id, row["version"] + 1, {"action": "revoke", "actorId": actor_id, "at": at}),
            ]
        )
        return {"key": self._view(nxt, self._last_used(key_id))}

    def actor(self, authorization: Any) -> dict[str, Any]:
        """The service actor of an Authorization header (see the contract for the check order)."""
        if authorization is None or authorization == "":
            raise HttpError(401, SERVICE_KEY_REQUIRED)
        match = _TOKEN.fullmatch(authorization[7:]) if isinstance(authorization, str) and authorization.startswith("Bearer ") else None
        if match is None:
            raise HttpError(401, INVALID_SERVICE_KEY)
        key_id = match.group(1)
        found = self._record(key_id)
        stored = found.get("secretHash") if found is not None else None
        expected = stored if isinstance(stored, str) and _HASH.fullmatch(stored) else _NO_HASH
        valid = hmac.compare_digest(bytes.fromhex(service_key_hash(match.group(0))), bytes.fromhex(expected))
        if found is None or not valid or _revoked(found):
            raise HttpError(401, INVALID_SERVICE_KEY)
        now = self._now()
        rate_limit(self.store, self._secret, now, "service-key:" + key_id, found["rateLimit"])
        use = self.store.get(SERVICE_KEY_USE, key_id)
        last = use["data"].get("lastUsedAt") if use else None
        if use is None or not (_js.is_number(last) and now - last < SERVICE_KEY_TOUCH_MS):
            try:
                self.store.transact(
                    [
                        {
                            "row": {"pk": SERVICE_KEY_USE, "sk": key_id, "version": (use["version"] if use else 0) + 1, "data": {"lastUsedAt": now}},
                            "expected": use["version"] if use else None,
                        }
                    ]
                )
            except Conflict:
                pass
        return {
            "id": "service:" + key_id,
            "role": "service",
            "grants": list(found["scopes"]),
            "email": "",
            "name": found.get("description") or key_id,
            "tokenVersion": 0,
            "active": True,
        }

    def actor_from_request(self, request: Any) -> dict[str, Any]:
        """``actor`` of a ``rt_app.web.Request`` (its authorization header)."""
        return self.actor(request.headers.get("authorization"))

    def check(self, endpoint: Any, actor: Any = None) -> None:
        """Only service endpoints; a service actor holding the endpoint's resource as a scope."""
        access = endpoint.get("access") if isinstance(endpoint, Mapping) else getattr(endpoint, "access", None)
        resource = endpoint.get("resource") if isinstance(endpoint, Mapping) else getattr(endpoint, "resource", None)
        if access != "service":
            raise HttpError(403, "You do not have permission to access this resource")
        if not isinstance(actor, Mapping) or actor.get("role") != "service":
            raise HttpError(401, SERVICE_KEY_REQUIRED)
        if resource not in (actor.get("grants") or []):
            raise HttpError(403, SERVICE_KEY_SCOPE)

    def feature(self) -> Any:
        """Admin endpoints (owner, served only under /admin/app) and GET /service/keys/self."""
        from .web.app import Endpoint, Feature

        def body(c: Any) -> Mapping[str, Any]:
            return c.request.body if isinstance(c.request.body, Mapping) else {}

        def create(c: Any) -> Any:
            b = body(c)
            return self.create({"id": b.get("id"), "description": b.get("description"), "scopes": b.get("scopes"), "rateLimit": b.get("rateLimit")}, c.actor["id"])

        def self_view(c: Any) -> Any:
            key_id = c.actor["id"][len("service:"):]
            found = self._record(key_id)
            return {
                "id": key_id,
                "description": found.get("description") if found else "",
                "scopes": c.actor.get("grants"),
                "rateLimit": found.get("rateLimit") if found else None,
            }

        manage = "service-keys.manage"
        return Feature(
            id="service-keys",
            admin={
                "id": "service-keys",
                "title": "Service keys",
                "resource": manage,
                "path": "/service-keys",
                "component": "service-keys",
                "ownerOnly": True,
                "fields": [],
                "actions": [],
            },
            endpoints=[
                Endpoint(
                    "GET",
                    "/service-keys",
                    manage,
                    "owner",
                    lambda c: self.list(),
                    tool={
                        "name": "service_keys_list",
                        "description": "List service keys (configured and admin-managed): id, description, scopes, rate limit, last use, revoked. Never returns secrets.",
                        "example": {},
                    },
                ),
                Endpoint("POST", "/service-keys", manage, "owner", create),
                Endpoint("POST", "/service-keys/:id/rotate", manage, "owner", lambda c: self.rotate(c.params["id"], c.actor["id"])),
                Endpoint(
                    "POST",
                    "/service-keys/:id/revoke",
                    manage,
                    "owner",
                    lambda c: self.revoke(c.params["id"], c.actor["id"]),
                    tool={
                        "name": "service_keys_revoke",
                        "description": "Revoke an admin-managed service key; it is rejected from the next request on. params.id is the key id.",
                        "example": {"params": {"id": "KEY_ID"}},
                    },
                ),
                Endpoint("GET", "/service/keys/self", SERVICE_SELF, "service", self_view),
            ],
        )


__all__ = [
    "SERVICE_KEY_PREFIX",
    "SERVICE_KEYS",
    "SERVICE_KEY_USE",
    "SERVICE_SELF",
    "DEFAULT_SERVICE_RATE_LIMIT",
    "MAX_SERVICE_RATE_LIMIT",
    "INVALID_SERVICE_KEY",
    "SERVICE_KEY_REQUIRED",
    "SERVICE_KEY_SCOPE",
    "ServiceKeys",
    "parse_service_keys",
    "service_keys_from_env",
    "service_key_audit",
    "service_key_hash",
]
