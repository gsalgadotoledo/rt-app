"""rt_app.microservices: hosting, authenticators and forwarding (TypeScript semantics)."""
from __future__ import annotations

import base64
import json
import logging
import re
import time
import unittest
from dataclasses import dataclass
from typing import Any

from rt_app.errors import HttpError
from rt_app.jwt import JwtTokens
from rt_app.microservices import (
    MeteredEndpoint,
    Microservice,
    RemoteJWKSet,
    RemoteRequest,
    RemoteResponse,
    SessionAuthenticator,
    SignedJwtAuthenticator,
    encode_uri_component,
    remote_feature,
    remote_jwt_authenticator,
    url_search_params,
)
from rt_app.web import Context, Endpoint, Feature, Request

try:
    import cryptography  # noqa: F401

    HAS_CRYPTO = True
except ImportError:  # pragma: no cover
    HAS_CRYPTO = False

UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
ACTOR = {"id": "u", "role": "user", "grants": ["x.read"], "active": True, "tokenVersion": 1}


def echo(context: Context) -> Any:
    return {"params": context.params, "actor": context.actor, "headers": context.request.headers}


class Table:
    def __init__(self, tokens: dict[str, Any]) -> None:
        self.tokens, self.seen = tokens, []

    def authenticate(self, token: str) -> Any:
        self.seen.append(token)
        if token not in self.tokens:
            raise HttpError(401, "Unknown token")
        return self.tokens[token]


def request(path: str, authorization: str | None = None, method: str = "GET") -> Request:
    return Request(method=method, path=path, headers={} if authorization is None else {"authorization": authorization})


