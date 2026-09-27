import importlib.util
import unittest
from datetime import datetime, timezone

from rt_app import HttpError
from rt_app.acl import ACL
from rt_app.auth import Auth, AuthVault, LocalMailbox, totp_code, totp_step
from rt_app.contracts import email_address, js_trim, text
from rt_app.jwt import JwtTokens
from rt_app.nosql import MemoryStore
from rt_app.users import Users, hash_password, validate_password, verify_password
from rt_app.web import App, Endpoint, Request

HAS_CRYPTO = importlib.util.find_spec("cryptography") is not None
SECRET = "rt-app-contract-secret-0123456789abcdef"
NOW = datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone.utc)
NOW_MS = 1767323045000
HASH = (
    "scrypt$00112233445566778899aabbccddeeff$57312542235f0bd20de68ba91435932724a28fb139d398248a941a31002a374c"
    "4b90936648d12a0fb3257c32d78b4f18d168bc11152ad26e7a4da912dfeae2d3"
)
REFERENCE_TOKEN = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ2IjoxLCJzdWIiOiJ1c2VyLTEiLCJpc3MiOiJydC1hcHAiLCJhdWQiOiJydC1hcHAtYXBpIiwiaWF0"
    "IjoxNzY3MzIzMDQ1LCJleHAiOjE3NjczMjM5NDV9.cKpp1WKANeBYqmOeu2NSuKbCgBCLFDl69JlwJG3CCfY"
)
BOB_MFA_SEALED = "AAECAwQFBgcICQoLOToKaO5-5QPD1JHvL0I6C9CtDSvDjl7_8wQUWo0PfU1er31KjW6fOXMyqMi2cG3Koxq82AJrCWy_b6BmyA"
TOTP_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"


class Clock:
    def __init__(self, ms: float = NOW_MS) -> None:
        self.ms = ms

    def __call__(self) -> float:
        return self.ms


def user_row(id: str, email: str, **extra: object) -> dict:
    data = {"id": id, "email": email, "name": id, "passwordHash": HASH, "role": "user", "grants": [], "active": True, "tokenVersion": 1}
    return {"pk": "USERS", "sk": id, "version": 1, "data": {**data, **extra}}


def seeded(*rows: dict) -> MemoryStore:
    store = MemoryStore()
    writes = []
    for row in rows:
        writes.append({"row": row, "expected": None})
        if row["pk"] == "USERS":
            writes.append({"row": {"pk": "EMAIL", "sk": row["data"]["email"], "version": 1, "data": {"id": row["sk"]}}, "expected": None})
    store.transact(writes)
    return store


class JwtTests(unittest.TestCase):
    def test_tokens_are_byte_identical_to_the_reference(self):
        tokens = JwtTokens(SECRET, now=Clock(NOW_MS + 999))
        self.assertEqual(tokens.issue({"id": "user-1", "tokenVersion": 1, "role": "owner"}), REFERENCE_TOKEN)
        self.assertEqual(JwtTokens(SECRET, now=lambda: NOW).issue({"id": "user-1", "tokenVersion": 1}), REFERENCE_TOKEN)
        self.assertEqual(tokens.verify(REFERENCE_TOKEN), {"id": "user-1", "version": 1})

    def test_expiry_has_no_leeway_and_future_iat_is_accepted(self):
        clock = Clock()
        tokens = JwtTokens(SECRET, now=clock)
        clock.ms = NOW_MS + 899_999
        self.assertEqual(tokens.verify(REFERENCE_TOKEN)["id"], "user-1")
        clock.ms = NOW_MS + 900_000
        with self.assertRaises(HttpError) as caught:
            tokens.verify(REFERENCE_TOKEN)
        self.assertEqual((caught.exception.status, caught.exception.message), (401, "Invalid or expired session"))
        clock.ms = NOW_MS - 3_600_000  # iat an hour in the future is accepted (jose; PyJWT would reject it)
        self.assertEqual(tokens.verify(REFERENCE_TOKEN)["version"], 1)

    def test_rejections(self):
        tokens = JwtTokens(SECRET, now=Clock())
        head, payload, signature = REFERENCE_TOKEN.split(".")
        for token in [
            "",
            None,
            "Bearer " + REFERENCE_TOKEN,
            f"{head}.{payload}",
            "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0." + payload + ".",
            f"{head}.{payload}.{signature[:-2]}AA",
        ]:
            with self.assertRaises(HttpError, msg=token):
                tokens.verify(token)
        with self.assertRaises(HttpError):
            JwtTokens(SECRET, "other-issuer", now=Clock()).verify(REFERENCE_TOKEN)
        # v must be an integer number: true is not one.
        forged = JwtTokens(SECRET, now=Clock()).issue({"id": "user-1", "tokenVersion": True})
        with self.assertRaises(HttpError):
            tokens.verify(forged)

    def test_secret_needs_32_utf8_bytes(self):
        with self.assertRaisesRegex(ValueError, "JWT_SECRET must contain at least 32 bytes"):
            JwtTokens("é" * 15)
        JwtTokens("😀" * 8)


