"""Feature hosting and forwarding for services (port of ``@gsalgadotoledo/rt-app-microservices``).

- ``Microservice(features, authenticate, invoke_metered=None, observe=None)``: hosts existing
  features without the full application. ``handle(request)`` routes (first declared match wins,
  one trailing ``/`` allowed), verifies an optional ``Bearer`` token, applies the access policy,
  decodes parameters, meters endpoints with a ``subscription`` and answers
  ``Response(status, body, [("x-request-id", <uuid4>)])``.
- ``SessionAuthenticator(tokens, resolve)``: RT-App session tokens plus an authoritative lookup
  (revocation through ``tokenVersion``).
- ``SignedJwtAuthenticator(keys, issuer, audience, resolve)``: RS256/ES256 service tokens checked
  like jose ``jwtVerify`` against a JWK Set (or a key function); ``remote_jwt_authenticator`` fetches
  the set from a fixed HTTPS URL. Needs the optional ``cryptography`` package.
- ``remote_feature(feature, base_url, transport=None, timeout_ms=10000)``: the same endpoints,
  forwarded over HTTPS; only ``authorization`` is forwarded, redirects are errors.

The contract is ``spec/contracts/microservices.contract.yaml``; TypeScript is the reference.
"""
from __future__ import annotations

import base64
import binascii
import dataclasses
import inspect
import json
import logging
import math
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Protocol

from . import _js
from .contracts import JS_WHITESPACE
from .errors import HttpError
from .web import Context, Endpoint, Request, Response, decode_uri_component

log = logging.getLogger("rt_app.microservices")

Actor = dict[str, Any]


def _resolve(value: Any) -> Any:
    return _js.run_sync(value) if inspect.isawaitable(value) else value


def _strict_equal(a: Any, b: Any) -> bool:
    """JavaScript ``===`` for JSON values (``True`` is not ``1``; objects compare by identity)."""
    if isinstance(a, bool) or isinstance(b, bool):
        return a is b
    if _js.is_number(a) and _js.is_number(b):
        return a == b
    if isinstance(a, str) and isinstance(b, str):
        return a == b
    if a is None or b is None:
        return a is b
    return a is b


class Authenticator(Protocol):
    """Turns a bearer token into the current actor, or raises (``HttpError`` for client errors)."""

    def authenticate(self, token: str) -> Actor: ...


# --- session tokens --------------------------------------------------------------------------


class SessionAuthenticator:
    """RT-App session tokens (``JwtTokens``) resolved through an authoritative actor lookup."""

    def __init__(self, tokens: Any, resolve: Callable[[str], Any]) -> None:
        self._tokens = tokens
        self._resolve = resolve

    def authenticate(self, token: str) -> Actor:
        claims = self._tokens.verify(token)
        actor = _resolve(self._resolve(claims["id"]))
        if (
            not actor
            or not _strict_equal(actor.get("id"), claims["id"])
            or not actor.get("active")
            or not _strict_equal(actor.get("tokenVersion"), claims["version"])
        ):
            raise HttpError(401, "Invalid or revoked session")
        return actor


# --- signed service tokens -------------------------------------------------------------------

_B64URL = re.compile(r"[A-Za-z0-9_-]*")
_ALGORITHMS = {"RS256": ("RSA", None), "ES256": ("EC", "P-256")}


class _Invalid(Exception):
    """Any verification failure; reported as 401 "Invalid service JWT"."""


class _NoMatchingKey(_Invalid):
    pass


def _b64url(part: str) -> bytes:
    if not isinstance(part, str) or not _B64URL.fullmatch(part) or len(part) % 4 == 1:
        raise _Invalid("Invalid base64url")
    try:
        return binascii.a2b_base64(part.replace("-", "+").replace("_", "/") + "=" * (-len(part) % 4), strict_mode=True)
    except binascii.Error:
        raise _Invalid("Invalid base64url") from None


