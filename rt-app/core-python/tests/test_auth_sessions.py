"""Refresh sessions (port of packages/auth/tests/sessions.test.mjs plus interop and HTTP checks)."""
import hashlib
import hmac
import json
import unittest

from rt_app import HttpError
from rt_app.auth import Auth, LocalMailbox
from rt_app.auth_sessions import (
    SESSION_TTL_MS,
    RefreshSessions,
    client_text,
    parse_refresh_token,
    rate_limit,
    session_partition,
)
from rt_app.errors import Conflict
from rt_app.jwt import JwtTokens
from rt_app.nosql import MemoryStore
from rt_app.users import Users
from rt_app.web import App, Request

SECRET = "rt-app-contract-secret-0123456789abcdef"
PASSWORD = "Test-password-only-2026!"
NOW_MS = 1767323045000  # 2026-01-02T03:04:05.000Z
# sessionAlice0000000001 as the contracts pin it (written by another implementation).
POINTER = {"pk": "SESSION", "sk": "sessionAlice0000000001", "version": 1, "ttl": 1767582245, "data": {"userId": "u-alice"}}
FIXTURE = {
    "pk": "SESSIONS#u-alice", "sk": "sessionAlice0000000001", "version": 1, "ttl": 1767582245,
    "data": {
        "userId": "u-alice", "provider": "local", "tokenVersion": 1,
        "secretHash": "a22213d5d1f5f0bd41f7e78cf05c48a7e27ce66e70ab217f512b2e3fb4bfe731",
        "previousHash": "6739169ea1e7c1816f255b48ae4accaebd9dd6e9551cabd56e505dbd9f5edb2e",
        "rotatedAt": 1767322985000, "createdAt": 1767236645000, "lastUsedAt": 1767322985000, "expiresAt": 1767582245000,
        "revokedAt": None, "revokedReason": None, "ip": "1.1.1.1", "userAgent": "Fixture/1.0",
    },
}
# The access token another implementation issues for that session at NOW_MS.
FIXTURE_ACCESS = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ2IjoxLCJzaWQiOiJzZXNzaW9uQWxpY2UwMDAwMDAwMDAxIiwic3ViIjoidS1hbGljZSIsImlzcyI6"
    "InJ0LWFwcCIsImF1ZCI6InJ0LWFwcC1hcGkiLCJpYXQiOjE3NjczMjMwNDUsImV4cCI6MTc2NzMyMzk0NX0.A20bgnWNo87GH8r5t-WoKPBlTeqIN481pyFQBodvNQE"
)


class Clock:
    def __init__(self, ms: int = NOW_MS) -> None:
        self.ms = ms

    def __call__(self) -> int:
        return self.ms


def bearer(token: str) -> str:
    return "Bearer " + token


def setup(provider=None, **options):
    clock = Clock()
    store = MemoryStore()
    users = Users(store, now=clock)
    auth = Auth(users, JwtTokens(SECRET, now=clock), LocalMailbox(), SECRET, provider, now=clock, **options)
    user = users.create({"name": "Test", "email": "test@example.test", "password": PASSWORD})
    if provider:
        store.transact([{"row": {**user, "version": user["version"] + 1, "data": {**user["data"], "credentialProvider": provider.id}}, "expected": user["version"]}])
    return store, auth, user, clock


