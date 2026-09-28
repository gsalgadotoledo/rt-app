"""Local user accounts and scrypt passwords (port of ``@gsalgadotoledo/rt-app-users``).

Rows: ``USERS/<id>`` (the account), ``EMAIL/<email>`` ``{id}`` (unique index written in the same
transaction) and ``INSTALLATION/owner`` ``{id}`` (bootstrap only). Password hashes are
``scrypt$<32 hex salt>$<128 hex>``; the scrypt salt is the hex *text* as UTF-8 with N=32768, r=8,
p=3 and dkLen=64, so hashes interoperate with the TypeScript and Go implementations.
"""
from __future__ import annotations

import calendar
import hashlib
import hmac
import re
import secrets
import uuid
from datetime import datetime, timezone
from collections.abc import Mapping
from typing import Any, Literal, Protocol

from . import _js
from .contracts import (
    Clock,
    audit_create,
    audit_delete,
    audit_restore,
    audit_update,
    email_address,
    epoch_ms,
    search_page,
    text,
    to_datetime,
    view_user,
)
from .errors import HttpError
from .nosql import NoSQL, Row, Write
from .web.app import Context, Endpoint, Feature

Role = Literal["owner", "admin", "user"]
PASSWORD_MESSAGE = "The password must contain 12 to 128 characters"
_SCRYPT = {"n": 32768, "r": 8, "p": 3, "dklen": 64, "maxmem": 64 * 1024 * 1024}
_HEX = "0123456789abcdefABCDEF"

ADMIN = {
    "id": "users",
    "title": "Users",
    "resource": "users.list",
    "path": "/users",
    "component": "users",
    "fields": ["id", "email", "name", "role", "active", "banned", "testUser"],
    "actions": ["list", "create", "edit", "delete", "permissions"],
    "group": "authentication",
}


def _utf8(value: str) -> bytes:
    """UTF-8 like Node: lone surrogates become U+FFFD."""
    return value.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "replace").encode("utf-8")


def _scrypt(password: str, salt: str) -> bytes:
    return hashlib.scrypt(_utf8(password), salt=_utf8(salt), **_SCRYPT)


def node_hex(value: str) -> bytes:
    """``Buffer.from(value, "hex")``: decodes pairs until the first invalid one."""
    out = bytearray()
    for i in range(0, len(value) - 1, 2):
        pair = value[i : i + 2]
        if pair[0] not in _HEX or pair[1] not in _HEX:
            break
        out.append(int(pair, 16))
    return bytes(out)


def validate_password(password: object) -> str:
    """A string of 12 to 128 UTF-16 units (no trimming, no normalization), else 400."""
    if not isinstance(password, str) or not 12 <= _js.utf16_length(password) <= 128:
        raise HttpError(400, PASSWORD_MESSAGE)
    return password


def hash_password(password: object) -> str:
    """``scrypt$<salt>$<hash>`` with a fresh 16-byte salt written as lowercase hex."""
    validate_password(password)
    salt = secrets.token_hex(16)
    return f"scrypt${salt}${_scrypt(password, salt).hex()}"  # type: ignore[arg-type]


def verify_password(password: object, stored: str) -> bool:
    """Constant-time check; non-strings and passwords over 128 units are false without hashing."""
    if not isinstance(password, str) or _js.utf16_length(password) > 128:
        return False
    parts = stored.split("$")
    if len(parts) < 3:
        raise TypeError("Malformed password hash")
    expected = node_hex(parts[2])
    actual = _scrypt(password, parts[1])
    return len(expected) == len(actual) and hmac.compare_digest(actual, expected)


# Account suspension (bans) as stored on the USERS row -----------------------------------------------
# The users module owns the row format and this reader, so every sign-in path enforces a ban even
# when the users_bans module that writes them is not enabled. See docs/polyglot/users-bans.md.

#: The single public message of every refused sign-in, refresh or request of a banned account.
ACCOUNT_SUSPENDED = "Account suspended"

#: Latest instant accepted: 9999-12-31T23:59:59.999Z.
MAX_INSTANT_MS = 253402300799999

_INSTANT = re.compile(
    r"(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))",
    re.ASCII,
)
_UNIX = datetime(1970, 1, 1, tzinfo=timezone.utc)


