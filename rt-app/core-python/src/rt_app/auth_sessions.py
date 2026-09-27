"""Refresh sessions: opaque rotating refresh tokens behind 15-minute access tokens.

Port of ``packages/auth/src/sessions.ts`` and ``limits.ts`` (TypeScript is the reference; design
notes in ``docs/polyglot/auth-sessions.md``). The rows are shared with the other implementations,
so a session written by one refreshes in any other:

- ``SESSION/<sessionId>`` ``{userId}``: the pointer from a refresh token to its user (never changes);
- ``SESSIONS#<userId>/<sessionId>`` ``{userId, provider, tokenVersion, secretHash, previousHash,
  rotatedAt, createdAt, lastUsedAt, expiresAt, revokedAt, revokedReason, ip, userAgent}``.

Both are written in one transaction with ``ttl = floor(expiresAt / 1000)``; times are epoch
milliseconds. A refresh token is ``<sessionId>.<secret>`` (16 and 32 random bytes, base64url without
padding); only ``hex(HMAC-SHA256(app secret, "refresh:<sessionId>:<secret>"))`` of the current and
the previous secret is stored.
"""
from __future__ import annotations

import hashlib
import hmac
import math
import os
import re
from collections.abc import Callable, Mapping
from typing import Any, TypedDict

from . import _js
from .contracts import Clock, epoch_ms
from .errors import Conflict, HttpError
from .nosql import NoSQL, Row

#: Default absolute session lifetime: 4 days from sign-in.
SESSION_TTL_MS = 4 * 24 * 60 * 60 * 1000
#: How long the immediately previous refresh token stays usable after a rotation.
REFRESH_GRACE_MS = 30_000
#: Every refresh failure answers with this single 401 message (no detail leaks).
INVALID_REFRESH = "Invalid session"
#: Pointer partition resolving a session id to its user: SESSION/<sessionId> → {userId}.
SESSION_INDEX = "SESSION"

# JavaScript /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/ (fullmatch: "$" must not accept a final "\n").
_REFRESH_TOKEN = re.compile(r"([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})")
_NOT_PRINTABLE = re.compile(r"[^\x20-\x7e]")


def _utf8(value: str) -> bytes:
    return value.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "replace").encode("utf-8")


def _js_str(value: object) -> str:
    """Template-literal interpolation of the few values keys can hold."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and value.is_integer() and abs(value) < 1e21:
        return str(int(value))
    return str(value)


def session_partition(user_id: str) -> str:
    """Partition holding one user's sessions: ``SESSIONS#<userId>``."""
    return "SESSIONS#" + user_id


def client_text(value: object, max: int) -> str | None:
    """Keep printable ASCII only (U+0020–U+007E), cut to ``max`` characters; empty → None."""
    if not isinstance(value, str):
        return None
    return _NOT_PRINTABLE.sub("", value)[:max] or None


def parse_refresh_token(token: object) -> tuple[str, str] | None:
    """``(sessionId, secret)`` of a well-formed refresh token, else None."""
    if not isinstance(token, str):
        return None
    match = _REFRESH_TOKEN.fullmatch(token)
    return (match.group(1), match.group(2)) if match else None


def session_live(row: Row | None, now: float) -> bool:
    """Live until revoked or at its absolute expiry (``expiresAt <= now`` is dead)."""
    if not row:
        return False
    expires = row["data"].get("expiresAt")
    return row["data"].get("revokedAt") is None and _js.is_number(expires) and now < expires  # type: ignore[operator]


def rate_limit(store: NoSQL, secret: str, now: float, key: str, max: int) -> None:
    """Fixed one-minute window counter (``limits.ts``).

    Row ``RATE/hex(HMAC(secret, "<key>:<floor(now/60000)>"))`` ``{count}`` with ttl now+120 s; 429
    "Too many attempts; wait one minute" when count >= max (a refused attempt is not counted);
    version-guarded with 8 retries, then 429 "Too many simultaneous attempts".
    """
    sk = hmac.new(_utf8(secret), _utf8(f"{_js_str(key)}:{math.floor(now / 60000)}"), hashlib.sha256).hexdigest()
    for _ in range(8):
        row = store.get("RATE", sk)
        count = (row["data"].get("count") if row else None) or 0
        if count >= max:
            raise HttpError(429, "Too many attempts; wait one minute")
        try:
            store.transact([{
                "row": {"pk": "RATE", "sk": sk, "version": (row["version"] if row else 0) + 1, "data": {"count": count + 1}, "ttl": math.floor(now / 1000) + 120},
                "expected": row["version"] if row else None,
            }])
            return
        except Conflict:
            continue
    raise HttpError(429, "Too many simultaneous attempts")


