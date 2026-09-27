"""Subject: userBans (rt_app.users_bans.UserBans; mirrors hosts/node/users-bans.mjs).

Users + JwtTokens + a capturing mailbox + Auth + UserBans(sessions=auth.refresh_sessions) over one
MemoryStore and one settable clock. init: {secret, now, rows}.
"""
from __future__ import annotations

from typing import Any

from identity import _Clock, _init
from storage import memory_store, rows_of

from rt_app.auth import Auth, LocalMailbox
from rt_app.jwt import JwtTokens
from rt_app.users import Users, active_ban, parse_instant
from rt_app.users_bans import UserBans
from rt_app.web import Context, Request

_DEFAULT_NOW = "2026-01-02T03:04:05.000Z"


class UserBansFacade:
    def __init__(self, init: Any) -> None:
        init = _init(init)
        self._clock = _Clock(init.get("now") or _DEFAULT_NOW)
        self._store = memory_store(rows_of(init))
        secret = init.get("secret")
        self._users = Users(self._store, now=self._clock.now)
        self._mailbox = LocalMailbox()
        self._auth = Auth(self._users, JwtTokens(secret, now=self._clock.now), self._mailbox, secret, now=self._clock.now)
        self._bans = UserBans(self._users, now=self._clock.now, sessions=self._auth.refresh_sessions)
        endpoints = {(e.method, e.path): e for e in self._users.feature().endpoints}
        self._view, self._list = endpoints[("GET", "/users/:id")], endpoints[("GET", "/users")]

    def ban(self, user_id: Any, input: Any, actor: Any) -> Any:
        return self._bans.ban(user_id, input, actor)

    def unban(self, user_id: Any, input: Any, actor: Any) -> Any:
        return self._bans.unban(user_id, input, actor)

    def history(self, user_id: Any) -> Any:
        return self._bans.history(user_id)

    # GET /users/:id and GET /users (the admin views with the ban status).
    def view(self, user_id: Any) -> Any:
        return self._view.handle(Context(request=Request(method="GET", path="/users/x"), params={"id": user_id}, actor=None))

    def list(self, query: Any = None) -> Any:
        return self._list.handle(Context(request=Request(method="GET", path="/users", query=query or {}), params={}, actor=None))

    def active_ban(self, data: Any) -> Any:
        return active_ban(data, self._clock.now())

    def parse_instant(self, value: Any) -> Any:
        return parse_instant(value)

    # The sign-in paths the ban gate covers.
    def login(self, email: Any, password: Any, ip: Any) -> Any:
        return self._auth.login(email, password, ip)

    def issue(self, email: Any, purpose: Any, ip: Any) -> Any:
        return self._auth.issue(email, purpose, ip)

    def consume(self, email: Any, code: Any, purpose: Any, ip: Any, password: Any = None) -> Any:
        return self._auth.consume(email, code, purpose, ip, password)

    def verify_mfa(self, challenge_id: Any, code: Any, ip: Any) -> Any:
        return self._auth.verify_mfa(challenge_id, code, ip)

    def refresh(self, refresh_token: Any, ip: Any) -> Any:
        return self._auth.refresh(refresh_token, ip)

    def actor(self, header: Any = None) -> Any:
        return self._auth.actor(header)

    def sessions(self, user_id: Any) -> Any:
        return self._auth.sessions(user_id)

    # Helpers.
    def mailbox(self) -> list[dict[str, str]]:
        return [{"email": m["email"], "code": m["code"], "purpose": m["purpose"]} for m in self._mailbox.messages]

    def row(self, pk: Any, sk: Any) -> Any:
        return self._store.get(pk, sk)

    def endpoints(self) -> list[dict[str, Any]]:
        return [
            {"method": e.method, "path": e.path, "access": e.access, "resource": e.resource, "tool": (e.tool or {}).get("name")}
            for e in self._bans.feature().endpoints
        ]

    def set_now(self, iso: Any) -> None:
        return self._clock.set(iso)


SUBJECTS = {"userBans": UserBansFacade}