def _json_object(data: bytes) -> dict[str, Any]:
    try:
        value = _js.parse(data.decode("utf-8"))  # strict UTF-8, like jose's fatal decoder
    except (UnicodeDecodeError, ValueError):
        raise _Invalid("Not JSON") from None
    if not isinstance(value, dict):
        raise _Invalid("Not a JSON object")
    return value


def _crypto() -> Any:
    try:
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa, utils
    except ImportError as error:  # pragma: no cover - depends on the environment
        raise RuntimeError("SignedJwtAuthenticator needs the optional 'cryptography' package (rt-app-core[crypto])") from error
    return hashes, ec, padding, rsa, utils


def _is_jwk_set(value: Any) -> bool:
    return isinstance(value, Mapping) and isinstance(value.get("keys"), list) and all(isinstance(k, Mapping) for k in value["keys"])


def _usable(jwk: Mapping[str, Any], alg: str, kid: Any) -> bool:
    """jose ``isUsableJWK``: kty from alg, kid, jwk alg, use, key_ops, ext and curve."""
    kty, crv = _ALGORITHMS[alg]
    key_ops = jwk.get("key_ops")
    if "ext" in jwk and not isinstance(jwk["ext"], bool):
        return False
    if key_ops is not None and not (
        isinstance(key_ops, list)
        and all(isinstance(op, str) for op in key_ops)
        and len(set(key_ops)) == len(key_ops)
        and "verify" in key_ops
    ):
        return False
    if jwk.get("kty") != kty:
        return False
    if kid is not None and not (isinstance(kid, str) and kid == jwk.get("kid")):
        return False
    if "alg" in jwk and jwk["alg"] != alg:
        return False
    if "use" in jwk and jwk["use"] != "sig":
        return False
    return crv is None or jwk.get("crv") == crv


def _public_key(jwk: Mapping[str, Any]) -> Any:
    """A public key from a JWK (RSA of at least 2048 bits, or EC P-256); private keys are refused."""
    _, ec, _, rsa, _ = _crypto()
    if "d" in jwk:
        raise _Invalid("JSON Web Key Set members must be public keys")
    if jwk.get("kty") == "RSA":
        n = int.from_bytes(_b64url(jwk.get("n")), "big")
        e = int.from_bytes(_b64url(jwk.get("e")), "big")
        if n.bit_length() < 2048:
            raise _Invalid("RS256 requires key modulusLength to be 2048 bits or larger")
        try:
            return rsa.RSAPublicNumbers(e, n).public_key()
        except ValueError:
            raise _Invalid("Invalid RSA key") from None
    x, y = _b64url(jwk.get("x")), _b64url(jwk.get("y"))
    if len(x) != 32 or len(y) != 32:
        raise _Invalid("Invalid P-256 key")
    try:
        return ec.EllipticCurvePublicNumbers(int.from_bytes(x, "big"), int.from_bytes(y, "big"), ec.SECP256R1()).public_key()
    except ValueError:
        raise _Invalid("Invalid P-256 key") from None


def _select(keys: Mapping[str, Any], alg: str, kid: Any) -> Any:
    candidates = [jwk for jwk in keys["keys"] if _usable(jwk, alg, kid)]
    if not candidates:
        raise _NoMatchingKey("no applicable key found in the JSON Web Key Set")
    if len(candidates) != 1:
        raise _Invalid("multiple matching keys found in the JSON Web Key Set")
    return _public_key(candidates[0])


def _verify_signature(key: Any, alg: str, signature: bytes, signing_input: bytes) -> None:
    hashes, ec, padding, rsa, utils = _crypto()
    try:
        if alg == "RS256":
            if not isinstance(key, rsa.RSAPublicKey):
                raise _Invalid("Key type mismatch")
            if key.key_size < 2048:
                raise _Invalid("RS256 requires key modulusLength to be 2048 bits or larger")
            key.verify(signature, signing_input, padding.PKCS1v15(), hashes.SHA256())
        else:
            if not isinstance(key, ec.EllipticCurvePublicKey) or key.curve.name != "secp256r1":
                raise _Invalid("Key type mismatch")
            if len(signature) != 64:  # WebCrypto ECDSA signatures are r || s
                raise _Invalid("Invalid signature")
            der = utils.encode_dss_signature(int.from_bytes(signature[:32], "big"), int.from_bytes(signature[32:], "big"))
            key.verify(der, signing_input, ec.ECDSA(hashes.SHA256()))
    except _Invalid:
        raise
    except Exception:
        raise _Invalid("signature verification failed") from None