class HostingTest(unittest.TestCase):
    def setUp(self) -> None:
        logging.disable(logging.CRITICAL)
        self.metrics: list[dict[str, Any]] = []
        self.table = Table({"good": ACTOR, "boss": {**ACTOR, "id": "o", "role": "owner", "grants": []}})
        self.service = Microservice(
            [Feature("x", [Endpoint("GET", "/x/:id", "x.read", "permission", echo)])],
            self.table,
            observe=self.metrics.append,
        )

    def tearDown(self) -> None:
        logging.disable(logging.NOTSET)

    def test_hosts_with_actor_and_request_id(self) -> None:
        r = self.service.handle(request("/x/42", "Bearer good"))
        self.assertEqual(r.status, 200)
        request_id = dict(r.headers or [])["x-request-id"]
        self.assertRegex(request_id, UUID)
        self.assertEqual(r.body["params"], {"id": "42"})
        self.assertEqual(r.body["actor"], ACTOR)
        self.assertEqual(r.body["headers"]["x-request-id"], request_id)
        self.assertEqual(self.metrics[-1]["requestId"], request_id)
        self.assertEqual(self.metrics[-1]["route"], "/x/:id")
        self.assertIsInstance(self.metrics[-1]["durationMs"], float)

    def test_routing(self) -> None:
        self.assertEqual(self.service.handle(request("/x/1/", "Bearer good")).status, 200)
        for path in ("/no", "/x/", "/x/1//", "/x/1/2"):
            self.assertEqual(self.service.handle(request(path, "Bearer good")).status, 404)
        self.assertEqual(self.service.handle(request("/x/1", "Bearer good", "get")).status, 404)
        self.assertEqual(self.metrics[-1]["route"], "/unmatched")
        with self.assertRaisesRegex(TypeError, "Duplicate service route"):
            Microservice([Feature("a", [Endpoint("GET", "/a", "a", "guest", echo)] * 2)], self.table)
        first = Microservice(
            [Feature("u", [Endpoint("GET", "/u/:id", "u", "guest", echo), Endpoint("GET", "/u/me", "u", "guest", lambda c: "me")])],
            self.table,
        )
        self.assertEqual(first.handle(request("/u/me")).body["params"], {"id": "me"})
        literal = Microservice([Feature("f", [Endpoint("GET", "/f/a.b", "f", "guest", lambda c: 1)])], self.table)
        self.assertEqual(literal.handle(request("/f/aXb")).status, 404)

    def test_authorization_header(self) -> None:
        for header in ("Basic good", "Bearer good extra", "Bearer  good", "Bearer\tgood", "Bearer good ", "Bearer good\n", "Bearer ", "Bearer"):
            r = self.service.handle(request("/x/1", header))
            self.assertEqual((r.status, r.body), (401, {"error": "Invalid authorization"}), header)
        self.assertEqual(self.table.seen, [])
        self.assertEqual(self.service.handle(request("/x/1", "bEARER good")).status, 200)
        self.assertEqual(self.service.handle(request("/x/1", "Bearer go​od")).body, {"error": "Unknown token"})
        self.assertEqual(self.service.handle(request("/x/1", "")).body, {"error": "Sign in"})

    def test_access_rules(self) -> None:
        def run(access: str, actor: Any, explicit: bool = False, resource: str = "x.read") -> int:
            service = Microservice([Feature("x", [Endpoint("GET", "/e", resource, access, lambda c: 1, explicit_grant=explicit)])], Table({"t": actor}))
            return service.handle(request("/e", "Bearer t")).status

        owner = {**ACTOR, "role": "owner", "grants": []}
        self.assertEqual(run("permission", ACTOR), 200)
        self.assertEqual(run("permission", ACTOR, resource="x.write"), 403)
        self.assertEqual(run("permission", owner, resource="x.write"), 200)
        self.assertEqual(run("permission", owner, explicit=True), 403)
        self.assertEqual(run("owner", ACTOR), 403)
        self.assertEqual(run("owner", owner), 200)
        self.assertEqual(run("admin", ACTOR), 200)
        self.assertEqual(run("authenticated", {**ACTOR, "active": False}), 401)
        self.assertEqual(run("guest", {**ACTOR, "active": False}), 200)

    def test_parameters_are_decoded_like_javascript(self) -> None:
        service = Microservice([Feature("g", [Endpoint("GET", "/g/:id", "g", "guest", echo)])], self.table)
        self.assertEqual(service.handle(request("/g/a%2Fb%20%C3%A9+%F0%9F%98%80")).body["params"], {"id": "a/b é+😀"})
        for bad in ("%zz", "%", "%E0", "%C0%AF", "%ED%A0%80", "%F4%90%80%80"):
            self.assertEqual(service.handle(request("/g/" + bad)).body, {"error": "Invalid route encoding"}, bad)
        # Access is checked before decoding.
        self.assertEqual(self.service.handle(request("/x/%E0")).status, 401)

    def test_errors_metering_and_telemetry(self) -> None:
        def boom(context: Context) -> Any:
            raise RuntimeError("secret")

        metered: list[Any] = []

        def invoke(endpoint: Any, actor: Any, work: Any) -> Any:
            metered.append(endpoint.resource)
            return work()

        def fail(metric: Any) -> None:
            raise RuntimeError("telemetry down")

        endpoints = [
            Endpoint("GET", "/boom", "b", "guest", boom),
            Endpoint("GET", "/teapot", "b", "guest", lambda c: (_ for _ in ()).throw(HttpError(418, "short"))),
            MeteredEndpoint("GET", "/m", "m", "guest", lambda c: "done", subscription={}),
        ]
        closed = Microservice([Feature("b", endpoints)], self.table, observe=fail)
        self.assertEqual(closed.handle(request("/boom")).body, {"error": "Internal error"})
        self.assertEqual(closed.handle(request("/teapot")).status, 418)
        self.assertEqual(closed.handle(request("/m")).body, {"error": "Metering adapter required"})
        open_ = Microservice([Feature("b", endpoints)], self.table, invoke_metered=invoke)
        self.assertEqual(open_.handle(request("/m")).body, "done")
        self.assertEqual(metered, ["m"])