class ContractsHelperTests(unittest.TestCase):
    def test_javascript_trim_lowercase_and_whitespace(self):
        self.assertEqual(js_trim("\ufeff\u00a0 a \u2003\n"), "a")
        self.assertEqual(js_trim("a\u0085"), "a\u0085")
        self.assertEqual(email_address("  ÁNGEL@EXAMPLE.TEST "), "ángel@example.test")
        self.assertEqual(email_address("İNCI@EXAMPLE.TEST"), "i̇nci@example.test")
        self.assertEqual(email_address("dan\u200b@example.test"), "dan\u200b@example.test")
        for bad in ["carl\u00a0smith@example.test", "carl\u2028smith@example.test", "a@b", "a@@b.c"]:
            with self.assertRaisesRegex(HttpError, "Invalid email"):
                email_address(bad)
        with self.assertRaisesRegex(HttpError, "Invalid field: name"):
            text(" " + "a" * 200, "name")  # 201 UTF-16 units before trimming


class UsersTests(unittest.TestCase):
    def test_password_policy_and_reference_hash(self):
        validate_password("😀" * 6)
        for bad in ["😀" * 5 + "x", "x" * 129, 123456789012, None]:
            with self.assertRaisesRegex(HttpError, "12 to 128"):
                validate_password(bad)
        self.assertTrue(verify_password("correct horse battery", HASH))
        self.assertTrue(verify_password("correct horse battery", HASH[:40] + HASH[40:].upper()))  # hex digest case
        self.assertFalse(verify_password("correct horse battery", HASH[:7] + HASH[7:39].upper() + HASH[39:]))  # salt is text
        self.assertFalse(verify_password("Correct horse battery", HASH))
        self.assertFalse(verify_password(None, HASH))
        self.assertFalse(verify_password("😀" * 65, HASH))
        stored = hash_password("contraseña-😀-segura")
        self.assertRegex(stored, r"^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$")
        self.assertTrue(verify_password("contraseña-😀-segura", stored))

    def test_create_bootstrap_and_profile(self):
        store = MemoryStore()
        users = Users(store, now=Clock())
        owner = users.bootstrap_owner({"email": " Owner@Example.test", "name": " Owner ", "password": "correct horse battery"})
        self.assertEqual(owner["data"]["email"], "owner@example.test")
        self.assertEqual(owner["data"]["role"], "owner")
        self.assertEqual(owner["data"]["createdAt"], "2026-01-02T03:04:05.000Z")
        self.assertEqual(owner["data"]["createdBy"], owner["sk"])
        self.assertEqual(store.get("INSTALLATION", "owner")["data"], {"id": owner["sk"]})
        with self.assertRaisesRegex(HttpError, "already has users"):
            users.bootstrap_owner({"email": "x@example.test", "name": "X", "password": "correct horse battery"})
        with self.assertRaises(HttpError) as caught:
            users.create({"email": "OWNER@example.test", "name": "Y", "password": "correct horse battery"})
        self.assertEqual(caught.exception.status, 409)
        with self.assertRaisesRegex(HttpError, "Invalid email"):
            users.create({"email": "bad", "name": "", "password": "x"})
        view = users.profile(owner["sk"], {"name": " Boss "}, "admin-1")
        self.assertEqual((view["name"], view["updatedBy"], view["restoredAt"]), ("Boss", "admin-1", None))
        self.assertNotIn("passwordHash", view)
        self.assertNotIn("tokenVersion", view)
        with self.assertRaisesRegex(HttpError, "Only name can be edited"):
            users.profile(owner["sk"], {"email": "x@example.test"})