class HelperTests(unittest.TestCase):
    def test_client_details_and_token_format(self):
        self.assertEqual(client_text("Mozilla/5.0 ü\u0007", 200), "Mozilla/5.0 ")
        self.assertIsNone(client_text("ééé", 10))
        self.assertIsNone(client_text(5, 10))
        self.assertIsNone(client_text(None, 10))
        self.assertEqual(len(client_text("a" * 300, 200)), 200)
        self.assertEqual(parse_refresh_token("A" * 22 + "." + "b" * 43), ("A" * 22, "b" * 43))
        for bad in (None, 42, "", "x.y", "A" * 22 + "." + "b" * 42, "A" * 22 + "." + "b" * 43 + "=", "A" * 23 + "." + "b" * 43,
                    "A" * 22 + "." + "b" * 43 + "\n", "A" * 22 + "." + "b" * 42 + "+"):
            self.assertIsNone(parse_refresh_token(bad), bad)
        self.assertEqual(SESSION_TTL_MS, 345600000)

    def test_jwt_sid_claim(self):
        tokens = JwtTokens(SECRET, now=Clock())
        pinned = tokens.issue({"id": "u-alice", "tokenVersion": 1, "sid": "sessionAlice0000000001"})
        self.assertEqual(pinned, FIXTURE_ACCESS)
        self.assertEqual(tokens.verify(pinned), {"id": "u-alice", "version": 1, "sid": "sessionAlice0000000001"})
        plain = tokens.issue({"id": "u-alice", "tokenVersion": 1})
        for sid in ("", None, 7):
            self.assertEqual(tokens.issue({"id": "u-alice", "tokenVersion": 1, "sid": sid}), plain)
        self.assertEqual(tokens.verify(plain), {"id": "u-alice", "version": 1})
        # sid 7, "" and null as claims (signed by the reference) are rejected.
        for token in (
            "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ2IjoxLCJzaWQiOjcsInN1YiI6InVzZXItMSIsImlzcyI6InJ0LWFwcCIsImF1ZCI6InJ0LWFwcC1hcGkiLCJpYXQiOjE3NjczMjMwNDUsImV4cCI6MTc2NzMyMzk0NX0.xbIUwMtAP1WxrxZPivaAl_BUWvzAPa4IFf-QMeVCRMc",
            "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ2IjoxLCJzaWQiOiIiLCJzdWIiOiJ1c2VyLTEiLCJpc3MiOiJydC1hcHAiLCJhdWQiOiJydC1hcHAtYXBpIiwiaWF0IjoxNzY3MzIzMDQ1LCJleHAiOjE3NjczMjM5NDV9.Fd1ruPb77Y7Y15AH1KCPo8nLvSSRTX0QZejejnAyWTY",
            "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ2IjoxLCJzaWQiOm51bGwsInN1YiI6InVzZXItMSIsImlzcyI6InJ0LWFwcCIsImF1ZCI6InJ0LWFwcC1hcGkiLCJpYXQiOjE3NjczMjMwNDUsImV4cCI6MTc2NzMyMzk0NX0.0vSxIDvxoevMJrRk2Y9jCgcw1qZFsaWGtFKbhjvDfo8",
        ):
            with self.assertRaises(HttpError) as caught:
                tokens.verify(token)
            self.assertEqual((caught.exception.status, caught.exception.message), (401, "Invalid or expired session"))

    def test_hash_is_the_shared_hmac(self):
        sessions = RefreshSessions(MemoryStore(), SECRET)
        expected = hmac.new(SECRET.encode(), b"refresh:sessionAlice0000000001:secretTwo2222222222222222222222222222222222", hashlib.sha256).hexdigest()
        self.assertEqual(sessions.hash("sessionAlice0000000001", "secretTwo2222222222222222222222222222222222"), expected)
        self.assertEqual(expected, FIXTURE["data"]["secretHash"])


