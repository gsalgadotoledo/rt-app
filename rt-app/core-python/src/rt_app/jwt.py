"""Stateless 15-minute session tokens: compact JWS with HS256 (stdlib only).

Tokens are byte-identical to the TypeScript reference (jose): header ``{"alg":"HS256","typ":"JWT"}``,
payload ``{"v","sub","iss","aud","iat","exp"}`` in that order (``{"v","sid","sub",…}`` for tokens
tied to a refresh session), compact JSON, base64url without padding. Verification follows the jose defaults the reference uses: HS256 only, exact issuer,
audience string or array, required ``exp``/``iat``/``sub``, ``exp <= now`` is expired (no leeway),
``nbf`` honored, a future ``iat`` accepted. Every failure is 401 "Invalid or expired session".
"""
from __future__ import annotations

import binascii
import hashlib
import hmac
import math
import re
from collections.abc import Mapping
from typing import Any, NotRequired, TypedDict

from . import _js
from .contracts import Clock, epoch_ms
from .errors import HttpError

SESSION_SECONDS = 900
_HEADER = '{"alg":"HS256","typ":"JWT"}'
_B64URL = re.compile(r"[A-Za-z0-9_-]*")


class Claims(TypedDict):
    id: str
    version: int
    #: The refresh session of the token, present only when the token carries a sid claim.
    sid: NotRequired[str]


def _b64url_decode(part: str) -> bytes:
    if not _B64URL.fullmatch(part) or len(part) % 4 == 1:
        raise ValueError("Invalid base64url")
    return binascii.a2b_base64(part.replace("-", "+").replace("_", "/") + "=" * (-len(part) % 4), strict_mode=True)


def _utf8(text: str) -> bytes:
    """UTF-8 like Node: lone surrogates become U+FFFD."""
    return text.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "replace").encode("utf-8")


def _json_object(part: str) -> dict[str, Any]:
    value = _js.parse(_b64url_decode(part).decode("utf-8", "replace"))
    if not isinstance(value, dict):
        raise ValueError("Not a JSON object")
    return value


def _is_integer(value: object) -> bool:
    """``Number.isInteger``: true is not a number, 1.0 is an integer."""
    return _js.is_number(value) and (isinstance(value, int) or (math.isfinite(value) and float(value).is_integer()))  # type: ignore[arg-type]


class JwtTokens:
    """Sign and verify session tokens. The secret needs at least 32 UTF-8 bytes."""

    def __init__(self, secret: str, issuer: str = "rt-app", audience: str = "rt-app-api", *, now: Clock | None = None) -> None:
        if not isinstance(secret, str) or len(_utf8(secret)) < 32:
            raise ValueError("JWT_SECRET must contain at least 32 bytes")
        self._key = _utf8(secret)
        self.issuer = issuer
        self.audience = audience
        self._now = now

    def _sign(self, signing_input: str) -> bytes:
        return hmac.new(self._key, signing_input.encode("ascii"), hashlib.sha256).digest()

    def issue(self, user: Mapping[str, Any]) -> str:
        """Sign a 15-minute session; ``user["id"]`` becomes sub and ``tokenVersion`` enables revocation.

        A non-empty string ``user["sid"]`` ties the token to a refresh session: the claim goes right
        after ``v``. A missing, null or empty sid is ignored (the token is byte-identical to before).
        """
        now = math.floor(epoch_ms(self._now) / 1000)
        payload: dict[str, Any] = {}
        if user.get("tokenVersion") is not None:
            payload["v"] = user["tokenVersion"]
        sid = user.get("sid")
        if isinstance(sid, str) and sid:
            payload["sid"] = sid
        if user.get("id") is not None:
            payload["sub"] = user["id"]
        payload.update(iss=self.issuer, aud=self.audience, iat=now, exp=now + SESSION_SECONDS)
        signing_input = f"{_js.base64url_encode(_HEADER.encode())}.{_js.base64url_encode(_utf8(_js.stringify(payload)))}"
        return f"{signing_input}.{_js.base64url_encode(self._sign(signing_input))}"

    def verify(self, token: object) -> Claims:
        """Return ``{id, version}`` (plus ``sid`` when the token has one); malformed, expired or
        foreign tokens, and a sid claim that is not a non-empty string, always raise HTTP 401."""
        try:
            return self._verify(token)
        except Exception:
            raise HttpError(401, "Invalid or expired session") from None

    def _verify(self, token: object) -> Claims:
        if not isinstance(token, str):
            raise ValueError("Token must be a string")
        parts = token.split(".")
        if len(parts) != 3:
            raise ValueError("Invalid compact JWS")
        header = _json_object(parts[0])
        if header.get("alg") != "HS256" or "crit" in header or header.get("b64") is False:
            raise ValueError("Unsupported header")
        if not hmac.compare_digest(_b64url_decode(parts[2]), self._sign(f"{parts[0]}.{parts[1]}")):
            raise ValueError("Signature mismatch")
        payload = _json_object(parts[1])
        now = math.floor(epoch_ms(self._now) / 1000)
        for claim in ("exp", "iat", "sub"):
            if claim not in payload:
                raise ValueError(f"Missing {claim}")
        for claim in ("exp", "iat", "nbf"):
            if claim in payload and not _js.is_number(payload[claim]):
                raise ValueError(f"{claim} must be a number")
        if payload.get("iss") != self.issuer:
            raise ValueError("Unexpected issuer")
        aud = payload.get("aud")
        if not (aud == self.audience if isinstance(aud, str) else isinstance(aud, list) and self.audience in aud):
            raise ValueError("Unexpected audience")
        if "nbf" in payload and payload["nbf"] > now:
            raise ValueError("Not active yet")
        if payload["exp"] <= now:
            raise ValueError("Expired")
        if not payload["sub"] or not _is_integer(payload.get("v")):
            raise ValueError("Invalid claims")
        if "sid" in payload and (not isinstance(payload["sid"], str) or not payload["sid"]):
            raise ValueError("Invalid sid")
        version = payload["v"]
        claims: Claims = {"id": payload["sub"], "version": int(version) if isinstance(version, float) else version}
        if "sid" in payload:
            claims["sid"] = payload["sid"]
        return claims


__all__ = ["JwtTokens", "Claims", "SESSION_SECONDS"]