def _check_crit(header: Mapping[str, Any]) -> bool:
    """jose ``validateCrit`` + ``validateB64`` for JWS: only ``b64`` is recognized. Returns b64."""
    if "crit" not in header:
        return True
    crit = header["crit"]
    if not isinstance(crit, list) or not crit or any(not isinstance(p, str) or not p for p in crit):
        raise _Invalid('"crit" must be an array of non-empty strings')
    if len(set(crit)) != len(crit):
        raise _Invalid('"crit" must not contain duplicates')
    for parameter in crit:
        if parameter != "b64":
            raise _Invalid(f'Extension Header Parameter "{parameter}" is not recognized')
        if header.get(parameter) is None:
            raise _Invalid(f'Extension Header Parameter "{parameter}" is missing')
    if "b64" in crit:
        if not isinstance(header["b64"], bool):
            raise _Invalid('The "b64" Header Parameter must be a boolean')
        return header["b64"]
    return True


def _number(payload: Mapping[str, Any], claim: str) -> Any:
    value = payload.get(claim)
    if claim in payload and not _js.is_number(value):
        raise _Invalid(f'"{claim}" claim must be a number')
    return value if claim in payload else None


KeySource = "Mapping[str, Any] | Callable[[dict[str, Any]], Any]"


class SignedJwtAuthenticator:
    """Asymmetric service tokens (RS256, ES256). The resolver maps verified claims to the current actor.

    ``keys`` is a JWK Set (``{"keys": [...]}``) or a function of the protected header returning a
    ``cryptography`` public key. ``now`` (epoch seconds) is for tests.
    """

    def __init__(
        self,
        keys: Any,
        issuer: str,
        audience: str,
        resolve: Callable[[dict[str, Any]], Any],
        *,
        now: Callable[[], float] | None = None,
    ) -> None:
        if not callable(keys) and not _is_jwk_set(keys):
            raise TypeError("JSON Web Key Set malformed")
        if not issuer or not audience:
            raise TypeError("JWT issuer and audience required")
        self._keys = keys
        self.issuer = issuer
        self.audience = audience
        self._resolve = resolve
        self._now = now or time.time

    def _key(self, header: dict[str, Any], alg: str) -> Any:
        if callable(self._keys):
            return self._keys(header)
        return _select(self._keys, alg, header.get("kid"))

    def verify(self, token: object) -> dict[str, Any]:
        """The verified payload; raises ``HttpError(401, "Invalid service JWT")`` on any failure."""
        try:
            return self._verify(token)
        except HttpError:
            raise
        except Exception:
            raise HttpError(401, "Invalid service JWT") from None

    def _verify(self, token: object) -> dict[str, Any]:
        if not isinstance(token, str):
            raise _Invalid("Compact JWS must be a string")
        parts = token.split(".")
        if len(parts) != 3:
            raise _Invalid("Invalid Compact JWS")
        header = _json_object(_b64url(parts[0]))
        b64 = _check_crit(header)
        alg = header.get("alg")
        if not isinstance(alg, str) or not alg or alg not in _ALGORITHMS:
            raise _Invalid('"alg" (Algorithm) Header Parameter value not allowed')
        _b64url(parts[1])
        key = self._key(header, alg)
        signature = _b64url(parts[2])
        _verify_signature(key, alg, signature, f"{parts[0]}.{parts[1]}".encode("ascii"))
        if not b64:
            raise _Invalid("JWTs MUST NOT use unencoded payload")
        payload = _json_object(_b64url(parts[1]))
        for claim in ("iss", "aud", "sub", "iat", "exp"):
            if claim not in payload:
                raise _Invalid(f'missing required "{claim}" claim')
        if not _strict_equal(payload["iss"], self.issuer):
            raise _Invalid('unexpected "iss" claim value')
        aud = payload["aud"]
        if not (aud == self.audience if isinstance(aud, str) else isinstance(aud, list) and any(_strict_equal(a, self.audience) for a in aud)):
            raise _Invalid('unexpected "aud" claim value')
        now = math.floor(self._now())
        _number(payload, "iat")
        nbf = _number(payload, "nbf")
        if nbf is not None and nbf > now:
            raise _Invalid('"nbf" claim timestamp check failed')
        exp = _number(payload, "exp")
        if exp is not None and exp <= now:
            raise _Invalid('"exp" claim timestamp check failed')
        return payload

    def authenticate(self, token: str) -> Actor:
        payload = self.verify(token)
        actor = _resolve(self._resolve(payload))
        if not actor or not _strict_equal(actor.get("id"), payload.get("sub")) or not actor.get("active"):
            raise HttpError(401, "Inactive service identity")
        return actor


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> Any:
        raise urllib.error.URLError(f"Redirect refused ({code})")