class SessionTests(unittest.TestCase):
    def test_sign_in_rows_rotation_and_no_stored_secrets(self):
        store, auth, user, clock = setup()
        first = auth.login(user["data"]["email"], PASSWORD, "1.1.1.1", "Agent")
        self.assertEqual(first["expiresIn"], 900)
        self.assertEqual(first["refreshExpiresAt"], "2026-01-06T03:04:05.000Z")
        self.assertTrue(first["refreshToken"].startswith(first["sessionId"] + "."))
        self.assertEqual(len(first["sessionId"]), 22)
        row = store.get(session_partition(user["data"]["id"]), first["sessionId"])
        self.assertEqual(list(row["data"]), ["userId", "provider", "tokenVersion", "secretHash", "previousHash", "rotatedAt", "createdAt",
                                             "lastUsedAt", "expiresAt", "revokedAt", "revokedReason", "ip", "userAgent"])
        self.assertEqual(row["ttl"], (NOW_MS + SESSION_TTL_MS) // 1000)
        self.assertEqual(store.get("SESSION", first["sessionId"])["data"], {"userId": user["data"]["id"]})
        self.assertNotIn(first["refreshToken"].split(".")[1], json.dumps(row))
        self.assertEqual(auth.actor(bearer(first["token"]))["sessionId"], first["sessionId"])
        clock.ms += 60000
        second = auth.refresh(first["refreshToken"], "1.1.1.1")
        self.assertEqual((second["sessionId"], second["refreshExpiresAt"]), (first["sessionId"], first["refreshExpiresAt"]))
        self.assertNotEqual(second["refreshToken"], first["refreshToken"])
        listed = auth.sessions(user["data"]["id"], second["sessionId"])
        self.assertNotRegex(json.dumps(listed), "Hash|secret")
        self.assertEqual([(i["current"], i["userAgent"], i["ip"]) for i in listed["items"]], [(True, "Agent", "1.1.1.1")])

    def test_a_session_written_by_another_implementation(self):
        clock = Clock()
        store = MemoryStore()
        store.transact([
            {"row": {"pk": "USERS", "sk": "u-alice", "version": 1, "data": {"id": "u-alice", "email": "alice@example.test", "name": "Alice",
                                                                              "role": "user", "grants": [], "active": True, "tokenVersion": 1}}, "expected": None},
            {"row": POINTER, "expected": None},
            {"row": FIXTURE, "expected": None},
        ])
        auth = Auth(Users(store, now=clock), JwtTokens(SECRET, now=clock), LocalMailbox(), SECRET, now=clock)
        self.assertEqual(auth.actor(bearer(FIXTURE_ACCESS))["sessionId"], "sessionAlice0000000001")
        result = auth.refresh("sessionAlice0000000001.secretTwo2222222222222222222222222222222222", "1.1.1.1")
        self.assertEqual(result["token"], FIXTURE_ACCESS)
        self.assertEqual(result["refreshExpiresAt"], "2026-01-05T03:04:05.000Z")
        row = store.get("SESSIONS#u-alice", "sessionAlice0000000001")
        self.assertEqual(row["version"], 2)
        self.assertEqual(row["data"]["previousHash"], FIXTURE["data"]["secretHash"])
        self.assertEqual(row["data"]["secretHash"], auth.refresh_sessions.hash("sessionAlice0000000001", result["refreshToken"].split(".")[1]))
        # The previous secret now is secretTwo; secretOne is two rotations old: theft.
        with self.assertRaises(HttpError) as caught:
            auth.refresh("sessionAlice0000000001.secretOne1111111111111111111111111111111111", "1.1.1.1")
        self.assertEqual((caught.exception.status, caught.exception.message), (401, "Invalid session"))
        self.assertEqual(store.get("SESSIONS#u-alice", "sessionAlice0000000001")["data"]["revokedReason"], "reuse")
        with self.assertRaises(HttpError):
            auth.actor(bearer(FIXTURE_ACCESS))

    def test_a_sibling_tab_racing_the_write_lands_in_the_grace_window(self):
        store, auth, user, _ = setup()
        session = auth.login(user["data"]["email"], PASSWORD, "1.1.1.1")
        transact = store.transact
        sibling = []

        def racing(writes):
            # Before the first rotation is written, another tab rotates the same token.
            if not sibling and any(w["row"]["pk"].startswith("SESSIONS#") for w in writes):
                sibling.append(None)
                sibling[0] = auth.refresh(session["refreshToken"], "b")
            return transact(writes)

        store.transact = racing
        first = auth.refresh(session["refreshToken"], "a")
        store.transact = transact
        self.assertEqual(first["sessionId"], sibling[0]["sessionId"])
        row = auth.refresh_sessions.get(user["data"]["id"], session["sessionId"])
        self.assertEqual(row["version"], 3)
        # The loser re-read and took the grace path: the last writer holds the current secret.
        self.assertEqual(row["data"]["secretHash"], auth.refresh_sessions.hash(first["sessionId"], first["refreshToken"].split(".")[1]))
        self.assertTrue(auth.actor(bearer(first["token"])))
        self.assertTrue(auth.refresh(first["refreshToken"], "d"))

    def test_persistent_conflicts_end_in_409(self):
        store, auth, user, _ = setup()
        session = auth.login(user["data"]["email"], PASSWORD, "1.1.1.1")
        transact = store.transact

        def conflicting(writes):
            if any(w["row"]["pk"].startswith("SESSIONS#") for w in writes):
                raise Conflict()
            return transact(writes)

        store.transact = conflicting
        for call in (lambda: auth.refresh(session["refreshToken"], "1.1.1.1"), lambda: auth.revoke_session(user["data"]["id"], session["sessionId"])):
            with self.assertRaises(HttpError) as caught:
                call()
            self.assertEqual(caught.exception.status, 409)

        def down(writes):
            raise RuntimeError("database down")

        store.transact = down
        with self.assertRaisesRegex(RuntimeError, "database down"):
            auth.refresh_sessions.revoke(user["data"]["id"], session["sessionId"], "x")

    def test_theft_detection_retries_a_raced_revocation(self):
        store, auth, user, clock = setup()
        session = auth.login(user["data"]["email"], PASSWORD, "1.1.1.1")
        following = auth.refresh(session["refreshToken"], "1.1.1.1")
        clock.ms += 31000
        transact = store.transact
        raced = []

        def racing(writes):
            if not raced and writes[0]["row"]["data"].get("revokedReason") == "reuse":
                raced.append(True)
                raise Conflict()
            return transact(writes)

        store.transact = racing
        with self.assertRaises(HttpError) as caught:
            auth.refresh(session["refreshToken"], "1.1.1.1")
        self.assertEqual(caught.exception.status, 401)
        self.assertEqual(store.get(session_partition(user["data"]["id"]), session["sessionId"])["data"]["revokedReason"], "reuse")
        with self.assertRaises(HttpError):
            auth.refresh(following["refreshToken"], "1.1.1.1")

    def test_logout_revoke_and_sessions(self):
        store, auth, user, _ = setup()
        uid = user["data"]["id"]
        a = auth.login(user["data"]["email"], PASSWORD, "1.1.1.1", "Browser A")
        b = auth.login(user["data"]["email"], PASSWORD, "2.2.2.2")
        self.assertEqual(auth.revoke_session(uid, b["sessionId"]), {"ok": True})
        for bad in (b["sessionId"], "missing", 5, None, "", "x" * 101):
            with self.assertRaises(HttpError) as caught:
                auth.revoke_session(uid, bad)
            self.assertEqual((caught.exception.status, caught.exception.message), (404, "Session not found"))
        self.assertEqual(auth.logout(uid, a["sessionId"], "true"), {"ok": True})  # only the boolean means everywhere
        self.assertEqual(store.get("USERS", uid)["data"]["tokenVersion"], 1)
        self.assertEqual(auth.sessions(uid)["items"], [])
        c = auth.login(user["data"]["email"], PASSWORD, "3.3.3.3")
        self.assertEqual(auth.logout(uid, c["sessionId"], True), {"ok": True})
        self.assertEqual(store.get("USERS", uid)["data"]["tokenVersion"], 2)
        with self.assertRaises(HttpError) as caught:
            auth.logout("missing", None, True)
        self.assertEqual(caught.exception.status, 401)

    def test_an_identity_provider_logs_out_only_everywhere(self):
        calls = []

        class Provider:
            id = "test"

            def password(self, id, password):
                return {"accessToken": "x"}

            def logout(self, id):
                calls.append(id)

            def mfa_status(self, id):
                return False

        _, auth, user, _ = setup(Provider())
        session = auth.login(user["data"]["email"], PASSWORD, "1.1.1.1")
        self.assertEqual(auth.refresh(session["refreshToken"], "1.1.1.1")["sessionId"], session["sessionId"])
        auth.logout(user["data"]["id"], session["sessionId"])
        self.assertEqual(calls, [])
        auth.logout(user["data"]["id"], None, True)
        self.assertEqual(calls, [user["data"]["id"]])

    def test_configurable_lifetime_grace_and_rate_limiter(self):
        store, auth, user, clock = setup(session_ttl_ms=60000, refresh_grace_ms=0)
        session = auth.login(user["data"]["email"], PASSWORD, "1.1.1.1")
        self.assertEqual(session["refreshExpiresAt"], "2026-01-02T03:05:05.000Z")
        following = auth.refresh(session["refreshToken"], "1.1.1.1")
        clock.ms += 1
        for token in (session["refreshToken"], following["refreshToken"]):
            with self.assertRaises(HttpError) as caught:
                auth.refresh(token, "1.1.1.1")
            self.assertEqual(caught.exception.status, 401)
        rate_limit(store, SECRET, clock.ms, "k", 1)
        with self.assertRaises(HttpError) as caught:
            rate_limit(store, SECRET, clock.ms, "k", 1)
        self.assertEqual(caught.exception.status, 429)
        sessions = RefreshSessions(store, SECRET)
        self.assertEqual(sessions.ttl_ms, SESSION_TTL_MS)
        self.assertIsNone(sessions.find("nope"))
        self.assertFalse(sessions.revoke(user["data"]["id"], "", "x"))


class SessionHttpTests(unittest.TestCase):
    def test_endpoints_over_the_app(self):
        store, auth, user, _ = setup()
        app = App([auth.feature()], authenticate=auth.actor_from_request)
        access = {f"{e.method} {e.path}": e.access for e in app.endpoints}
        self.assertEqual((access["POST /auth/refresh"], access["GET /auth/sessions"], access["DELETE /auth/sessions/:id"]),
                         ("guest", "authenticated", "authenticated"))

        def call(method, path, body=None, token=None, agent=None):
            headers = {}
            if token:
                headers["authorization"] = bearer(token)
            if agent:
                headers["user-agent"] = agent
            return app.handle(Request(method=method, path=path, body=body or {}, headers=headers, ip="1.1.1.1"))

        self.assertTrue(call("GET", "/auth/methods").body["refreshTokens"])
        credentials = {"email": user["data"]["email"], "password": PASSWORD}
        a = call("POST", "/auth/login", credentials, agent="Browser A").body
        b = call("POST", "/auth/login", credentials).body
        self.assertEqual(call("POST", "/auth/refresh", {}).body, {"error": "Invalid session"})
        refreshed = call("POST", "/auth/refresh", {"refreshToken": a["refreshToken"]})
        self.assertEqual((refreshed.status, refreshed.body["sessionId"]), (200, a["sessionId"]))
        listed = call("GET", "/auth/sessions", token=a["token"]).body["items"]
        self.assertEqual(sorted((i["id"], i["current"], i["userAgent"]) for i in listed),
                         sorted([(a["sessionId"], True, "Browser A"), (b["sessionId"], False, None)]))
        self.assertEqual(call("DELETE", f"/auth/sessions/{b['sessionId']}", token=a["token"]).body, {"ok": True})
        self.assertEqual(call("GET", "/auth/sessions", token=b["token"]).body, {"error": "Invalid session"})
        self.assertEqual(call("POST", "/auth/logout", token=a["token"]).body, {"ok": True})
        self.assertEqual(call("GET", "/auth/sessions", token=a["token"]).status, 401)
        self.assertEqual(store.get("USERS", user["data"]["id"])["data"]["tokenVersion"], 1)
        c = call("POST", "/auth/login", credentials).body
        self.assertEqual(call("POST", "/auth/logout", {"all": True}, token=c["token"]).body, {"ok": True})
        self.assertEqual(store.get("USERS", user["data"]["id"])["data"]["tokenVersion"], 2)


if __name__ == "__main__":
    unittest.main()
