"""Subjects: jwt, users, acl, auth (identity modules).

Each subject is a small facade so every language exposes the same surface (see identity.mjs);
helpers are documented in the contracts and docs/polyglot.md. Contract method names are camelCase
and map to these snake_case names.
"""
from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone
from typing import Any

from rt_app.acl import ACL
from rt_app.auth import Auth, AuthVault, LocalMailbox, totp_code
from rt_app.jwt import JwtTokens
from rt_app import users as users_module
from rt_app.users import Users, hash_password, validate_password, verify_password
from rt_app.web import Context, Request
from storage import memory_store, rows_of


_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


def _parse_iso(value: Any) -> int:
    """``Date.parse`` for the ISO 8601 instants contracts use → epoch milliseconds."""
    if isinstance(value, str):
        value = datetime.fromisoformat(value[:-1] + "+00:00" if value.endswith(("Z", "z")) else value)
    if not isinstance(value, datetime):  # the wire decoder turns {"$date"} into datetimes
        raise ValueError("not a date")
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return (value - _EPOCH) // timedelta(milliseconds=1)


class _Clock:
    """A settable clock starting at init.now (ISO 8601); the system clock when absent."""

    def __init__(self, now: Any) -> None:
        self.fixed: int | None = None
        if now is not None:
            try:
                self.fixed = _parse_iso(now)
            except (ValueError, TypeError):
                raise ValueError("init.now must be an ISO 8601 date") from None

    def now(self) -> float:
        if self.fixed is None:
            return time.time_ns() // 1_000_000
        return self.fixed

    def set(self, iso: Any) -> None:
        try:
            self.fixed = _parse_iso(iso)
        except (ValueError, TypeError):
            raise ValueError("setNow needs an ISO 8601 date") from None
        return None


def _init(init: Any) -> dict[str, Any]:
    return init if isinstance(init, dict) else {}


class JwtFacade:
    def __init__(self, init: Any) -> None:
        init = _init(init)
        self._clock = _Clock(init.get("now"))
        options = {k: init[k] for k in ("issuer", "audience") if init.get(k) is not None}
        self._tokens = JwtTokens(init.get("secret"), **options, now=self._clock.now)

    def issue(self, user: Any) -> str:
        return self._tokens.issue(user)

    def verify(self, token: Any) -> Any:
        return self._tokens.verify(token)

    def set_now(self, iso: Any) -> None:
        return self._clock.set(iso)


class UsersFacade:
    def __init__(self, init: Any) -> None:
        init = _init(init)
        self._clock = _Clock(init.get("now"))
        self._store = memory_store(rows_of(init))
        self._users = Users(self._store, now=self._clock.now)
        endpoints = {(e.method, e.path): e for e in self._users.feature().endpoints}
        self._view, self._list = endpoints[("GET", "/users/:id")], endpoints[("GET", "/users")]

    def get(self, id: Any) -> Any:
        return self._users.get(id)

    # Test users (docs/polyglot/users-test-flag.md): admin edit, admin views, filter, helpers.
    def update(self, id: Any, input: Any, actor: Any = None) -> Any:
        return self._users.update(id, input or {}, actor)

    def view(self, id: Any) -> Any:
        return self._view.handle(Context(request=Request(method="GET", path="/users/x"), params={"id": id}, actor=None))

    def list(self, query: Any = None) -> Any:
        return self._list.handle(Context(request=Request(method="GET", path="/users", query=query or {}), params={}, actor=None))

    def is_test_user(self, data: Any) -> bool:
        return users_module.is_test_user(data)

    def test_user_ids(self) -> list[str]:
        return sorted(users_module.test_user_ids(self._store))

    def by_email(self, email: Any) -> Any:
        return self._users.by_email(email)

    def create(self, input: Any, role: Any = None, actor: Any = None) -> Any:
        return self._users.create(input, role, actor)

    def bootstrap_owner(self, input: Any) -> Any:
        return self._users.bootstrap_owner(input)

    def profile(self, id: Any, input: Any, actor: Any = None) -> Any:
        return self._users.profile(id, input, actor)

    def validate_password(self, password: Any) -> None:
        validate_password(password)

    def hash_password(self, password: Any) -> str:
        return hash_password(password)

    def verify_password(self, password: Any, stored: Any) -> bool:
        return verify_password(password, stored)

    def row(self, pk: Any, sk: Any) -> Any:
        return self._store.get(pk, sk)