class SessionSubject(TypedDict):
    """Who a session belongs to and what must still hold for it to be valid."""

    id: str
    tokenVersion: int
    #: Credential provider at sign-in ("local", "cognito", "admin:<fingerprint>"...).
    provider: str


class IssuedRefresh(TypedDict):
    """A newly issued or rotated refresh token (``expiresAt`` in epoch ms)."""

    sessionId: str
    refreshToken: str
    expiresAt: int
    row: Row


def _random_text(size: int) -> str:
    return _js.base64url_encode(os.urandom(size))


def _within(now: int, since: object, window: int) -> bool:
    """``now - since <= window`` (a missing or non-numeric ``since`` is NaN in JavaScript: false)."""
    return _js.is_number(since) and now - since <= window  # type: ignore[operator]


def _now_ms(clock: Clock | None) -> int:
    return math.floor(epoch_ms(clock))


class RefreshSessions:
    """Store-backed refresh sessions. Only HMACs of secrets are stored; the previous hash is kept
    for the concurrent-tab grace window and to detect reuse (theft), which revokes the session."""

    def __init__(
        self,
        store: NoSQL,
        secret: str,
        *,
        now: Clock | None = None,
        ttl_ms: int | None = None,
        grace_ms: int | None = None,
    ) -> None:
        self.store = store
        self._secret = _utf8(secret)
        self._now = now
        self.ttl_ms = SESSION_TTL_MS if ttl_ms is None else ttl_ms
        self.grace_ms = REFRESH_GRACE_MS if grace_ms is None else grace_ms

    def _time(self) -> int:
        return _now_ms(self._now)

    def hash(self, session_id: str, secret: str) -> str:
        """``hex(HMAC-SHA256(app secret, "refresh:<sessionId>:<secret>"))``."""
        return hmac.new(self._secret, _utf8(f"refresh:{session_id}:{secret}"), hashlib.sha256).hexdigest()

    @staticmethod
    def _matches(stored: object, presented: str) -> bool:
        return isinstance(stored, str) and len(stored) == len(presented) and hmac.compare_digest(_utf8(stored), _utf8(presented))

    def create(self, subject: Mapping[str, Any], client: Mapping[str, Any] | None = None) -> IssuedRefresh:
        """Start a session for a subject that just signed in (both rows in one transaction).

        ``create({"id": "u-1", "tokenVersion": 1, "provider": "local"}, {"ip": "1.1.1.1"})``
        → ``{sessionId, refreshToken: "<sessionId>.<secret>", expiresAt: now + 4 days, row}``.
        """
        client = client or {}
        now = self._time()
        session_id, secret = _random_text(16), _random_text(32)
        expires_at = now + self.ttl_ms
        ttl = math.floor(expires_at / 1000)
        row: Row = {
            "pk": session_partition(subject["id"]),
            "sk": session_id,
            "version": 1,
            "ttl": ttl,
            "data": {
                "userId": subject["id"],
                "provider": subject["provider"],
                "tokenVersion": subject["tokenVersion"],
                "secretHash": self.hash(session_id, secret),
                "previousHash": None,
                "rotatedAt": now,
                "createdAt": now,
                "lastUsedAt": now,
                "expiresAt": expires_at,
                "revokedAt": None,
                "revokedReason": None,
                "ip": client_text(client.get("ip"), 64),
                "userAgent": client_text(client.get("userAgent"), 200),
            },
        }
        self.store.transact([
            {"row": {"pk": SESSION_INDEX, "sk": session_id, "version": 1, "ttl": ttl, "data": {"userId": subject["id"]}}, "expected": None},
            {"row": row, "expected": None},
        ])
        return {"sessionId": session_id, "refreshToken": f"{session_id}.{secret}", "expiresAt": expires_at, "row": row}

    def find(self, session_id: str) -> Row | None:
        """The session row of an id through its pointer, or None (two reads)."""
        pointer = self.store.get(SESSION_INDEX, session_id)
        user_id = pointer["data"].get("userId") if pointer else None
        if not isinstance(user_id, str):
            return None
        return self.store.get(session_partition(user_id), session_id)

    def get(self, user_id: str, session_id: str) -> Row | None:
        """The row of one user's session (one read), or None."""
        return self.store.get(session_partition(user_id), session_id)

    def rotate(
        self,
        token: object,
        valid: Callable[[Row], bool],
        blocked: Callable[[Row, bool], None] | None = None,
    ) -> IssuedRefresh:
        """Rotate a refresh token; ``valid(row)`` re-checks the subject in the database.

        Returns the new token for the same session and expiry. Raises 401 "Invalid session" for
        anything invalid; reusing a superseded token (other than the previous one inside the grace
        window) revokes the whole session first. Concurrent rotations are version-guarded: a loser
        re-reads (4 attempts) and normally lands in the grace path; then 409.
        ``blocked(row, holder)`` runs first on any existing row (live or not) and may raise another
        error; ``holder`` tells whether the token's secret is the current or the previous one.
        """
        parsed = parse_refresh_token(token)
        if parsed is None:
            raise HttpError(401, INVALID_REFRESH)
        session_id, secret = parsed
        for _ in range(4):
            row, now = self.find(session_id), self._time()
            presented = self.hash(session_id, secret)
            # Before liveness: a banned account answers 403 to the holder of the session's secret.
            if row is not None and blocked is not None:
                data = row["data"]
                blocked(row, self._matches(data.get("secretHash"), presented) or self._matches(data.get("previousHash"), presented))
            if row is None or not session_live(row, now) or not valid(row):
                raise HttpError(401, INVALID_REFRESH)
            data = row["data"]
            changes: dict[str, Any]
            if self._matches(data.get("secretHash"), presented):
                # Normal rotation: the presented secret becomes the previous one.
                changes = {"previousHash": data.get("secretHash"), "rotatedAt": now}
            elif self._matches(data.get("previousHash"), presented) and _within(now, data.get("rotatedAt"), self.grace_ms):
                # A sibling tab raced us with the same token: issue another secret, keep the grace window.
                changes = {}
            else:
                # A superseded or forged secret for a live session: assume theft and revoke it.
                try:
                    self._write(row, {"revokedAt": now, "revokedReason": "reuse"})
                except Conflict:
                    continue
                raise HttpError(401, INVALID_REFRESH)
            fresh = _random_text(32)
            try:
                updated = self._write(row, {**changes, "secretHash": self.hash(session_id, fresh), "lastUsedAt": now})
            except Conflict:
                continue
            return {"sessionId": session_id, "refreshToken": f"{session_id}.{fresh}", "expiresAt": data["expiresAt"], "row": updated}
        raise Conflict()

    def _write(self, row: Row, changes: Mapping[str, Any]) -> Row:
        """Version-guarded update of a session row; raises Conflict when it changed meanwhile."""
        updated: Row = {**row, "version": row["version"] + 1, "data": {**row["data"], **changes}}  # type: ignore[typeddict-item]
        self.store.transact([{"row": updated, "expected": row["version"]}])
        return updated

    def revoke(self, user_id: str, session_id: object, reason: str) -> bool:
        """Revoke one live session of a user; False when it does not exist, belongs to another
        user, or is already revoked or expired."""
        if not isinstance(session_id, str) or not session_id or _js.utf16_length(session_id) > 100:
            return False
        for _ in range(4):
            row = self.get(user_id, session_id)
            if row is None or not session_live(row, self._time()):
                return False
            try:
                self._write(row, {"revokedAt": self._time(), "revokedReason": reason})
                return True
            except Conflict:
                continue
        raise Conflict()

    def revoke_all(self, user_id: str, reason: str) -> int:
        """Revoke every live session of a user with ``reason`` (for example "ban") → how many.

        Each session is a separate version-guarded write (not atomic); callers bump the user's
        tokenVersion first, which already makes every session unusable.
        """
        now = self._time()
        return sum(1 for row in self.rows(user_id) if session_live(row, now) and self.revoke(user_id, row["sk"], reason))

    def rows(self, user_id: str) -> list[Row]:
        """Every stored session row of a user, across all pages (live or not)."""
        rows: list[Row] = []
        cursor: str | None = None
        while True:
            page = self.store.list(session_partition(user_id), cursor)
            rows.extend(page["items"])
            cursor = page.get("cursor")
            if not cursor:
                return rows


__all__ = [
    "INVALID_REFRESH",
    "IssuedRefresh",
    "REFRESH_GRACE_MS",
    "RefreshSessions",
    "SESSION_INDEX",
    "SESSION_TTL_MS",
    "SessionSubject",
    "client_text",
    "parse_refresh_token",
    "rate_limit",
    "session_live",
    "session_partition",
]