class AclTests(unittest.TestCase):
    RESOURCES = [
        {"resource": "items.read", "method": "GET", "path": "/items", "access": "permission"},
        {"resource": "secret", "method": "POST", "path": "/secret", "access": "owner"},
    ]

    def test_check_fails_closed(self):
        acl = ACL(MemoryStore())
        owner = {"id": "root", "role": "owner", "grants": []}
        with self.assertRaises(HttpError) as caught:
            acl.check({"resource": "x", "access": "admin"}, owner)
        self.assertEqual(caught.exception.status, 403)
        with self.assertRaisesRegex(HttpError, "Sign in"):
            acl.check(Endpoint("GET", "/x", "x", "authenticated", lambda c: None), None)
        acl.check(Endpoint("GET", "/x", "x", "permission", lambda c: None), owner)
        with self.assertRaises(HttpError):
            acl.check(Endpoint("GET", "/x", "x", "permission", lambda c: None, explicit_grant=True), owner)

    def test_assign_and_resources(self):
        store = seeded(user_row("alice", "alice@example.test"))
        acl = ACL(store, lambda: self.RESOURCES, now=Clock())
        owner = {"id": "root", "role": "owner", "grants": []}
        view = acl.assign("alice", {"role": "admin", "grants": ["items.read", "items.read"]}, owner)
        self.assertEqual((view["role"], view["grants"], view["updatedAt"]), ("admin", ["items.read"], "2026-01-02T03:04:05.000Z"))
        self.assertEqual(store.get("USERS", "alice")["data"]["tokenVersion"], 2)
        with self.assertRaisesRegex(HttpError, "Invalid permissions or role"):
            acl.assign("alice", {"role": "user", "grants": ["secret"]}, owner)
        self.assertEqual(acl.list_resources({"access": "OWN"}), [self.RESOURCES[1]])
        with self.assertRaisesRegex(HttpError, "Unsupported filter: role"):
            acl.list_resources({"role": "x"})


class TotpTests(unittest.TestCase):
    def test_rfc6238_vectors_and_drift(self):
        self.assertEqual(totp_code(TOTP_SECRET, 1), "287082")
        self.assertEqual(totp_code(TOTP_SECRET, 37037036), "081804")
        self.assertEqual(totp_code(TOTP_SECRET, 58910768), "652348")
        now = 58910768 * 30000
        self.assertEqual(totp_step(TOTP_SECRET, "751330", -1, now), 58910769)
        self.assertIsNone(totp_step(TOTP_SECRET, "751330", 58910769, now))
        self.assertIsNone(totp_step(TOTP_SECRET, "６５２３４８", -1, now))


