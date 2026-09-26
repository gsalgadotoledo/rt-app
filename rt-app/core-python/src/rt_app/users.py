"""Local user accounts and scrypt passwords (port of ``@gsalgadotoledo/rt-app-users``).

Rows: ``USERS/<id>`` (the account), ``EMAIL/<email>`` ``{id}`` (unique index written in the same
transaction) and ``INSTALLATION/owner`` ``{id}`` (bootstrap only). Password hashes are
``scrypt$<32 hex salt>$<128 hex>``; the scrypt salt is the hex *text* as UTF-8 with N=32768, r=8,
p=3 and dkLen=64, so hashes interoperate with the TypeScript and Go implementations.
"""
from __future__ import annotations

import hashlib
import hmac
import secrets
import uuid
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
    "fields": ["id", "email", "name", "role", "active"],
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

    def by_email(self, email: str) -> Row | None:
        """Exact index lookup; callers normalize the address."""
        index = self.store.get("EMAIL", email)
        return self.get(index["data"]["id"]) if index else None

    def bootstrap_owner(self, input: Mapping[str, Any]) -> Row:
        """Create the first account as owner; 409 once any user row exists (even a deleted one)."""
        if self.store.list("USERS")["items"]:
            raise HttpError(409, "The application already has users")
        return self._insert(input, "owner", bootstrap=True)

    def create(self, input: Mapping[str, Any], role: Role | None = None, actor: str | None = None) -> Row:
        return self._insert(input, role or "user", bootstrap=False, actor=actor)

    def _insert(self, input: Mapping[str, Any], role: str, *, bootstrap: bool, actor: str | None = None) -> Row:
        input = input if isinstance(input, Mapping) else {}
        email = email_address(input.get("email"))
        name = text(input.get("name"), "name")
        password = validate_password(input.get("password"))
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

    # HTTP -------------------------------------------------------------------------------------

    def _existing(self, id: str) -> Row:
        row = self.get(id)
        if not row or row["data"].get("deletedAt"):
            raise HttpError(404, "User not found")
        return row

    def _read(self, c: Context) -> dict[str, Any]:
        return view_user(self._existing(c.params["id"])["data"])

    def _edit(self, c: Context) -> dict[str, Any]:
        row = self.get(c.params["id"])
        if row and row["data"].get("role") == "owner" and c.actor["role"] != "owner":  # type: ignore[index]
            raise HttpError(403, "Owner role required")
        return self.profile(c.params["id"], c.request.body, c.actor["id"])  # type: ignore[index]

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
        fields = ["id", "email", "name", "role", "active"]
        return Feature(
            id="users",
            admin=ADMIN,
            endpoints=[
                Endpoint("GET", "/users/me", "users.me.read", "authenticated", lambda c: view_user(c.actor)),  # type: ignore[arg-type]
                Endpoint("PATCH", "/users/me", "users.me.edit", "authenticated", lambda c: self.profile(c.actor["id"], c.request.body)),  # type: ignore[index]
                Endpoint(
                    "GET", "/users", "users.list", "permission",
                    lambda c: search_page(self.store, "USERS", c.request.query, fields, lambda row: view_user(row["data"])),
                ),
                Endpoint(
                    "POST", "/users", "users.create", "permission",
                    lambda c: view_user(self.create(c.request.body, "user", c.actor["id"])["data"]),  # type: ignore[index]
                ),
                Endpoint("GET", "/users/:id", "users.read", "permission", self._read),
                Endpoint("PATCH", "/users/:id", "users.edit", "permission", self._edit),
                Endpoint("POST", "/users/:id/restore", "users.restore", "permission", self._restore),
                Endpoint("DELETE", "/users/:id", "users.delete", "permission", self._delete),
            ],
        )


__all__ = [
    "Users",
    "CredentialProvider",
    "Role",
    "PASSWORD_MESSAGE",
    "validate_password",
    "hash_password",
    "verify_password",
]
