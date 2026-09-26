"""Authentication: password and email-code sign-in, sessions, rate limits, TOTP MFA and email change.

Port of ``@gsalgadotoledo/rt-app-auth`` (TypeScript is the reference). Every row format is shared
with the other implementations:

- ``RATE/<digest("<key>:<floor(ms/60000)>")>`` ``{count}``, ttl +120 s;
- ``CHALLENGE/<digest("<purpose>:<email>")>`` and ``CHALLENGE/<digest("email-change:<id>")>``;
- ``AUTH_FLOW/<uuid>`` pending challenges with a sealed value; ``MFA/<id>`` with the sealed seed;
- ``SETTINGS/auth`` ``{passwordLogin, emailCodeLogin}``.

``digest(text)`` is ``hex(HMAC-SHA256(secret, text))``. Sealed values use AES-256-GCM with the key
``SHA-256("rt-app-auth-vault:" + secret)`` and the layout ``base64url(iv12 || tag16 || ciphertext)``
(requires the ``crypto`` extra: ``pip install rt-app-core[crypto]``).
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import math
import os
import re
import secrets
import urllib.parse
import uuid
from collections.abc import Callable, Mapping
from typing import Any, Literal, Protocol, TypedDict

from . import _js
from .contracts import Clock, email_address, epoch_ms, public_user, to_datetime, view_user
from .errors import Conflict, HttpError
from .jwt import JwtTokens
from .nosql import NoSQL, Row, Write
from .users import CredentialProvider, Users, hash_password, node_hex, validate_password, verify_password
from .web.app import Context, Endpoint, Feature, Request

Purpose = Literal["login", "reset"]
CODE_REPLY = "If the account supports this method, you will receive a code."
DUMMY_HASH = "scrypt$" + "0" * 32 + "$" + "00" * 64
_CODE = re.compile(r"[0-9]{6}")  # JavaScript /^\d{6}$/: ASCII digits only
_BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"


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


def _is_code(code: object) -> bool:
    return isinstance(code, str) and _CODE.fullmatch(code) is not None


def _same_hex(stored: object, computed: str) -> bool:
    """``timingSafeEqual`` of two hex digests; unequal lengths throw like Node."""
    a, b = node_hex(stored if isinstance(stored, str) else ""), bytes.fromhex(computed)
    if len(a) != len(b):
        raise ValueError("Input buffers must have the same byte length")
    return hmac.compare_digest(a, b)


# --- TOTP (RFC 6238, SHA-1, 6 digits, 30 s) --------------------------------------------------------


def totp_secret() -> str:
    """20 random bytes as RFC 4648 base32 without padding (32 characters)."""
    return base64.b32encode(os.urandom(20)).decode("ascii")


def totp_code(secret: str, step: int | None = None) -> str:
    """The six-digit code of ``secret`` for a 30-second ``step`` (the current one by default)."""
    if step is None:
        step = math.floor(epoch_ms() / 30000)
    bits = ""
    for char in secret:
        index = _BASE32.find(char)
        if index < 0:
            raise ValueError("Invalid base32 TOTP secret")
        bits += format(index, "05b")
    key = bytes(int(bits[i : i + 8], 2) for i in range(0, len(bits) - len(bits) % 8, 8))
    digest = hmac.new(key, int(step).to_bytes(8, "big"), hashlib.sha1).digest()
    offset = digest[19] & 15
    value = int.from_bytes(digest[offset : offset + 4], "big") & 0x7FFFFFFF
    return f"{value % 1000000:06d}"


def totp_step(secret: str, code: object, last: int = -1, now_ms: float | None = None) -> int | None:
    """The first step of [now, now-1, now+1] newer than ``last`` whose code matches, else None."""
    if not _is_code(code):
        return None
    now = math.floor((epoch_ms() if now_ms is None else now_ms) / 30000)
    for step in (now, now - 1, now + 1):
        if step > last and hmac.compare_digest(totp_code(secret, step).encode(), code.encode()):  # type: ignore[union-attr]
            return step
    return None


# --- vault -----------------------------------------------------------------------------------------


class AuthVault:
    """Encrypt provider sessions and TOTP seeds; plaintext never enters a stored row."""

    def __init__(self, secret: str) -> None:
        self._key = hashlib.sha256(_utf8("rt-app-auth-vault:" + secret)).digest()

    @staticmethod
    def _aesgcm(key: bytes) -> Any:
        try:
            from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        except ImportError as error:  # pragma: no cover - depends on the environment
            raise RuntimeError("AuthVault needs the 'cryptography' package: pip install 'rt-app-core[crypto]'") from error
        return AESGCM(key)

    def seal(self, value: Any, iv: bytes | None = None) -> str:
        """``base64url(iv || tag || ciphertext)`` of compact JSON; ``iv`` is random unless given (tests)."""
        iv = os.urandom(12) if iv is None else iv
        sealed = self._aesgcm(self._key).encrypt(iv, _utf8(_js.stringify(value)), None)
        return _js.base64url_encode(iv + sealed[-16:] + sealed[:-16])

    def open(self, value: str) -> Any:
        """Decrypt and parse a sealed value (raises on tampering or a wrong secret)."""
        data = _js.base64url_decode(value)
        plain = self._aesgcm(self._key).decrypt(data[:12], data[28:] + data[12:28], None)
        return _js.parse(plain.decode("utf-8", "replace"))


# --- mail ------------------------------------------------------------------------------------------


class MailMessage(TypedDict):
    to: str
    subject: str
    text: str


class Mailer(Protocol):
    def send_code(self, email: str, code: str, purpose: str) -> None: ...


class LocalMailbox:
    """Development mailer: keeps the last 30 messages in memory, newest first."""

    def __init__(self, *, now: Clock | None = None) -> None:
        self.messages: list[dict[str, str]] = []
        self._now = now

    def _keep(self, email: str, code: str, purpose: str) -> None:
        at = _js.iso_timestamp(to_datetime(epoch_ms(self._now)))
        self.messages.insert(0, {"email": email, "code": code, "purpose": purpose, "at": at})
        del self.messages[30:]

    def send(self, message: MailMessage) -> None:
        self._keep(message["to"], message["text"], message["subject"])

    def send_code(self, email: str, code: str, purpose: str) -> None:
        self._keep(email, code, purpose)


class SesMailer:
    """Amazon SES v2 mailer (requires ``boto3``: ``pip install 'rt-app-core[dynamodb]'``)."""

    def __init__(self, sender: str, client: Any = None) -> None:
        if not sender:
            raise ValueError("MAIL_FROM is required")
        self.sender = sender
        self._client = client

    @property
    def client(self) -> Any:
        if self._client is None:
            import boto3  # lazy: optional dependency

            self._client = boto3.client("sesv2")
        return self._client

    def send(self, message: MailMessage) -> None:
        self.client.send_email(
            FromEmailAddress=self.sender,
            Destination={"ToAddresses": [message["to"]]},
            Content={"Simple": {"Subject": {"Data": message["subject"]}, "Body": {"Text": {"Data": message["text"]}}}},
        )

    def send_code(self, email: str, code: str, purpose: str) -> None:
        self.send({
            "to": email,
            "subject": f"RT-App: {purpose}",
            "text": f"Your code is {code}. It expires in 10 minutes. If you did not request it, ignore this email.",
        })


# --- identity provider -------------------------------------------------------------------------------


class IdentityProvider(CredentialProvider, Protocol):
    """A remote identity provider (e.g. Cognito). Provider credentials never become app permissions.

    ``password`` returns ``{"accessToken"}`` or ``{"challenge": "totp", "session"}``.
    """

    def password(self, id: str, password: str) -> dict[str, Any]: ...
    def email_code(self, id: str) -> str: ...
    def verify_email_code(self, id: str, session: str, code: str) -> dict[str, Any]: ...
    def forgot(self, id: str) -> None: ...
    def reset(self, id: str, code: str, password: str) -> None: ...
    def verify_totp(self, id: str, session: str, code: str) -> dict[str, Any]: ...
    def mfa_status(self, id: str) -> bool: ...
    def begin_totp(self, access_token: str) -> str: ...
    def enable_totp(self, id: str, access_token: str, code: str) -> None: ...
    def logout(self, id: str) -> None: ...
    def disable_mfa(self, id: str) -> None: ...
    def change_email(self, id: str, email: str) -> None: ...


# --- auth --------------------------------------------------------------------------------------------


def _bump(row: Row, **changes: Any) -> Row:
    """The next version of a row with changed data fields."""
    return {**row, "version": row["version"] + 1, "data": {**row["data"], **changes}}  # type: ignore[typeddict-item]


class Auth:
    """Sign-in, sessions and MFA over ``Users``. Pass the same ``now`` clock to ``JwtTokens``."""

    def __init__(
        self,
        users: Users,
        tokens: JwtTokens,
        mail: Mailer,
        secret: str,
        provider: IdentityProvider | None = None,
        *,
        now: Clock | None = None,
    ) -> None:
        self.users = users
        self.tokens = tokens
        self.mail = mail
        self.provider = provider
        self._secret = _utf8(secret)
        self._vault = AuthVault(secret)
        self._now = now

    def _time(self) -> float:
        return epoch_ms(self._now)

    @property
    def store(self) -> NoSQL:
        return self.users.store

    def _digest(self, text: str) -> str:
        return hmac.new(self._secret, _utf8(text), hashlib.sha256).hexdigest()

    # Rate limits and sessions -------------------------------------------------------------------

    def limit(self, key: str, max: int) -> None:
        """Count one attempt for ``key`` in the current minute; 429 once ``max`` is reached."""
        now = self._time()
        sk = self._digest(f"{_js_str(key)}:{math.floor(now / 60000)}")
        for _ in range(8):
            row = self.store.get("RATE", sk)
            count = (row["data"].get("count") if row else None) or 0
            if count >= max:
                raise HttpError(429, "Too many attempts; wait one minute")
            try:
                self.store.transact([{
                    "row": {"pk": "RATE", "sk": sk, "version": (row["version"] if row else 0) + 1, "data": {"count": count + 1}, "ttl": math.floor(now / 1000) + 120},
                    "expected": row["version"] if row else None,
                }])
                return
            except Conflict:
                continue
        raise HttpError(429, "Too many simultaneous attempts")

    def actor(self, header: str | None = None) -> dict[str, Any] | None:
        """The actor of an ``Authorization: Bearer <jwt>`` header; None without a header."""
        if not header:
            return None
        if not isinstance(header, str) or not header.startswith("Bearer "):
            raise HttpError(401, "Invalid token")
        claims = self.tokens.verify(header[7:])
        user = self.users.get(claims["id"])
        provider = self.provider.id if self.provider else "local"
        if (
            not user
            or not user["data"].get("active")
            or user["data"].get("tokenVersion") != claims["version"]
            or (user["data"].get("credentialProvider") or "local") != provider
        ):
            raise HttpError(401, "Invalid session")
        return public_user(user["data"])

    def actor_from_request(self, request: Request) -> dict[str, Any] | None:
        """``App(authenticate=auth.actor_from_request)``: the actor of a web request."""
        return self.actor(request.headers.get("authorization"))

    def _session(self, row: Row) -> dict[str, Any]:
        return {"token": self.tokens.issue(public_user(row["data"])), "expiresIn": 900, "user": view_user(row["data"])}

    # Password sign-in ---------------------------------------------------------------------------

    def login(self, email: str, password: object, ip: str) -> dict[str, Any]:
        """Session, or ``{challenge: "totp", challengeId}`` for accounts with MFA."""
        if not self.settings()["values"].get("passwordLogin"):
            raise HttpError(403, "Password sign-in is disabled")
        self.limit(f"login-ip:{_js_str(ip)}", 30)
        self.limit(f"login:{_js_str(email)}", 8)
        row = self.users.by_email(email)
        if self.provider:
            if not row or not row["data"].get("active") or row["data"].get("credentialProvider") != self.provider.id:
                raise HttpError(401, "Incorrect email or password")
            result = self.provider.password(row["data"]["id"], validate_password(password))
            if "challenge" in result:
                return self._pending(row, "totp", {"providerSession": result.get("session")})
            return self._session(row)
        stored = row["data"].get("passwordHash") if row else None
        valid = verify_password(password, stored if stored is not None else DUMMY_HASH)
        if not row or not row["data"].get("active") or not valid:
            raise HttpError(401, "Incorrect email or password")
        mfa = self.store.get("MFA", row["data"]["id"])
        if mfa and mfa["data"].get("enabled"):
            return self._pending(row, "totp", {})
        return self._session(row)

    # Email codes ----------------------------------------------------------------------------------

    def issue(self, email: str, purpose: Purpose, ip: str) -> dict[str, Any]:
        """Email a sign-in or reset code to an active account; the answer never reveals which."""
        if purpose == "login" and not self.settings()["values"].get("emailCodeLogin"):
            raise HttpError(403, "Email code sign-in is disabled")
        self.limit(f"mail-ip:{_js_str(ip)}", 20)
        self.limit(f"mail:{_js_str(email)}", 3)
        user = self.users.by_email(email)

        def reply() -> dict[str, Any]:
            extra = {"challenge": "email", "challengeId": str(uuid.uuid4())} if self.provider and purpose == "login" else {}
            return {"message": CODE_REPLY, **extra}

        if user and user["data"].get("active"):
            if purpose == "login" and self.has_mfa(user["data"]["id"]):
                return reply()
            if self.provider:
                if user["data"].get("credentialProvider") != self.provider.id:
                    return reply()
                if purpose == "reset":
                    self.provider.forgot(user["data"]["id"])
                    return reply()
                session = self.provider.email_code(user["data"]["id"])
                return {**self._pending(user, "email", {"providerSession": session}), "message": CODE_REPLY}
            code = str(100000 + secrets.randbelow(900000))
            sk = self._digest(f"{purpose}:{_js_str(email)}")
            old = self.store.get("CHALLENGE", sk)
            now = self._time()
            self.store.transact([{
                "row": {
                    "pk": "CHALLENGE",
                    "sk": sk,
                    "version": (old["version"] if old else 0) + 1,
                    "ttl": math.floor(now / 1000) + 600,
                    "data": {
                        "userId": user["data"]["id"],
                        "hash": self._digest(f"{purpose}:{_js_str(email)}:{code}"),
                        "attempts": 0,
                        "used": False,
                        "expires": now + 600000,
                        "tokenVersion": user["data"]["tokenVersion"],
                    },
                },
                "expected": old["version"] if old else None,
            }])
            self.mail.send_code(email, code, purpose)
        return reply()

    def _challenge(self, row: Row | None, text: Callable[[Row], str]) -> Row:
        """A live challenge whose hash is ``digest(text(row))``; wrong codes count as attempts."""
        if not row or row["data"].get("used") or row["data"]["expires"] < self._time() or row["data"]["attempts"] >= 5:
            raise HttpError(400, "Invalid or expired code")
        if not _same_hex(row["data"].get("hash"), self._digest(text(row))):
            self.store.transact([{"row": _bump(row, attempts=row["data"]["attempts"] + 1), "expected": row["version"]}])
            raise HttpError(400, "Invalid or expired code")
        return row

    def consume(
        self,
        email: str,
        code: object,
        purpose: Purpose,
        ip: str,
        password: object = None,
        challenge_id: object = None,
    ) -> dict[str, Any]:
        """Redeem an emailed code: a session for login, a new password for reset."""
        if purpose == "login" and not self.settings()["values"].get("emailCodeLogin"):
            raise HttpError(403, "Email code sign-in is disabled")
        self.limit(f"verify-ip:{_js_str(ip)}", 30)
        self.limit(f"verify:{_js_str(email)}", 8)
        if not _is_code(code):
            raise HttpError(400, "Invalid code")
        if self.provider:
            user = self.users.by_email(email)
            if not user or not user["data"].get("active") or user["data"].get("credentialProvider") != self.provider.id:
                raise HttpError(400, "Invalid or expired code")
            if purpose == "reset":
                self.provider.reset(user["data"]["id"], code, validate_password(password))  # type: ignore[arg-type]
                self._invalidate(user)
                return {"message": "Password updated. Sign in to continue."}
            pending = self._read_pending(challenge_id, "email")
            if pending["data"]["userId"] != user["data"]["id"]:
                raise HttpError(400, "Invalid code")
            session = self._vault.open(pending["data"]["sealed"]).get("providerSession")
            self.provider.verify_email_code(user["data"]["id"], session, code)  # type: ignore[arg-type]
            self._finish_pending(pending)
            return self._session(user)
        row = self.store.get("CHALLENGE", self._digest(f"{purpose}:{_js_str(email)}"))
        row = self._challenge(row, lambda _: f"{purpose}:{_js_str(email)}:{code}")
        user = self.users.get(row["data"]["userId"])
        if not user or not user["data"].get("active") or user["data"].get("tokenVersion") != row["data"].get("tokenVersion"):
            raise HttpError(400, "Invalid or expired code")
        consumed: Write = {"row": _bump(row, used=True), "expected": row["version"]}
        if purpose == "reset":
            password_hash = hash_password(password)
            self.store.transact([
                consumed,
                {"row": _bump(user, passwordHash=password_hash, tokenVersion=user["data"]["tokenVersion"] + 1), "expected": user["version"]},
            ])
            return {"message": "Password updated. Sign in to continue."}
        if self.has_mfa(user["data"]["id"]):
            raise HttpError(403, "Use your password and authenticator")
        self.store.transact([consumed])
        return self._session(user)

    # Email change ---------------------------------------------------------------------------------

    def request_email_change(self, user_id: str, email: str, ip: str) -> dict[str, Any]:
        """Mail a code to the new address; the change applies once it is confirmed."""
        self.limit(f"email-change-ip:{_js_str(ip)}", 10)
        self.limit(f"email-change:{_js_str(user_id)}", 3)
        if self.users.by_email(email):
            raise HttpError(400, "This email address cannot be used")
        code = str(100000 + secrets.randbelow(900000))
        sk = self._digest(f"email-change:{_js_str(user_id)}")
        old = self.store.get("CHALLENGE", sk)
        user = self.users.get(user_id)
        if not user or not user["data"].get("active"):
            raise HttpError(401, "Invalid session")
        now = self._time()
        self.store.transact([{
            "row": {
                "pk": "CHALLENGE",
                "sk": sk,
                "version": (old["version"] if old else 0) + 1,
                "ttl": math.floor(now / 1000) + 600,
                "data": {
                    "email": email,
                    "userId": user_id,
                    "hash": self._digest(f"email-change:{_js_str(user_id)}:{_js_str(email)}:{code}"),
                    "used": False,
                    "attempts": 0,
                    "expires": now + 600000,
                    "tokenVersion": user["data"]["tokenVersion"],
                },
            },
            "expected": old["version"] if old else None,
        }])
        self.mail.send_code(email, code, "email-change")
        return {"message": "We sent a code to the new email address."}

    def confirm_email_change(self, user_id: str, code: object, ip: str) -> dict[str, Any]:
        """Apply a pending email change atomically (user, both EMAIL index rows) → new session."""
        self.limit(f"email-confirm:{_js_str(user_id)}", 8)
        self.limit(f"email-confirm-ip:{_js_str(ip)}", 20)
        if not _is_code(code):
            raise HttpError(400, "Invalid code")
        row = self.store.get("CHALLENGE", self._digest(f"email-change:{_js_str(user_id)}"))
        row = self._challenge(row, lambda r: f"email-change:{_js_str(user_id)}:{_js_str(r['data'].get('email'))}:{code}")
        new_email = row["data"]["email"]
        user = self.users.get(user_id)
        if not user or not user["data"].get("active") or user["data"].get("tokenVersion") != row["data"].get("tokenVersion"):
            raise HttpError(401, "Invalid session")
        index = self.store.get("EMAIL", user["data"]["email"])
        if not index:
            raise RuntimeError("Email index missing")
        if self.provider:
            self.provider.change_email(user_id, new_email)
        updated = _bump(user, email=new_email, tokenVersion=user["data"]["tokenVersion"] + 1)
        self.store.transact([
            {"row": _bump(row, used=True), "expected": row["version"]},
            {"row": updated, "expected": user["version"]},
            {"row": index, "expected": index["version"], "delete": True},
            {"row": {"pk": "EMAIL", "sk": new_email, "version": 1, "data": {"id": user_id}}, "expected": None},
        ])
        return self._session(updated)

    # Pending challenges and MFA ---------------------------------------------------------------------

    def _invalidate(self, row: Row) -> None:
        self.store.transact([{"row": _bump(row, tokenVersion=row["data"]["tokenVersion"] + 1), "expected": row["version"]}])

    def has_mfa(self, id: str) -> bool:
        if self.provider:
            return bool(self.provider.mfa_status(id))
        row = self.store.get("MFA", id)
        return bool(row and row["data"].get("enabled"))

    def _pending(self, user: Row, kind: str, value: Mapping[str, Any]) -> dict[str, Any]:
        id = str(uuid.uuid4())
        now = self._time()
        data = {
            "userId": user["data"]["id"],
            "tokenVersion": user["data"]["tokenVersion"],
            "kind": kind,
            "expires": now + 300000,
            "used": False,
            "sealed": self._vault.seal(value),
        }
        self.store.transact([{"row": {"pk": "AUTH_FLOW", "sk": id, "version": 1, "ttl": math.floor(now / 1000) + 300, "data": data}, "expected": None}])
        return {"challenge": kind, "challengeId": id}

    def _read_pending(self, id: object, kind: str) -> Row:
        if not isinstance(id, str) or _js.utf16_length(id) > 100:
            raise HttpError(400, "Invalid challenge")
        row = self.store.get("AUTH_FLOW", id)
        if not row or row["data"].get("kind") != kind or row["data"].get("used") or row["data"]["expires"] < self._time():
            raise HttpError(400, "Invalid or expired challenge")
        user = self.users.get(row["data"]["userId"])
        if not user or not user["data"].get("active") or user["data"].get("tokenVersion") != row["data"].get("tokenVersion"):
            raise HttpError(401, "Invalid session")
        return row

    def _finish_pending(self, row: Row) -> None:
        self.store.transact([{"row": _bump(row, used=True), "expected": row["version"]}])

    def _user(self, id: str) -> Row:
        user = self.users.get(id)
        if user is None:
            raise TypeError(f"User {id} does not exist")  # the reference fails the same way (500)
        return user

    def verify_mfa(self, id: object, code: object, ip: str) -> dict[str, Any]:
        """Finish a password sign-in with an authenticator code → session."""
        self.limit(f"mfa-ip:{_js_str(ip)}", 20)
        pending = self._read_pending(id, "totp")
        self.limit(f"mfa-user:{_js_str(pending['data']['userId'])}", 5)
        if not _is_code(code):
            raise HttpError(400, "Invalid code")
        user = self._user(pending["data"]["userId"])
        if self.provider:
            session = self._vault.open(pending["data"]["sealed"]).get("providerSession")
            self.provider.verify_totp(user["data"]["id"], session, code)  # type: ignore[arg-type]
            self._finish_pending(pending)
        else:
            row = self.store.get("MFA", user["data"]["id"])
            if not row or not row["data"].get("enabled"):
                raise HttpError(400, "MFA is not configured")
            secret = self._vault.open(row["data"]["sealed"])["secret"]
            step = totp_step(secret, code, row["data"].get("lastStep", -1), self._time())
            if step is None:
                raise HttpError(400, "Invalid or previously used code")
            self.store.transact([
                {"row": _bump(row, lastStep=step), "expected": row["version"]},
                {"row": _bump(pending, used=True), "expected": pending["version"]},
            ])
        return self._session(user)

    def setup_mfa(self, id: str, password: object, ip: str) -> dict[str, Any]:
        """Start TOTP enrollment (password required) → ``{challenge, challengeId, secret, uri}``."""
        self.limit(f"mfa-setup:{_js_str(ip)}", 5)
        self.limit(f"mfa-setup-user:{_js_str(id)}", 5)
        if not self.settings()["values"].get("passwordLogin"):
            raise HttpError(409, "Enable password sign-in before enabling MFA")
        if self.has_mfa(id):
            raise HttpError(409, "MFA is already enabled")
        found = self.users.get(id)
        validate_password(password)
        user = found if found is not None else self._user(id)
        access_token: str | None = None
        if self.provider:
            result = self.provider.password(id, password)  # type: ignore[arg-type]
            if "challenge" in result:
                raise HttpError(409, "MFA is already enabled")
            access_token = result["accessToken"]
            secret = self.provider.begin_totp(access_token)  # type: ignore[arg-type]
        else:
            if not verify_password(password, user["data"].get("passwordHash")):  # type: ignore[arg-type]
                raise HttpError(401, "Incorrect password")
            secret = totp_secret()
        sealed = {"secret": secret} if access_token is None else {"secret": secret, "accessToken": access_token}
        pending = self._pending(user, "enroll", sealed)
        email = urllib.parse.quote(user["data"]["email"], safe="-_.!~*'()")
        uri = f"otpauth://totp/RT-APP:{email}?secret={secret}&issuer=RT-APP&algorithm=SHA1&digits=6&period=30"
        return {**pending, "secret": secret, "uri": uri}

    def enable_mfa(self, id: str, challenge_id: object, code: object, ip: str) -> dict[str, Any]:
        """Confirm enrollment with a first code; revokes every session of the account."""
        self.limit(f"mfa-enable:{_js_str(ip)}", 10)
        self.limit(f"mfa-enable-user:{_js_str(id)}", 5)
        pending = self._read_pending(challenge_id, "enroll")
        if pending["data"]["userId"] != id:
            raise HttpError(403, "Challenge belongs to another account")
        if self.has_mfa(id):
            raise HttpError(409, "MFA is already enabled")
        if not _is_code(code):
            raise HttpError(400, "Invalid code")
        value = self._vault.open(pending["data"]["sealed"])
        user = self._user(id)
        if self.provider:
            self.provider.enable_totp(id, value.get("accessToken"), code)  # type: ignore[arg-type]
            mfa = {"enabled": True, "provider": self.provider.id}
        else:
            step = totp_step(value["secret"], code, -1, self._time())
            if step is None:
                raise HttpError(400, "Invalid code")
            mfa = {"enabled": True, "sealed": self._vault.seal({"secret": value["secret"]}), "lastStep": step}
        # Invalidate every application session and keep the enrollment marker, atomically.
        self.store.transact([
            {"row": {"pk": "MFA", "sk": id, "version": 1, "data": mfa}, "expected": None},
            {"row": _bump(pending, used=True), "expected": pending["version"]},
            {"row": _bump(user, tokenVersion=user["data"]["tokenVersion"] + 1), "expected": user["version"]},
        ])
        return {"message": "MFA enabled. Sign in again.", "reauthenticate": True}

    def reset_mfa(self, id: object) -> dict[str, Any]:
        """Owner recovery: remove MFA and revoke the account's sessions."""
        if not isinstance(id, str) or _js.utf16_length(id) > 100:
            raise HttpError(400, "Invalid user")
        user = self.users.get(id)
        if not user:
            raise HttpError(404, "User not found")
        mfa = self.store.get("MFA", id)
        if self.provider:
            self.provider.disable_mfa(id)
        writes: list[Write] = [{"row": mfa, "expected": mfa["version"], "delete": True}] if mfa else []
        writes.append({"row": _bump(user, tokenVersion=user["data"]["tokenVersion"] + 1), "expected": user["version"]})
        self.store.transact(writes)
        return {"message": "MFA reset; application sessions have been invalidated."}

    # Settings ---------------------------------------------------------------------------------------

    def settings(self) -> dict[str, Any]:
        row = self.store.get("SETTINGS", "auth")
        return {
            "version": row["version"] if row else 0,
            "values": row["data"] if row else {"passwordLogin": True, "emailCodeLogin": True},
            "fields": [
                {"name": "passwordLogin", "label": "Allow password sign-in", "type": "boolean"},
                {"name": "emailCodeLogin", "label": "Allow email code sign-in", "type": "boolean"},
            ],
        }

    def update_settings(self, input: Mapping[str, Any]) -> dict[str, Any]:
        """Versioned update of the sign-in methods; at least one must stay enabled."""
        input = input if isinstance(input, Mapping) else {}
        version, values = input.get("version"), input.get("values")
        values = values if isinstance(values, Mapping) else {}
        password_login, email_login = values.get("passwordLogin"), values.get("emailCodeLogin")
        is_integer = _js.is_number(version) and float(version).is_integer()  # type: ignore[arg-type]
        if not is_integer or not isinstance(password_login, bool) or not isinstance(email_login, bool) or not (password_login or email_login):
            raise HttpError(400, "At least one sign-in method must remain enabled")
        if not password_login and any(row["data"].get("enabled") for row in self.store.list("MFA")["items"]):
            raise HttpError(409, "Password sign-in is required for accounts with MFA")
        row = self.store.get("SETTINGS", "auth")
        if version != (row["version"] if row else 0):
            raise Conflict()
        self.store.transact([{
            "row": {"pk": "SETTINGS", "sk": "auth", "version": version + 1, "data": {"passwordLogin": password_login, "emailCodeLogin": email_login}},  # type: ignore[operator]
            "expected": row["version"] if row else None,
        }])
        return self.settings()

    # HTTP -------------------------------------------------------------------------------------------

    def _logout(self, c: Context) -> dict[str, Any]:
        row = self._user(c.actor["id"])  # type: ignore[index]
        if self.provider:
            self.provider.logout(row["data"]["id"])
        self._invalidate(row)
        return {"ok": True}

    def _methods(self, _: Context) -> dict[str, Any]:
        provider = self.provider.id if self.provider else "local"
        return {**self.settings()["values"], "provider": provider, "totp": True, "selfRegistration": False, "refreshTokens": False}

    def feature(self) -> Feature:
        """The endpoints of the TypeScript module, same paths, resources and access."""
        body: Callable[[Context], Mapping[str, Any]] = lambda c: c.request.body  # noqa: E731
        actor_id: Callable[[Context], str] = lambda c: c.actor["id"]  # type: ignore[index]  # noqa: E731
        return Feature(
            id="auth",
            admin={
                "id": "auth",
                "group": "authentication",
                "title": "Authentication",
                "resource": "auth.settings.read",
                "path": "/auth/settings",
                "component": "auth-settings",
                "fields": [],
                "actions": [],
                "settings": {"path": "/auth/settings", "resource": "auth.settings.write"},
            },
            endpoints=[
                Endpoint("POST", "/auth/mfa/reset", "auth.mfa.reset", "owner", lambda c: self.reset_mfa(body(c).get("userId"))),
                Endpoint("POST", "/auth/mfa/verify", "auth.mfa.verify", "guest",
                         lambda c: self.verify_mfa(body(c).get("challengeId"), body(c).get("code"), c.request.ip)),
                Endpoint("GET", "/auth/mfa", "auth.mfa.status", "authenticated",
                         lambda c: {"enabled": self.has_mfa(actor_id(c)), "type": "totp"}),
                Endpoint("POST", "/auth/mfa/setup", "auth.mfa.setup", "authenticated",
                         lambda c: self.setup_mfa(actor_id(c), body(c).get("password"), c.request.ip)),
                Endpoint("POST", "/auth/mfa/enable", "auth.mfa.enable", "authenticated",
                         lambda c: self.enable_mfa(actor_id(c), body(c).get("challengeId"), body(c).get("code"), c.request.ip)),
                Endpoint("GET", "/auth/methods", "auth.methods", "guest", self._methods),
                Endpoint("GET", "/auth/settings", "auth.settings.read", "permission", lambda c: self.settings()),
                Endpoint("PUT", "/auth/settings", "auth.settings.write", "owner", lambda c: self.update_settings(body(c))),
                Endpoint("POST", "/auth/login", "auth.login", "guest",
                         lambda c: self.login(email_address(body(c).get("email")), body(c).get("password"), c.request.ip)),
                Endpoint("POST", "/auth/code", "auth.code", "guest",
                         lambda c: self.issue(email_address(body(c).get("email")), "login", c.request.ip)),
                Endpoint("POST", "/auth/code/verify", "auth.code.verify", "guest",
                         lambda c: self.consume(email_address(body(c).get("email")), body(c).get("code"), "login", c.request.ip,
                                                None, body(c).get("challengeId"))),
                Endpoint("POST", "/auth/forgot-password", "auth.forgot", "guest",
                         lambda c: self.issue(email_address(body(c).get("email")), "reset", c.request.ip)),
                Endpoint("POST", "/auth/reset-password", "auth.reset", "guest",
                         lambda c: self.consume(email_address(body(c).get("email")), body(c).get("code"), "reset", c.request.ip,
                                                body(c).get("password"))),
                Endpoint("POST", "/auth/email-change", "auth.email.change", "authenticated",
                         lambda c: self.request_email_change(actor_id(c), email_address(body(c).get("email")), c.request.ip)),
                Endpoint("POST", "/auth/email-change/verify", "auth.email.verify", "authenticated",
                         lambda c: self.confirm_email_change(actor_id(c), body(c).get("code"), c.request.ip)),
                Endpoint("POST", "/auth/logout", "auth.logout", "authenticated", self._logout),
            ],
        )


__all__ = [
    "Auth",
    "AuthVault",
    "IdentityProvider",
    "LocalMailbox",
    "Mailer",
    "MailMessage",
    "SesMailer",
    "CODE_REPLY",
    "totp_code",
    "totp_secret",
    "totp_step",
]