def parse_instant(value: object) -> int | None:
    """Strict ISO 8601 instant → epoch ms, or None (the grammar of the TypeScript ``parseInstant``).

    ``YYYY-MM-DDTHH:MM:SS``, optional ``.f`` to ``.fff``, then ``Z`` or ``±HH:MM``; ASCII digits, a
    real calendar date, year 1970 or later, at most ``MAX_INSTANT_MS`` once the offset is applied.
    ``parse_instant("2026-01-02T03:04:05+01:00")`` → ``1767319445000``.
    """
    if not isinstance(value, str):
        return None
    match = _INSTANT.fullmatch(value)
    if not match:
        return None
    year, month, day, hour, minute, second = (int(match.group(i)) for i in range(1, 7))
    fraction = int((match.group(7) or "").ljust(3, "0"))
    offset_hours, offset_minutes = int(match.group(10) or 0), int(match.group(11) or 0)
    if (
        year < 1970 or not 1 <= month <= 12 or not 1 <= day <= calendar.monthrange(year, month)[1]
        or hour > 23 or minute > 59 or second > 59 or offset_hours > 23 or offset_minutes > 59
    ):
        return None
    sign = -1 if match.group(9) == "-" else 1
    moment = datetime(year, month, day, hour, minute, second, tzinfo=timezone.utc)
    ms = (moment - _UNIX).days * 86400000 + (moment - _UNIX).seconds * 1000 + fraction
    ms -= sign * (offset_hours * 60 + offset_minutes) * 60000
    return ms if 0 <= ms <= MAX_INSTANT_MS else None


def active_ban(data: Mapping[str, Any] | None, now_ms: float) -> dict[str, Any] | None:
    """The ban in force on a user row at ``now_ms``, or None.

    ``until`` None is permanent; a temporary ban lifts by itself when ``until <= now`` (nothing is
    written). An ``until`` that cannot be read keeps the ban in force (fail closed).
    """
    ban = data.get("ban") if isinstance(data, Mapping) else None
    if not isinstance(ban, Mapping):
        return None
    if ban.get("until") is not None:
        until = parse_instant(ban.get("until"))
        if until is not None and until <= now_ms:
            return None
    return {key: ban.get(key) for key in ("reason", "category", "until", "at", "by")}


def view_account(data: Mapping[str, Any], now_ms: float) -> dict[str, Any]:
    """The admin view of an account (GET /users, GET /users/:id, PATCH /users/:id): view_user +
    banned + the ban in force + testUser."""
    ban = active_ban(data, now_ms)
    return {**view_user(data), "banned": ban is not None, "ban": ban, "testUser": is_test_user(data)}


# Test users as stored on the USERS row ------------------------------------------------------------
# ``data.testUser``: only the boolean True marks a test user. A label for reports and filters; it
# never changes sign-in, bans, permissions or credits. See docs/polyglot/users-test-flag.md.

TEST_USER_FIELD_MESSAGE = "Invalid field: testUser"


def is_test_user(data: Mapping[str, Any] | None) -> bool:
    """Whether a user row (its data) is marked as a test user (``testUser is True``)."""
    return isinstance(data, Mapping) and data.get("testUser") is True


def test_user_input(value: object) -> bool | None:
    """None means "not given"; a bool is returned; anything else is 400 "Invalid field: testUser"."""
    if value is None:
        return None
    if not isinstance(value, bool):
        raise HttpError(400, TEST_USER_FIELD_MESSAGE)
    return value


def test_user_filter(value: object) -> None:
    """``?testUser=`` must be absent, "", "true" or "false"; else 400 "Invalid testUser filter"."""
    if value is not None and value not in ("", "true", "false"):
        raise HttpError(400, "Invalid testUser filter")


def test_user_ids(store: NoSQL) -> set[str]:
    """Ids of every USERS row marked as a test user (deleted ones included), for reports that must
    exclude them (revenue, usage, economics). Reads the partition page by page."""
    ids: set[str] = set()
    cursor = None
    while True:
        page = store.list("USERS", cursor)
        for row in page["items"]:
            if is_test_user(row["data"]) and isinstance(row["data"].get("id"), str):
                ids.add(row["data"]["id"])
        cursor = page.get("cursor")
        if not cursor:
            return ids


class CredentialProvider(Protocol):
    """A remote identity provider that owns passwords (e.g. Cognito)."""

    id: str

    def provision(self, id: str, email: str, password: str) -> None: ...

    def disable(self, id: str) -> None: ...