class SessionTest(unittest.TestCase):
    def test_session_tokens(self) -> None:
        now = [1790244000000]
        tokens = JwtTokens("s" * 32, now=lambda: now[0])
        actors = {"u": ACTOR, "off": {**ACTOR, "id": "off", "active": False}, "v2": {**ACTOR, "id": "v2", "tokenVersion": 2}}
        auth = SessionAuthenticator(tokens, actors.get)
        self.assertEqual(auth.authenticate(tokens.issue({"id": "u", "tokenVersion": 1})), ACTOR)
        for user in ("off", "v2", "ghost"):
            with self.assertRaises(HttpError) as caught:
                auth.authenticate(tokens.issue({"id": user, "tokenVersion": 1}))
            self.assertEqual(caught.exception.message, "Invalid or revoked session")
        token = tokens.issue({"id": "u", "tokenVersion": 1})
        now[0] += 900_000
        with self.assertRaisesRegex(HttpError, "Invalid or expired session"):
            auth.authenticate(token)
        # true is not the version 1.
        bool_auth = SessionAuthenticator(tokens, lambda id: {**ACTOR, "tokenVersion": True})
        now[0] -= 900_000
        with self.assertRaises(HttpError):
            bool_auth.authenticate(token)


def b64(data: bytes | str | Any) -> str:
    raw = data if isinstance(data, bytes) else (data if isinstance(data, str) else json.dumps(data, separators=(",", ":"))).encode()
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