def _opener() -> urllib.request.OpenerDirector:
    return urllib.request.build_opener(_NoRedirect())


def _fetch_json(url: str, timeout_s: float = 5.0) -> Any:
    request = urllib.request.Request(url, headers={"accept": "application/json"})
    with _opener().open(request, timeout=timeout_s) as response:
        return json.loads(response.read())


class RemoteJWKSet:
    """A JWK Set fetched from a fixed URL, like jose ``createRemoteJWKSet``: cached for 10 minutes,
    fetched again when no key matches (at most every 30 seconds). ``fetch(url)`` returns the JSON."""

    def __init__(
        self,
        url: str,
        *,
        fetch: Callable[[str], Any] | None = None,
        cache_max_age: float = 600.0,
        cooldown: float = 30.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.url = url
        self._fetch = fetch or _fetch_json
        self._max_age, self._cooldown, self._clock = cache_max_age, cooldown, clock
        self._keys: Any = None
        self._fetched_at: float | None = None
        self._lock = threading.Lock()

    def _reload(self) -> Any:
        keys = self._fetch(self.url)
        if not _is_jwk_set(keys):
            raise _Invalid("JSON Web Key Set malformed")
        self._keys, self._fetched_at = keys, self._clock()
        return keys

    def __call__(self, header: dict[str, Any]) -> Any:
        alg = header.get("alg")
        with self._lock:
            now = self._clock()
            if self._keys is None or self._fetched_at is None or now - self._fetched_at >= self._max_age:
                self._reload()
            try:
                return _select(self._keys, alg, header.get("kid"))
            except _NoMatchingKey:
                if self._fetched_at is not None and now - self._fetched_at < self._cooldown:
                    raise
                return _select(self._reload(), alg, header.get("kid"))


# --- URLs (WHATWG subset) --------------------------------------------------------------------

_SCHEME = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*")
_C0_SPACE = "".join(chr(c) for c in range(0x21))


@dataclass(frozen=True)
class _Url:
    scheme: str
    username: str
    password: str
    host: str
    port: int | None
    path: str
    query: str
    fragment: str

    @property
    def origin(self) -> str:
        default = {"https": 443, "http": 80}.get(self.scheme)
        port = "" if self.port is None or self.port == default else f":{self.port}"
        return f"{self.scheme}://{self.host}{port}"


def _parse_url(text: str) -> _Url:
    """What ``new URL(text)`` reads for absolute URLs; ``TypeError("Invalid URL")`` otherwise."""
    if not isinstance(text, str):
        raise TypeError("Invalid URL")
    text = re.sub("[\t\n\r]", "", text.strip(_C0_SPACE))
    scheme, sep, _ = text.partition(":")
    if not sep or not _SCHEME.fullmatch(scheme):
        raise TypeError("Invalid URL")
    parts = urllib.parse.urlsplit(text)
    scheme = scheme.lower()
    try:
        port = parts.port
    except ValueError:
        raise TypeError("Invalid URL") from None
    host = (parts.hostname or "").lower()
    if scheme in ("http", "https") and not host:
        raise TypeError("Invalid URL")
    if ":" in host:
        host = f"[{host}]"
    netloc = parts.netloc
    userinfo = netloc.rpartition("@")[0] if "@" in netloc else ""
    username, _, password = userinfo.partition(":")
    path = parts.path or ("/" if scheme in ("http", "https") else "")
    return _Url(scheme, username, password, host, port, path, parts.query, parts.fragment)


def remote_jwt_authenticator(
    jwks_url: str,
    issuer: str,
    audience: str,
    resolve: Callable[[dict[str, Any]], Any],
    *,
    fetch: Callable[[str], Any] | None = None,
) -> SignedJwtAuthenticator:
    """Service tokens verified with keys from a fixed HTTPS JWKS URL (never from token headers)."""
    url = _parse_url(jwks_url)
    if url.scheme != "https" or url.username or url.password:
        raise TypeError("JWKS requires HTTPS")
    return SignedJwtAuthenticator(RemoteJWKSet(jwks_url, fetch=fetch), issuer, audience, resolve)


# --- hosting ---------------------------------------------------------------------------------

_BEARER = re.compile(f"[Bb][Ee][Aa][Rr][Ee][Rr] [^{JS_WHITESPACE}]+")


@dataclass(frozen=True)
class MeteredEndpoint(Endpoint):
    """An endpoint with a subscription (``{product, credits}``): served through ``invoke_metered``."""

    subscription: Any = None


@dataclass(frozen=True)
class _Route:
    endpoint: Any
    names: tuple[str, ...]
    pattern: re.Pattern[str]


def _compile(endpoint: Any) -> _Route:
    names: list[str] = []
    parts: list[str] = []
    for segment in endpoint.path.split("/"):
        if segment.startswith(":"):
            names.append(segment[1:])
            parts.append("([^/]+)")
        else:
            parts.append(re.escape(segment))
    return _Route(endpoint, tuple(names), re.compile("/".join(parts) + "/?", re.DOTALL))


def _endpoints(feature: Any) -> Sequence[Any]:
    return feature["endpoints"] if isinstance(feature, Mapping) else feature.endpoints


def _request(request: Any) -> Request:
    if isinstance(request, Request):
        return request
    r = dict(request)
    return Request(
        method=r.get("method", "GET"),
        path=r.get("path", "/"),
        body=r.get("body") if r.get("body") is not None else {},
        query=r.get("query") or {},
        headers=r.get("headers") or {},
        ip=r.get("ip") or "",
    )


def _authorize(endpoint: Any, actor: Actor | None) -> None:
    access = endpoint.access
    if access == "guest":
        return
    if not actor or not actor.get("active"):
        raise HttpError(401, "Sign in")
    if access == "owner" and actor.get("role") != "owner":
        raise HttpError(403, "Owner permission required")
    if access == "permission" and not (
        endpoint.resource in actor["grants"] or (not endpoint.explicit_grant and actor.get("role") == "owner")
    ):
        raise HttpError(403, "Permission required")


Metric = dict[str, Any]


class Microservice:
    """Hosts selected features: routing, bearer authentication, access policy, metering, telemetry.

    ``invoke_metered(endpoint, actor, work)`` is required for endpoints with a subscription;
    ``observe({requestId, route, status, durationMs})`` runs after every request (errors ignored).
    """

    def __init__(
        self,
        features: Sequence[Any],
        authenticate: Authenticator,
        invoke_metered: Callable[[Any, Actor | None, Callable[[], Any]], Any] | None = None,
        observe: Callable[[Metric], Any] | None = None,
    ) -> None:
        self._routes = [_compile(endpoint) for feature in features for endpoint in _endpoints(feature)]
        if len({f"{r.endpoint.method} {r.endpoint.path}" for r in self._routes}) != len(self._routes):
            raise TypeError("Duplicate service route")
        self._authenticate = authenticate
        self._invoke_metered = invoke_metered
        self._observe = observe

    def handle(self, request: Any) -> Response:
        request = _request(request)
        request_id = str(uuid.uuid4())
        start = time.perf_counter()
        route, status = "/unmatched", 500
        try:
            selected = next(
                (r for r in self._routes if r.endpoint.method == request.method and r.pattern.fullmatch(request.path)),
                None,
            )
            if selected is None:
                raise HttpError(404, "Not found")
            route = selected.endpoint.path
            authorization = request.headers.get("authorization")
            actor: Actor | None = None
            if authorization:
                if not _BEARER.fullmatch(authorization):
                    raise HttpError(401, "Invalid authorization")
                actor = _resolve(self._authenticate.authenticate(authorization[7:]))
            _authorize(selected.endpoint, actor)
            match = selected.pattern.fullmatch(request.path)
            assert match is not None
            try:
                params = {name: decode_uri_component(match.group(i + 1)) for i, name in enumerate(selected.names)}
            except ValueError:
                raise HttpError(400, "Invalid route encoding") from None
            forwarded = dataclasses.replace(request, headers={**request.headers, "x-request-id": request_id})
            context = Context(request=forwarded, params=params, actor=actor)

            def work() -> Any:
                return _resolve(selected.endpoint.handle(context))

            if getattr(selected.endpoint, "subscription", None) is not None:
                if self._invoke_metered is None:
                    raise HttpError(503, "Metering adapter required")
                body = _resolve(self._invoke_metered(selected.endpoint, actor, work))
            else:
                body = work()
            status = 200
            return Response(status, body, [("x-request-id", request_id)])
        except Exception as error:
            if isinstance(error, HttpError):
                status = error.status
                return Response(status, {"error": error.message}, [("x-request-id", request_id)])
            status = 500
            log.exception("Unhandled error in %s", route)
            return Response(status, {"error": "Internal error"}, [("x-request-id", request_id)])
        finally:
            if self._observe is not None:
                try:
                    _resolve(
                        self._observe(
                            {"requestId": request_id, "route": route, "status": status, "durationMs": (time.perf_counter() - start) * 1000}
                        )
                    )
                except Exception:  # noqa: BLE001 - telemetry must not change a completed operation
                    pass


# --- forwarding ------------------------------------------------------------------------------


@dataclass(frozen=True)
class RemoteRequest:
    url: str
    method: str
    headers: dict[str, str]
    body: str | None
    timeout_ms: int
    redirect: str = "error"


@dataclass(frozen=True)
class RemoteResponse:
    status: int
    body: bytes = b""


Transport = Callable[[RemoteRequest], RemoteResponse]


def urllib_transport(request: RemoteRequest) -> RemoteResponse:
    """HTTP(S) with urllib: redirects are errors, non-2xx answers are returned, not raised."""
    data = None if request.body is None else request.body.encode("utf-8")
    raw = urllib.request.Request(request.url, data=data, method=request.method, headers=request.headers)
    try:
        with _opener().open(raw, timeout=request.timeout_ms / 1000) as response:
            return RemoteResponse(response.status, response.read())
    except urllib.error.HTTPError as error:
        try:
            error.read()
        finally:
            error.close()
        return RemoteResponse(error.code, b"")


_URI_UNRESERVED = "-_.!~*'()"


def encode_uri_component(value: str) -> str:
    """JavaScript ``encodeURIComponent`` (UTF-8, uppercase hex); lone surrogates raise ``ValueError``."""
    try:
        return urllib.parse.quote(value, safe=_URI_UNRESERVED, encoding="utf-8", errors="strict")
    except UnicodeEncodeError:
        raise ValueError("URI malformed") from None


_FORM_SAFE = frozenset(b"*-._0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz")


def _form_encode(text: str) -> str:
    data = text.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "replace").encode("utf-8")
    return "".join("+" if b == 0x20 else chr(b) if b in _FORM_SAFE else f"%{b:02X}" for b in data)