class Users:
    """User accounts in a NoSQL store. ``now`` is the injectable clock for audit timestamps."""

    def __init__(self, store: NoSQL, credentials: CredentialProvider | None = None, *, now: Clock | None = None) -> None:
        self.store = store
        self.credentials = credentials
        self._now = now

    def _at(self):  # noqa: ANN202 - datetime
        return to_datetime(epoch_ms(self._now))

    def get(self, id: str) -> Row | None:
        return self.store.get("USERS", id)

    def view(self, data: Mapping[str, Any]) -> dict[str, Any]:
        """The admin view of a row at the current time: view_user plus banned and the ban in force."""
        return view_account(data, epoch_ms(self._now))

    def by_email(self, email: str) -> Row | None:
        """Exact index lookup; callers normalize the address."""
        index = self.store.get("EMAIL", email)
        return self.get(index["data"]["id"]) if index else None

    def bootstrap_owner(self, input: Mapping[str, Any]) -> Row:
        """Create the first account as owner; 409 once any user row exists (even a deleted one)."""
        if self.store.list("USERS")["items"]:
            raise HttpError(409, "The application already has users")
        # The first owner is never a test user: the flag is set by administrators only.
        owner = {k: v for k, v in input.items() if k != "testUser"} if isinstance(input, Mapping) else input
        return self._insert(owner, "owner", bootstrap=True)

    def create(self, input: Mapping[str, Any], role: Role | None = None, actor: str | None = None) -> Row:
        """Create an account from ``{email, name, password, testUser?}``; testUser is stored only
        when True. Callers are administrators (POST /users, seeds)."""
        return self._insert(input, role or "user", bootstrap=False, actor=actor)

    def _insert(self, input: Mapping[str, Any], role: str, *, bootstrap: bool, actor: str | None = None) -> Row:
        input = input if isinstance(input, Mapping) else {}
        email = email_address(input.get("email"))
        name = text(input.get("name"), "name")
        password = validate_password(input.get("password"))
        test_user = test_user_input(input.get("testUser"))
        credentials = self.credentials
        # Reserve the local identity before calling a remote provider. A partial account is
        # inactive and can be retried by the administrator using the same email.
        if credentials:
            existing = self.by_email(email)
            data = existing["data"] if existing else {}
            if existing and data.get("provisioning") and not data.get("deletedAt") and data.get("credentialProvider") == credentials.id:
                credentials.provision(data["id"], email, password)
                ready: Row = {**existing, "version": existing["version"] + 1, "data": {**data, "active": True, "provisioning": False}}
                self.store.transact([{"row": ready, "expected": existing["version"]}])
                return ready
        password_hash = None if credentials else hash_password(password)
        id = str(uuid.uuid4())
        data = {
            "id": id,
            "email": email,
            "name": name,
            **({"passwordHash": password_hash} if password_hash else {}),
            **({"credentialProvider": credentials.id, "provisioning": True} if credentials else {}),
            "role": role,
            "grants": [],
            **({"testUser": True} if test_user else {}),
            "active": not credentials,
            "tokenVersion": 1,
            **audit_create(actor if actor is not None else id, self._at()),
        }
        row: Row = {"pk": "USERS", "sk": id, "version": 1, "data": data}
        writes: list[Write] = []
        if bootstrap:
            writes.append({"row": {"pk": "INSTALLATION", "sk": "owner", "version": 1, "data": {"id": id}}, "expected": None})
        writes.append({"row": row, "expected": None})
        writes.append({"row": {"pk": "EMAIL", "sk": email, "version": 1, "data": {"id": id}}, "expected": None})
        self.store.transact(writes)
        if credentials:
            credentials.provision(id, email, password)
            ready = {**row, "version": 2, "data": {**data, "active": True, "provisioning": False}}
            self.store.transact([{"row": ready, "expected": 1}])
            return ready
        return row

    def profile(self, id: str, input: Mapping[str, Any], actor: str | None = None) -> dict[str, Any]:
        """Edit the name only (email changes need the verified flow); returns the public view."""
        row = self.get(id)
        if not row or row["data"].get("deletedAt"):
            raise HttpError(404, "User not found")
        input = input if isinstance(input, Mapping) else {}
        if any(key != "name" for key in input):
            raise HttpError(400, "Only name can be edited; email requires verification")
        data = {**row["data"], "name": text(input.get("name"), "name"), **audit_update(actor if actor is not None else id, self._at())}
        self.store.transact([{"row": {**row, "version": row["version"] + 1, "data": data}, "expected": row["version"]}])
        return view_user(data)

    def update(self, id: str, input: Mapping[str, Any], actor: str) -> dict[str, Any]:
        """Administrator edit (PATCH /users/:id) of ``{name?, testUser?}``; returns the admin view.

        404 first; other keys 400; name validated when not None or when testUser is None; then
        testUser. tokenVersion and the ban are kept.
        """
        row = self.get(id)
        if not row or row["data"].get("deletedAt"):
            raise HttpError(404, "User not found")
        body = input if isinstance(input, Mapping) else {}
        if any(key not in ("name", "testUser") for key in body):
            raise HttpError(400, "Only name and testUser can be edited; email requires verification")
        patch: dict[str, Any] = {}
        if body.get("name") is not None or body.get("testUser") is None:
            patch["name"] = text(body.get("name"), "name")
        test_user = test_user_input(body.get("testUser"))
        if test_user is not None:
            patch["testUser"] = test_user
        data = {**row["data"], **patch, **audit_update(actor, self._at())}
        self.store.transact([{"row": {**row, "version": row["version"] + 1, "data": data}, "expected": row["version"]}])
        return self.view(data)

    # HTTP -------------------------------------------------------------------------------------

    def _existing(self, id: str) -> Row:
        row = self.get(id)
        if not row or row["data"].get("deletedAt"):
            raise HttpError(404, "User not found")
        return row

    def _read(self, c: Context) -> dict[str, Any]:
        return self.view(self._existing(c.params["id"])["data"])

    def _edit(self, c: Context) -> dict[str, Any]:
        row = self.get(c.params["id"])
        if row and row["data"].get("role") == "owner" and c.actor["role"] != "owner":  # type: ignore[index]
            raise HttpError(403, "Owner role required")
        return self.update(c.params["id"], c.request.body, c.actor["id"])  # type: ignore[index]

    def _restore(self, c: Context) -> dict[str, Any]:
        row = self.get(c.params["id"])
        if not row or not row["data"].get("deletedAt"):
            raise HttpError(404, "Deleted user not found")
        enable = getattr(self.credentials, "enable", None)
        if self.credentials and not callable(enable):
            raise HttpError(409, "This identity provider does not support restoration")
        # Enable the provider first; the local tombstone keeps rejecting sign-in until committed.
        if callable(enable):
            enable(row["data"]["id"])
        data = {
            **row["data"],
            **audit_restore(c.actor["id"], self._at()),  # type: ignore[index]
            "active": not row["data"].get("provisioning"),
            "tokenVersion": row["data"]["tokenVersion"] + 1,
        }
        self.store.transact([{"row": {**row, "version": row["version"] + 1, "data": data}, "expected": row["version"]}])
        return view_user(data)

    def _delete(self, c: Context) -> dict[str, Any]:
        row = self._existing(c.params["id"])
        actor_id = c.actor["id"]  # type: ignore[index]
        if row["data"].get("role") == "owner" or row["data"]["id"] == actor_id:
            raise HttpError(403, "You cannot deactivate this account")
        data = {**row["data"], **audit_delete(actor_id, self._at()), "active": False, "tokenVersion": row["data"]["tokenVersion"] + 1}
        self.store.transact([{"row": {**row, "version": row["version"] + 1, "data": data}, "expected": row["version"]}])
        if self.credentials:
            self.credentials.disable(row["data"]["id"])
        return {"ok": True}

    def feature(self) -> Feature:
        """``/users/me`` for every signed-in user; list/create/read/edit/restore/delete by permission."""
        fields = ["id", "email", "name", "role", "active", "banned", "testUser"]

        def search(c: Context) -> Any:
            test_user_filter(c.request.query.get("testUser"))
            return search_page(self.store, "USERS", c.request.query, fields, lambda row: self.view(row["data"]))

        return Feature(
            id="users",
            admin=ADMIN,
            endpoints=[
                Endpoint("GET", "/users/me", "users.me.read", "authenticated", lambda c: view_user(c.actor)),  # type: ignore[arg-type]
                Endpoint("PATCH", "/users/me", "users.me.edit", "authenticated", lambda c: self.profile(c.actor["id"], c.request.body)),  # type: ignore[index]
                Endpoint("GET", "/users", "users.list", "permission", search),
                Endpoint(
                    "POST", "/users", "users.create", "permission",
                    lambda c: self.view(self.create(c.request.body, "user", c.actor["id"])["data"]),  # type: ignore[index]
                ),
                Endpoint("GET", "/users/:id", "users.read", "permission", self._read),
                Endpoint("PATCH", "/users/:id", "users.edit", "permission", self._edit),
                Endpoint("POST", "/users/:id/restore", "users.restore", "permission", self._restore),
                Endpoint("DELETE", "/users/:id", "users.delete", "permission", self._delete),
            ],
        )


__all__ = [
    "ACCOUNT_SUSPENDED",
    "MAX_INSTANT_MS",
    "active_ban",
    "parse_instant",
    "view_account",
    "is_test_user",
    "test_user_input",
    "test_user_filter",
    "test_user_ids",
    "Users",
    "CredentialProvider",
    "Role",
    "PASSWORD_MESSAGE",
    "validate_password",
    "hash_password",
    "verify_password",
]