@unittest.skipUnless(HAS_CRYPTO, "cryptography is not installed")
class SignedJwtTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        from cryptography.hazmat.primitives.asymmetric import ec, rsa

        cls.rsa = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        cls.ec = ec.generate_private_key(ec.SECP256R1())

    def jwk(self, key: Any, **extra: Any) -> dict[str, Any]:
        numbers = key.public_key().public_numbers()
        if hasattr(numbers, "n"):
            to = lambda n: b64(n.to_bytes((n.bit_length() + 7) // 8, "big"))  # noqa: E731
            return {"kty": "RSA", "n": to(numbers.n), "e": to(numbers.e), **extra}
        return {"kty": "EC", "crv": "P-256", "x": b64(numbers.x.to_bytes(32, "big")), "y": b64(numbers.y.to_bytes(32, "big")), **extra}

    def token(self, payload: Any, header: dict[str, Any] | None = None, key: Any = None) -> str:
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import ec, padding, utils

        header = header or {"alg": "RS256", "kid": "rsa"}
        signing_input = f"{b64(header)}.{b64(payload)}".encode()
        key = key or (self.rsa if header["alg"] == "RS256" else self.ec)
        if header["alg"] == "RS256":
            signature = key.sign(signing_input, padding.PKCS1v15(), hashes.SHA256())
        else:
            r, s = utils.decode_dss_signature(key.sign(signing_input, ec.ECDSA(hashes.SHA256())))
            signature = r.to_bytes(32, "big") + s.to_bytes(32, "big")
        return f"{signing_input.decode()}.{b64(signature)}"

    def setUp(self) -> None:
        self.jwks = {"keys": [self.jwk(self.rsa, kid="rsa", alg="RS256", use="sig"), self.jwk(self.ec, kid="ec")]}
        self.actors = {"svc": {"id": "svc", "role": "user", "grants": [], "active": True}}
        self.auth = SignedJwtAuthenticator(self.jwks, "issuer", "service", lambda c: self.actors.get(c["sub"]), now=lambda: 1_800_000_000)
        self.base = {"sub": "svc", "iss": "issuer", "aud": "service", "iat": 1_790_000_000, "exp": 1_900_000_000}

    def assertInvalid(self, token: str) -> None:
        with self.assertRaises(HttpError) as caught:
            self.auth.authenticate(token)
        self.assertEqual((caught.exception.status, caught.exception.message), (401, "Invalid service JWT"))

    def test_accepts_rs256_and_es256(self) -> None:
        self.assertEqual(self.auth.authenticate(self.token(self.base))["id"], "svc")
        self.assertEqual(self.auth.authenticate(self.token(self.base, {"alg": "ES256", "kid": "ec"}))["id"], "svc")
        self.assertEqual(self.auth.authenticate(self.token(self.base, {"alg": "ES256"}))["id"], "svc")
        self.assertEqual(self.auth.authenticate(self.token({**self.base, "aud": ["x", "service"], "iat": 2_000_000_000}))["id"], "svc")

    def test_rejects_claims(self) -> None:
        for change in ({"aud": "x"}, {"iss": "x"}, {"exp": 1_800_000_000}, {"nbf": 1_800_000_001}, {"iat": "1"}, {"exp": True}):
            self.assertInvalid(self.token({**self.base, **change}))
        for claim in ("exp", "iat", "sub", "iss", "aud"):
            self.assertInvalid(self.token({k: v for k, v in self.base.items() if k != claim}))
        self.assertInvalid(self.token([1]))

    def test_rejects_headers_and_keys(self) -> None:
        good = self.token(self.base)
        head, payload, signature = good.split(".")
        self.assertInvalid(f"{head}.{b64({**self.base, 'sub': 'admin'})}.{signature}")
        self.assertInvalid(f"{head}.{payload}")
        self.assertInvalid(self.token(self.base, {"alg": "RS256", "kid": "nope"}))
        self.assertInvalid(self.token(self.base, {"alg": "RS256", "kid": "rsa", "crit": ["exp"], "exp": 1}))
        self.assertInvalid(self.token(self.base, {"alg": "RS256", "kid": "rsa", "crit": ["b64"], "b64": False}))
        self.assertEqual(self.auth.authenticate(self.token(self.base, {"alg": "RS256", "kid": "rsa", "crit": ["b64"], "b64": True}))["id"], "svc")
        self.assertInvalid(self.token(self.base, {"alg": "ES256", "kid": "rsa"}, key=self.ec))
        with_private = {"keys": [{**self.jwk(self.rsa), "d": "AA"}]}
        auth = SignedJwtAuthenticator(with_private, "issuer", "service", lambda c: None, now=lambda: 1_800_000_000)
        with self.assertRaises(HttpError):
            auth.authenticate(self.token(self.base, {"alg": "RS256"}))

    def test_resolver_rules(self) -> None:
        self.actors["5"] = {"id": "5", "active": True}
        self.actors["off"] = {"id": "off", "active": False}
        for sub in (5, "off", "ghost"):
            token = self.token({**self.base, "sub": sub})
            auth = SignedJwtAuthenticator(self.jwks, "issuer", "service", lambda c: self.actors.get(str(c["sub"])), now=lambda: 1_800_000_000)
            with self.assertRaisesRegex(HttpError, "Inactive service identity"):
                auth.authenticate(token)

    def test_configuration(self) -> None:
        with self.assertRaisesRegex(TypeError, "JWT issuer and audience required"):
            SignedJwtAuthenticator(self.jwks, "", "service", lambda c: None)
        with self.assertRaisesRegex(TypeError, "JSON Web Key Set malformed"):
            SignedJwtAuthenticator({"keys": [1]}, "i", "a", lambda c: None)
        for url in ("http://x/jwks", "https://u@x/jwks", "https://:p@x/jwks", "file:///jwks"):
            with self.assertRaisesRegex(TypeError, "JWKS requires HTTPS"):
                remote_jwt_authenticator(url, "i", "a", lambda c: None)
        with self.assertRaisesRegex(TypeError, "Invalid URL"):
            remote_jwt_authenticator("not a url", "i", "a", lambda c: None)

    def test_remote_jwks_cache_and_refetch(self) -> None:
        calls: list[str] = []
        sets = [{"keys": [self.jwk(self.ec, kid="old")]}, {"keys": [self.jwk(self.rsa, kid="rsa")]}]
        clock = [0.0]

        def fetch(url: str) -> Any:
            calls.append(url)
            return sets[min(len(calls), len(sets)) - 1]

        keys = RemoteJWKSet("https://x/jwks", fetch=fetch, clock=lambda: clock[0])
        auth = SignedJwtAuthenticator(keys, "issuer", "service", lambda c: self.actors.get(c["sub"]), now=lambda: 1_800_000_000)
        token = self.token(self.base)
        with self.assertRaises(HttpError):  # no match, but within the 30 s cooldown
            auth.authenticate(token)
        clock[0] = 31
        self.assertEqual(auth.authenticate(token)["id"], "svc")
        self.assertEqual(auth.authenticate(token)["id"], "svc")
        self.assertEqual(len(calls), 2)
        clock[0] = 31 + 600
        auth.authenticate(token)
        self.assertEqual(len(calls), 3)


@dataclass(frozen=True)
class _Feature:
    id: str
    endpoints: Any
    migrations: Any = ()


class RemoteFeatureTest(unittest.TestCase):
    def setUp(self) -> None:
        self.sent: list[RemoteRequest] = []
        self.answers: list[RemoteResponse] = []

    def transport(self, request: RemoteRequest) -> RemoteResponse:
        self.sent.append(request)
        return self.answers.pop(0)

    def remote(self, path: str = "/x/:id", method: str = "GET", base: str = "https://example.test/api") -> Any:
        feature = _Feature("x", [Endpoint(method, path, "x.read", "permission", echo, explicit_grant=True)], migrations=("m",))
        return remote_feature(feature, base, self.transport)

    def call(self, feature: Any, params: dict[str, str], **request: Any) -> Any:
        return feature.endpoints[0].handle(Context(request=Request(method="GET", path="/", **request), params=params))

    def test_url_headers_and_metadata(self) -> None:
        feature = self.remote()
        self.assertEqual(feature.migrations, ())
        self.assertTrue(feature.endpoints[0].explicit_grant)
        self.answers.append(RemoteResponse(200, b'{"ok":true}'))
        self.assertEqual(self.call(feature, {"id": "a/b"}, headers={"authorization": "Bearer t", "x-user-id": "evil"}, body={"a": 1}), {"ok": True})
        sent = self.sent[0]
        self.assertEqual(sent.url, "https://example.test/api/x/a%2Fb")
        self.assertEqual(sent.headers, {"content-type": "application/json", "authorization": "Bearer t"})
        self.assertIsNone(sent.body)
        self.assertEqual((sent.redirect, sent.timeout_ms), ("error", 10000))

    def test_encoding(self) -> None:
        self.assertEqual(encode_uri_component("a b?é~!*()'"), "a%20b%3F%C3%A9~!*()'")
        self.assertEqual(url_search_params({"a b": "x y~*!()'é ", "z": "", "&": "=", "10": "a", "2": "b"}), "2=b&10=a&a+b=x+y%7E*%21%28%29%27%C3%A9%E2%80%A8&z=&%26=%3D")
        feature = self.remote("/y/:id/:name_2.json", base="HTTPS://EXAMPLE.test:443/api/")
        self.answers += [RemoteResponse(200, b"1"), RemoteResponse(204)]
        self.assertEqual(self.call(feature, {"id": "1"}, query={"q": "a b"}), 1)
        self.assertEqual(self.sent[0].url, "https://example.test/api/y/1/undefined.json?q=a+b")
        for value in (".", ".."):
            with self.assertRaisesRegex(HttpError, "Invalid route parameter"):
                self.call(feature, {"id": value, "name_2": "x"})
        self.assertIsNone(self.call(feature, {"id": "...", "name_2": "x."}))
        self.assertEqual(self.sent[-1].url, "https://example.test/api/y/.../x..json")

    def test_bodies_and_errors(self) -> None:
        feature = self.remote(method="POST", base="https://example.test")
        self.answers += [RemoteResponse(201, b'{"id":"7"}'), RemoteResponse(503, b"secret"), RemoteResponse(200, b"not json")]
        self.assertEqual(self.call(feature, {"id": "7"}, body={"b": "x</y>", "a": [1, 1.5, 1e21]}), {"id": "7"})
        self.assertEqual(self.sent[0].body, '{"b":"x</y>","a":[1,1.5,1e+21]}')
        with self.assertRaises(HttpError) as caught:
            self.call(feature, {"id": "7"})
        self.assertEqual((caught.exception.status, caught.exception.message), (503, "Remote service request failed"))
        with self.assertRaises(ValueError):
            self.call(feature, {"id": "7"})

    def test_configuration(self) -> None:
        feature = _Feature("x", [])
        for base in ("http://x", "https://u:p@x", "https://u@x", "https://x/?a=1", "https://x/#f"):
            with self.assertRaisesRegex(TypeError, "Invalid remote service configuration"):
                remote_feature(feature, base)
        for timeout in (0, 1.5, 2**31, float("nan"), float("inf"), True):
            with self.assertRaisesRegex(TypeError, "Invalid remote service configuration"):
                remote_feature(feature, "https://x", timeout_ms=timeout)
        with self.assertRaisesRegex(TypeError, "Invalid URL"):
            remote_feature(feature, "example.test")
        self.assertIsNotNone(remote_feature(feature, "https://x/?", timeout_ms=2**31 - 1))


if __name__ == "__main__":
    unittest.main()