@unittest.skipUnless(HAS_CRYPTO, "cryptography is not installed")
class AuthTests(unittest.TestCase):
    def make(self, *rows: dict):
        self.clock = Clock()
        self.store = seeded(*rows)
        self.mailbox = LocalMailbox()
        users = Users(self.store, now=self.clock)
        return Auth(users, JwtTokens(SECRET, now=self.clock), self.mailbox, SECRET, now=self.clock)

    def test_vault_matches_the_reference_format(self):
        vault = AuthVault(SECRET)
        self.assertEqual(vault.open(BOB_MFA_SEALED), {"secret": TOTP_SECRET})
        self.assertEqual(vault.seal({}, bytes(range(11, -1, -1))), "CwoJCAcGBQQDAgEABVssCWTvS22ukbO0Zn4B3ort")
        self.assertEqual(vault.open(vault.seal({"a": "ñ"})), {"a": "ñ"})
        with self.assertRaises(Exception):
            AuthVault("another secret with enough bytes!!").open(BOB_MFA_SEALED)

    def test_login_session_actor_and_rate_limits(self):
        auth = self.make(user_row("u-alice", "alice@example.test"))
        session = auth.login("alice@example.test", "correct horse battery", "1.1.1.1")
        self.assertEqual(session["expiresIn"], 900)
        self.assertEqual(auth.actor("Bearer " + session["token"])["id"], "u-alice")
        self.assertIsNone(auth.actor(None))
        with self.assertRaisesRegex(HttpError, "Invalid token"):
            auth.actor("bearer " + session["token"])
        with self.assertRaisesRegex(HttpError, "Incorrect email or password"):
            auth.login("alice@example.test", "wrong password 123", "1.1.1.1")
        rate = self.store.get("RATE", "997006e472b1a08e8093fae9240c2d24f49e984e5144f8339382975d5d5e5e36")
        self.assertEqual((rate["data"], rate["ttl"]), ({"count": 2}, 1767323165))
        for _ in range(6):
            auth.limit("login:alice@example.test", 8)
        with self.assertRaises(HttpError) as caught:
            auth.login("alice@example.test", "correct horse battery", "1.1.1.1")
        self.assertEqual(caught.exception.status, 429)
        self.clock.ms = NOW_MS + 55_000  # 03:05:00 opens a new window
        auth.limit("login:alice@example.test", 8)

    def test_email_code_login_and_reset(self):
        auth = self.make(user_row("u-alice", "alice@example.test"))
        self.assertEqual(auth.issue("alice@example.test", "login", "1.1.1.1")["message"], "If the account supports this method, you will receive a code.")
        code = self.mailbox.messages[0]["code"]
        self.assertRegex(code, r"^[1-9][0-9]{5}$")
        with self.assertRaisesRegex(HttpError, "Invalid code"):
            auth.consume("alice@example.test", "１２３４５６", "login", "1.1.1.1")
        wrong = "000000" if code != "000000" else "111111"
        with self.assertRaisesRegex(HttpError, "Invalid or expired code"):
            auth.consume("alice@example.test", wrong, "login", "1.1.1.1")
        self.assertEqual(auth.consume("alice@example.test", code, "login", "1.1.1.1")["user"]["id"], "u-alice")
        auth.issue("alice@example.test", "reset", "1.1.1.1")
        reset = self.mailbox.messages[0]["code"]
        auth.consume("alice@example.test", reset, "reset", "1.1.1.1", "a brand new password")
        self.assertEqual(self.store.get("USERS", "u-alice")["data"]["tokenVersion"], 2)
        auth.login("alice@example.test", "a brand new password", "1.1.1.1")

    def test_mfa_enrollment_and_sign_in(self):
        auth = self.make(user_row("u-alice", "alice@example.test"))
        setup = auth.setup_mfa("u-alice", "correct horse battery", "1.1.1.1")
        self.assertRegex(setup["uri"], r"^otpauth://totp/RT-APP:alice%40example\.test\?secret=[A-Z2-7]{32}&issuer=RT-APP")
        code = totp_code(setup["secret"], NOW_MS // 30000)
        self.assertTrue(auth.enable_mfa("u-alice", setup["challengeId"], code, "1.1.1.1")["reauthenticate"])
        self.assertTrue(auth.has_mfa("u-alice"))
        pending = auth.login("alice@example.test", "correct horse battery", "1.1.1.1")
        self.assertEqual(pending["challenge"], "totp")
        with self.assertRaisesRegex(HttpError, "Invalid or previously used code"):
            auth.verify_mfa(pending["challengeId"], code, "1.1.1.1")
        self.clock.ms += 30_000
        session = auth.verify_mfa(pending["challengeId"], totp_code(setup["secret"], NOW_MS // 30000 + 1), "1.1.1.1")
        self.assertEqual(session["user"]["id"], "u-alice")
        with self.assertRaisesRegex(HttpError, "Password sign-in is required"):
            auth.update_settings({"version": 0, "values": {"passwordLogin": False, "emailCodeLogin": True}})
        auth.reset_mfa("u-alice")
        self.assertFalse(auth.has_mfa("u-alice"))

    def test_email_change(self):
        auth = self.make(user_row("u-alice", "alice@example.test"))
        auth.request_email_change("u-alice", "new@example.test", "1.1.1.1")
        message = self.mailbox.messages[0]
        self.assertEqual((message["email"], message["purpose"]), ("new@example.test", "email-change"))
        session = auth.confirm_email_change("u-alice", message["code"], "1.1.1.1")
        self.assertEqual(session["user"]["email"], "new@example.test")
        self.assertIsNone(self.store.get("EMAIL", "alice@example.test"))
        self.assertEqual(self.store.get("EMAIL", "new@example.test")["data"], {"id": "u-alice"})


@unittest.skipUnless(HAS_CRYPTO, "cryptography is not installed")
class IdentityAppTests(unittest.TestCase):
    """users/acl/auth features mounted in a web App with Auth as the authenticator."""

    def setUp(self):
        self.store = seeded(
            user_row("u-owner", "owner@example.test", role="owner"),
            user_row("u-alice", "alice@example.test"),
        )
        users = Users(self.store)
        self.auth = Auth(users, JwtTokens(SECRET), LocalMailbox(), SECRET)
        acl = ACL(self.store, lambda: self.app.endpoints)
        self.app = App([users.feature(), acl.feature(), self.auth.feature()], authenticate=self.auth.actor_from_request, acl=acl)

    def call(self, method, path, body=None, token=None):
        headers = {"authorization": f"Bearer {token}"} if token else {}
        response = self.app.handle(Request(method=method, path=path, body=body or {}, headers=headers, ip="1.1.1.1"))
        return response.status, response.body

    def login(self, email):
        status, body = self.call("POST", "/auth/login", {"email": email.upper(), "password": "correct horse battery"})
        self.assertEqual(status, 200, body)
        return body["token"]

    def test_paths_access_and_sessions(self):
        alice, owner = self.login("alice@example.test"), self.login("owner@example.test")
        self.assertEqual(self.call("GET", "/users/me", token=alice)[1]["email"], "alice@example.test")
        self.assertEqual(self.call("GET", "/users/me"), (401, {"error": "Sign in"}))
        self.assertEqual(self.call("GET", "/users/me", token="garbage"), (401, {"error": "Invalid or expired session"}))
        self.assertEqual(self.call("GET", "/users", token=alice)[0], 403)
        self.assertEqual(self.call("GET", "/admin/app/users", token=owner)[0], 401)  # /admin/app is for the admin root
        self.assertEqual(self.call("GET", "/users", token=owner)[0], 200)  # permission routes: plain path and /admin/app
        listed = self.call("GET", "/users", token=owner)[1]
        self.assertEqual(sorted(u["id"] for u in listed["items"]), ["u-alice", "u-owner"])
        resources = self.call("GET", "/acl/resources", token=owner)[1]
        self.assertIn({"resource": "users.list", "method": "GET", "path": "/admin/app/users", "access": "permission"}, resources)
        status, view = self.call("PUT", "/acl/users/u-alice", {"role": "user", "grants": ["users.list"]}, owner)
        self.assertEqual((status, view["grants"]), (200, ["users.list"]))
        self.assertEqual(self.call("GET", "/users", token=alice), (401, {"error": "Invalid session"}))  # revoked
        alice = self.login("alice@example.test")
        self.assertEqual(self.call("GET", "/users", token=alice)[0], 200)
        self.assertEqual(self.call("GET", "/auth/methods")[1]["provider"], "local")
        self.assertEqual(self.call("POST", "/auth/logout", token=alice), (200, {"ok": True}))
        self.assertEqual(self.call("GET", "/users/me", token=alice)[0], 401)
        self.assertEqual(self.call("POST", "/auth/login", {"email": "nope", "password": "x"}), (400, {"error": "Invalid email"}))


if __name__ == "__main__":
    unittest.main()
