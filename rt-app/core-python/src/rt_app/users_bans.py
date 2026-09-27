"""Account bans: an extension of the users module (port of ``@gsalgadotoledo/rt-app-users-bans``).

The ban itself lives on the user row (``USERS/<id>.data.ban``, read by ``users.active_ban`` and
enforced by ``auth.Auth`` on every sign-in, refresh and request); this module writes it, keeps the
append-only history and serves the admin endpoints:

- ``USERS/<id>``: ``data.ban = {reason, category, until, at, by}`` (or None after an unban);
- ``USER_BANS#<userId>/pad15(atMs)-pad10(user row version)``:
  ``{userId, action: ban|update|unban, reason, category, until, actorId, at}``.

Row formats and algorithms: docs/polyglot/users-bans.md and spec/contracts/users-bans.contract.yaml.
"""
from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from typing import Any, Protocol

from . import _js
from .contracts import Clock, audit_update, epoch_ms, js_trim, to_datetime
from .errors import Conflict, HttpError
from .nosql import Row
from .users import Users, active_ban, parse_instant, view_account
from .web.app import Context, Endpoint, Feature

#: The admin root principal (ADMIN_PASSWORD). Only it can ban or unban an owner.
ROOT_ACTOR = "rt-app-root"

#: Revocation reason written on the refresh sessions a ban ends.
BAN_SESSION_REASON = "ban"

_CATEGORY = re.compile(r"[a-z][a-z0-9_-]{0,39}", re.ASCII)
_ATTEMPTS = 4


def ban_partition(user_id: str) -> str:
    """Partition of a user's ban history: ``USER_BANS#<userId>``."""
    return "USER_BANS#" + user_id


class SessionRevoker(Protocol):
    """Ends the refresh sessions of a user (``auth_sessions.RefreshSessions.revoke_all``)."""

    def revoke_all(self, user_id: str, reason: str) -> int: ...


def ban_reason(value: object) -> str:
    """A required reason: after JavaScript ``trim()`` 3 to 500 UTF-16 units, else 400."""
    reason = js_trim(value) if isinstance(value, str) else ""
    if not 3 <= _js.utf16_length(reason) <= 500:
        raise HttpError(400, "A reason of 3 to 500 characters is required")
    return reason


def ban_until(value: object, now_ms: float) -> str | None:
    """None → permanent; else a strict ISO 8601 instant after now, normalized (milliseconds, Z)."""
    if value is None:
        return None
    ms = parse_instant(value)
    if ms is None:
        raise HttpError(400, "Invalid until: use an ISO 8601 date and time")
    if ms <= now_ms:
        raise HttpError(400, "until must be in the future")
    return _js.iso_timestamp(to_datetime(ms))


def ban_category(value: object) -> str | None:
    """None → None; else ``^[a-z][a-z0-9_-]{0,39}$`` or 400."""
    if value is None:
        return None
    if not isinstance(value, str) or not _CATEGORY.fullmatch(value):
        raise HttpError(400, "Invalid category")
    return value


def _history_key(at_ms: int, version: int) -> str:
    return str(at_ms).rjust(15, "0") + "-" + str(version).rjust(10, "0")