class AclFacade:
    def __init__(self, init: Any) -> None:
        init = _init(init)
        self._clock = _Clock(init.get("now"))
        self._store = memory_store(rows_of(init))
        self._acl = ACL(self._store, lambda: init.get("resources") or [], now=self._clock.now)
        self._list, self._assign = self._acl.feature().endpoints

    def allows(self, actor: Any, resource: Any) -> bool:
        return self._acl.allows(actor, resource)

    def check(self, endpoint: Any, actor: Any = None) -> None:
        self._acl.check(endpoint, actor)

    def resources(self, query: Any = None) -> Any:
        request = Request(method="GET", path="/acl/resources", query=query or {})
        return self._list.handle(Context(request=request, params={}, actor=None))

    def assign(self, id: Any, body: Any, actor: Any) -> Any:
        request = Request(method="PUT", path=f"/acl/users/{id}", body=body or {})
        return self._assign.handle(Context(request=request, params={"id": id}, actor=actor))

    def row(self, pk: Any, sk: Any) -> Any:
        return self._store.get(pk, sk)


class AuthFacade:
    def __init__(self, init: Any) -> None:
        init = _init(init)
        self._clock = _Clock(init.get("now"))
        self._store = memory_store(rows_of(init))
        secret = init.get("secret")
        users = Users(self._store, now=self._clock.now)
        self._mailbox = LocalMailbox()
        tokens = JwtTokens(secret, now=self._clock.now)
        self._auth = Auth(users, tokens, self._mailbox, secret, now=self._clock.now, session_ttl_ms=init.get("sessionTtlMs"))
        self._vault = AuthVault(secret)

    def login(self, email: Any, password: Any, ip: Any, user_agent: Any = None) -> Any:
        return self._auth.login(email, password, ip, user_agent)

    def issue(self, email: Any, purpose: Any, ip: Any) -> Any:
        return self._auth.issue(email, purpose, ip)

    def consume(
        self, email: Any, code: Any, purpose: Any, ip: Any, password: Any = None, challenge_id: Any = None, user_agent: Any = None
    ) -> Any:
        return self._auth.consume(email, code, purpose, ip, password, challenge_id, user_agent)

    def actor(self, header: Any = None) -> Any:
        return self._auth.actor(header)

    def limit(self, key: Any, max: Any) -> None:
        self._auth.limit(key, max)

    def settings(self) -> Any:
        return self._auth.settings()

    def update_settings(self, input: Any) -> Any:
        return self._auth.update_settings(input)

    def has_mfa(self, id: Any) -> bool:
        return self._auth.has_mfa(id)

    def setup_mfa(self, id: Any, password: Any, ip: Any) -> Any:
        return self._auth.setup_mfa(id, password, ip)

    def enable_mfa(self, id: Any, challenge_id: Any, code: Any, ip: Any) -> Any:
        return self._auth.enable_mfa(id, challenge_id, code, ip)

    def verify_mfa(self, challenge_id: Any, code: Any, ip: Any, user_agent: Any = None) -> Any:
        return self._auth.verify_mfa(challenge_id, code, ip, user_agent)

    def reset_mfa(self, id: Any) -> Any:
        return self._auth.reset_mfa(id)

    def request_email_change(self, id: Any, email: Any, ip: Any) -> Any:
        return self._auth.request_email_change(id, email, ip)

    def confirm_email_change(self, id: Any, code: Any, ip: Any, user_agent: Any = None) -> Any:
        return self._auth.confirm_email_change(id, code, ip, user_agent)

    # Refresh sessions (POST /auth/refresh, GET/DELETE /auth/sessions, POST /auth/logout).
    def refresh(self, refresh_token: Any, ip: Any) -> Any:
        return self._auth.refresh(refresh_token, ip)

    def sessions(self, user_id: Any, current_session_id: Any = None) -> Any:
        return self._auth.sessions(user_id, current_session_id)

    def revoke_session(self, user_id: Any, session_id: Any) -> Any:
        return self._auth.revoke_session(user_id, session_id)

    def logout(self, user_id: Any, session_id: Any = None, all: Any = None) -> Any:
        return self._auth.logout(user_id, session_id, all)

    # Helpers (not Auth methods): captured mail, stored rows, clock, TOTP and vault.
    def mailbox(self) -> list[dict[str, str]]:
        return [{"email": m["email"], "code": m["code"], "purpose": m["purpose"]} for m in self._mailbox.messages]

    def row(self, pk: Any, sk: Any) -> Any:
        return self._store.get(pk, sk)

    def set_now(self, iso: Any) -> None:
        return self._clock.set(iso)

    def totp_code(self, secret: Any, step: Any) -> str:
        return totp_code(secret, step)

    def unseal(self, sealed: Any) -> Any:
        return self._vault.open(sealed)


SUBJECTS = {
    "jwt": JwtFacade,
    "users": UsersFacade,
    "acl": AclFacade,
    "auth": AuthFacade,
}