def _is_index(key: str) -> bool:
    return key.isascii() and key.isdigit() and (key == "0" or not key.startswith("0")) and int(key) < 2**32 - 1


def url_search_params(query: Mapping[str, Any]) -> str:
    """``new URLSearchParams(object).toString()``: JavaScript property order (array indices first)."""
    keys = list(query)
    ordered = sorted((k for k in keys if _is_index(k)), key=int) + [k for k in keys if not _is_index(k)]
    return "&".join(f"{_form_encode(k)}={_form_encode(_js_string(query[k]))}" for k in ordered)


def _js_string(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return value
    return str(value)


_PARAM = re.compile(r":([A-Za-z0-9_]+)")
_PATH_ESCAPE = frozenset(' "#<>?`{}')


def _path_encode(path: str) -> str:
    """The WHATWG path percent-encode set (what the pathname setter escapes)."""
    out = []
    for ch in path:
        if ord(ch) < 0x21 or ord(ch) > 0x7E or ch in _PATH_ESCAPE:
            out.append("".join(f"%{b:02X}" for b in ch.encode("utf-8", "replace")))
        else:
            out.append(ch)
    return "".join(out)


def _forwarder(endpoint: Any, base: _Url, transport: Transport, timeout_ms: int) -> Callable[[Context], Any]:
    def handle(context: Context) -> Any:
        def param(match: re.Match[str]) -> str:
            value = context.params.get(match.group(1))
            if value == "." or value == "..":
                raise HttpError(400, "Invalid route parameter")
            return "undefined" if value is None else encode_uri_component(value)

        path = _PARAM.sub(param, endpoint.path)
        pathname = base.path[:-1] if base.path.endswith("/") else base.path
        url = base.origin + _path_encode(pathname + path)
        search = url_search_params(context.request.query or {})
        if search:
            url += "?" + search
        headers = {"content-type": "application/json"}
        authorization = context.request.headers.get("authorization")
        if authorization:
            headers["authorization"] = authorization
        body = None
        if endpoint.method not in ("GET", "HEAD") and context.request.body is not None:
            body = _js.stringify(context.request.body)
        response = transport(RemoteRequest(url, endpoint.method, headers, body, timeout_ms))
        if not 200 <= response.status <= 299:
            raise HttpError(response.status, "Remote service request failed")
        if response.status == 204:
            return None
        return _js.parse(response.body.decode("utf-8", "replace"))

    return handle


def remote_feature(feature: Any, base_url: str, transport: Transport | None = None, timeout_ms: Any = 10000) -> Any:
    """The same feature with every endpoint forwarded to ``base_url`` (ACL and tool metadata kept).

    Raises ``TypeError("Invalid remote service configuration")`` unless the base is plain HTTPS and
    ``timeout_ms`` is an integer from 1 to 2147483647. There are no retries.
    """
    base = _parse_url(base_url)
    valid_timeout = (
        _js.is_number(timeout_ms)
        and math.isfinite(timeout_ms)
        and float(timeout_ms).is_integer()
        and 1 <= timeout_ms <= 2_147_483_647
    )
    if base.scheme != "https" or base.username or base.password or base.query or base.fragment or not valid_timeout:
        raise TypeError("Invalid remote service configuration")
    send = transport or urllib_transport
    endpoints = [
        dataclasses.replace(endpoint, handle=_forwarder(endpoint, base, send, int(timeout_ms))) for endpoint in _endpoints(feature)
    ]
    changes: dict[str, Any] = {"endpoints": endpoints}
    if any(f.name == "migrations" for f in dataclasses.fields(feature)):
        changes["migrations"] = ()
    return dataclasses.replace(feature, **changes)


__all__ = [
    "Authenticator",
    "SessionAuthenticator",
    "SignedJwtAuthenticator",
    "RemoteJWKSet",
    "remote_jwt_authenticator",
    "MeteredEndpoint",
    "Microservice",
    "RemoteRequest",
    "RemoteResponse",
    "Transport",
    "urllib_transport",
    "encode_uri_component",
    "url_search_params",
    "remote_feature",
]