class UserBans:
    """Ban, unban and the ban history over ``Users``. Share ``now`` with ``Auth``."""

    def __init__(self, users: Users, *, now: Clock | None = None, sessions: SessionRevoker | None = None) -> None:
        self.users = users
        self._now = now
        self._sessions = sessions

    def _time(self) -> int:
        return int(epoch_ms(self._now))

    def _target(self, user_id: object) -> Row:
        row = self.users.get(user_id) if isinstance(user_id, str) and _js.utf16_length(user_id) <= 100 else None
        if not row or row["data"].get("deletedAt"):
            raise HttpError(404, "User not found")
        return row

    @staticmethod
    def _authorize(row: Row, actor: Mapping[str, Any], verb: str) -> None:
        """Never yourself; an owner only by the admin root; an administrator only by an owner."""
        if row["data"].get("id") == actor.get("id"):
            raise HttpError(403, f"You cannot {verb} your own account")
        if row["data"].get("role") == "owner" and actor.get("id") != ROOT_ACTOR:
            raise HttpError(403, f"Only the admin root can {verb} an owner")
        if row["data"].get("role") == "admin" and actor.get("role") != "owner":
            raise HttpError(403, f"Only an owner can {verb} an administrator")

    def _write(
        self,
        user_id: object,
        actor: Mapping[str, Any],
        verb: str,
        change: Callable[[Row, int], tuple[dict[str, Any], dict[str, Any]]],
    ) -> tuple[Row, int]:
        """The next user row and its audit row in one transaction; retried on conflicts (4 attempts)."""
        for _ in range(_ATTEMPTS):
            row = self._target(user_id)
            self._authorize(row, actor, verb)
            now = self._time()
            at = to_datetime(now)
            data, audit = change(row, now)
            next_row: Row = {**row, "version": row["version"] + 1, "data": {**data, **audit_update(actor["id"], at)}}  # type: ignore[typeddict-item]
            history: Row = {
                "pk": ban_partition(row["data"]["id"]),
                "sk": _history_key(now, next_row["version"]),
                "version": 1,
                "data": {"userId": row["data"]["id"], **audit, "actorId": actor["id"], "at": _js.iso_timestamp(at)},
            }
            try:
                self.users.store.transact([{"row": next_row, "expected": row["version"]}, {"row": history, "expected": None}])
                return next_row, now
            except Conflict:
                continue
        raise Conflict()

    def ban(self, user_id: object, input: Mapping[str, Any] | None, actor: Mapping[str, Any]) -> dict[str, Any]:
        """Ban (suspend) an account at once → the admin view of the account.

        Validates reason, until and category (400), then the user (404) and the rules (403). One
        transaction writes ``data.ban``, ``tokenVersion + 1`` and the audit row (action "ban", or
        "update" when a ban was in force); then the live refresh sessions are revoked ("ban").
        """
        body = input if isinstance(input, Mapping) else {}
        reason = ban_reason(body.get("reason"))
        until = ban_until(body.get("until"), self._time())
        category = ban_category(body.get("category"))

        def change(row: Row, now: int) -> tuple[dict[str, Any], dict[str, Any]]:
            ban = {"reason": reason, "category": category, "until": until, "at": _js.iso_timestamp(to_datetime(now)), "by": actor["id"]}
            action = "update" if active_ban(row["data"], now) else "ban"
            data = {**row["data"], "ban": ban, "tokenVersion": row["data"]["tokenVersion"] + 1}
            return data, {"action": action, "reason": reason, "category": category, "until": until}

        row, now = self._write(user_id, actor, "ban", change)
        # The tokenVersion bump already cut every session; this records why on each session row.
        if self._sessions is not None:
            self._sessions.revoke_all(row["data"]["id"], BAN_SESSION_REASON)
        return view_account(row["data"], now)

    def unban(self, user_id: object, input: Mapping[str, Any] | None, actor: Mapping[str, Any]) -> dict[str, Any]:
        """Lift the ban in force (409 "User is not banned" otherwise) → the admin view.

        ``data.ban = None`` and an "unban" audit row; tokenVersion is not changed, so sessions
        ended by the ban stay ended.
        """
        body = input if isinstance(input, Mapping) else {}
        reason = ban_reason(body.get("reason"))

        def change(row: Row, now: int) -> tuple[dict[str, Any], dict[str, Any]]:
            if not active_ban(row["data"], now):
                raise HttpError(409, "User is not banned")
            return {**row["data"], "ban": None}, {"action": "unban", "reason": reason, "category": None, "until": None}

        row, now = self._write(user_id, actor, "unban", change)
        return view_account(row["data"], now)

    def history(self, user_id: object) -> dict[str, Any]:
        """The append-only history of a user, newest first; 404 when the user row does not exist."""
        row = self.users.get(user_id) if isinstance(user_id, str) and _js.utf16_length(user_id) <= 100 else None
        if not row:
            raise HttpError(404, "User not found")
        rows: list[Row] = []
        cursor: str | None = None
        while True:
            page = self.users.store.list(ban_partition(row["data"]["id"]), cursor)
            rows.extend(page["items"])
            cursor = page.get("cursor")
            if not cursor:
                break
        rows.sort(key=lambda r: r["sk"], reverse=True)
        keys = ("userId", "action", "reason", "category", "until", "actorId", "at")
        return {"items": [{"id": r["sk"], **{key: r["data"].get(key) for key in keys}} for r in rows]}

    # HTTP -------------------------------------------------------------------------------------

    def feature(self) -> Feature:
        """Ban and unban (``users.ban``), history (``users.bans.read``); published as admin tools."""

        def ban(c: Context) -> Any:
            return self.ban(c.params["id"], c.request.body, c.actor)  # type: ignore[arg-type]

        def unban(c: Context) -> Any:
            return self.unban(c.params["id"], c.request.body, c.actor)  # type: ignore[arg-type]

        return Feature(
            id="users-bans",
            endpoints=[
                Endpoint("POST", "/users/:id/ban", "users.ban", "permission", ban, tool=TOOLS["users_ban"]),
                Endpoint("POST", "/users/:id/unban", "users.ban", "permission", unban, tool=TOOLS["users_unban"]),
                Endpoint("GET", "/users/:id/bans", "users.bans.read", "permission", lambda c: self.history(c.params["id"]), tool=TOOLS["users_bans"]),
            ],
        )


#: CLI/MCP metadata of the endpoints (same text as the TypeScript reference).
TOOLS: dict[str, dict[str, Any]] = {
    "users_ban": {
        "name": "users_ban",
        "description": (
            "Suspend an application account at once: its sessions and access tokens stop working and sign-in, codes and "
            "refresh answer 403 Account suspended. params.id and body.reason (3-500 characters, kept in the admin history, "
            "never shown to the user) are required; body.until (ISO 8601, in the future) makes the ban temporary and it "
            "lifts by itself at that instant; body.category is an optional label (^[a-z][a-z0-9_-]{0,39}$). Banning a "
            "banned account replaces reason, until and category (history action update). Owners can be banned only by the "
            "admin root, administrators only by owners; nobody bans themselves."
        ),
        "example": {"params": {"id": "user-123"}, "body": {"reason": "Chargeback fraud reported by the bank", "until": "2026-12-31T00:00:00Z", "category": "fraud"}},
    },
    "users_unban": {
        "name": "users_unban",
        "description": (
            "Lift the ban in force on an application account (409 when it is not banned, also after a temporary ban "
            "expired). params.id and body.reason (3-500 characters) are required. Sessions ended by the ban stay ended: "
            "the user signs in again."
        ),
        "example": {"params": {"id": "user-123"}, "body": {"reason": "Bank confirmed the payment"}},
    },
    "users_bans": {
        "name": "users_bans",
        "description": (
            "Ban history of an application account, newest first: {items: [{id, userId, action (ban | update | unban), "
            "reason, category, until, actorId, at}]}. Append-only. params.id is required."
        ),
        "example": {"params": {"id": "user-123"}},
    },
}


__all__ = [
    "BAN_SESSION_REASON",
    "ROOT_ACTOR",
    "SessionRevoker",
    "TOOLS",
    "UserBans",
    "ban_category",
    "ban_partition",
    "ban_reason",
    "ban_until",
]
