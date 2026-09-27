"""Account bans (port of packages/users-bans/tests and packages/auth/tests/bans.test.mjs)."""
import unittest

from rt_app import HttpError
from rt_app.auth import Auth, LocalMailbox
from rt_app.auth_sessions import session_partition
from rt_app.errors import Conflict
from rt_app.jwt import JwtTokens
from rt_app.nosql import MemoryStore
from rt_app.users import ACCOUNT_SUSPENDED, MAX_INSTANT_MS, Users, active_ban, parse_instant, view_account
from rt_app.users_bans import BAN_SESSION_REASON, ROOT_ACTOR, UserBans, ban_category, ban_partition, ban_reason, ban_until
from rt_app.web import App, Request

SECRET = "users-bans-test-secret-users-bans-test-secret"
PASSWORD = "correct horse battery"
NOW_MS = 1772359200000  # 2026-03-01T10:00:00.000Z
ROOT = {"id": ROOT_ACTOR, "role": "owner"}


class Clock:
    def __init__(self, ms: int = NOW_MS) -> None:
        self.ms = ms

    def __call__(self) -> int:
        return self.ms


def setup(store=None, sessions=True):
    clock = Clock()
    store = store or MemoryStore()
    users = Users(store, now=clock)
    auth = Auth(users, JwtTokens(SECRET, now=clock), LocalMailbox(), SECRET, now=clock)
    bans = UserBans(users, now=clock, sessions=auth.refresh_sessions if sessions else None)

    def make(email, role=None):
        return users.create({"name": email.split("@")[0], "email": email, "password": PASSWORD}, role)["data"]

    return store, users, auth, bans, clock, make


def raises(test, status, message, fn, *args):
    """assertRaises that also checks the status and the message."""
    with test.assertRaises(HttpError) as caught:
        fn(*args)
    test.assertEqual((caught.exception.status, caught.exception.message), (status, message))


class SuspensionTests(unittest.TestCase):
    def test_parse_instant(self):
        self.assertEqual(parse_instant("2026-01-02T03:04:05+01:00"), 1767319445000)
        self.assertEqual(parse_instant("2026-01-02T03:04:05.1Z"), 1767323045100)
        self.assertEqual(parse_instant("9999-12-31T23:59:59.999Z"), MAX_INSTANT_MS)
        self.assertEqual(parse_instant("1970-01-01T00:00:00Z"), 0)
        for bad in (None, 5, True, "", "2026-01-02", "2026-01-02T03:04:05Z\n", "2025-02-29T00:00:00Z", "٢٠٢٦-01-02T00:00:00Z",
                    "2026-01-02T00:00:00+24:00", "1969-12-31T23:59:59Z", "9999-12-31T23:59:59-00:01"):
            self.assertIsNone(parse_instant(bad), repr(bad))

    def test_active_ban_and_view(self):
        ban = {"reason": "Spam", "category": None, "until": "2026-03-01T10:00:00.001Z", "at": "x", "by": ROOT_ACTOR}
        self.assertEqual(active_ban({"ban": ban}, NOW_MS), ban)
        self.assertIsNone(active_ban({"ban": ban}, NOW_MS + 1))
        self.assertIsNone(active_ban({"ban": [1]}, NOW_MS))
        self.assertIsNone(active_ban(None, NOW_MS))
        self.assertEqual(active_ban({"ban": {"until": "soon"}}, NOW_MS)["until"], "soon")
        view = view_account({"id": "u", "ban": ban, "tokenVersion": 3}, NOW_MS)
        self.assertEqual((view["banned"], view["ban"]["reason"], "tokenVersion" in view), (True, "Spam", False))


class ValidationTests(unittest.TestCase):
    def test_fields(self):
        self.assertEqual(ban_reason("  abc  "), "abc")
        self.assertEqual(ban_reason("😀" * 250), "😀" * 250)
        for bad in (None, 5, "ab", " ab ", "x" * 501, "😀" * 251):
            raises(self, 400, "A reason of 3 to 500 characters is required", ban_reason, bad)
        self.assertIsNone(ban_until(None, NOW_MS))
        self.assertEqual(ban_until("2026-03-02T01:30:00.5+01:30", NOW_MS), "2026-03-02T00:00:00.500Z")
        for bad in (5, True, "tomorrow", "2026-02-30T00:00:00Z"):
            raises(self, 400, "Invalid until: use an ISO 8601 date and time", ban_until, bad, NOW_MS)
        raises(self, 400, "until must be in the future", ban_until, "2026-03-01T10:00:00.000Z", NOW_MS)
        self.assertIsNone(ban_category(None))
        self.assertEqual(ban_category("fraud"), "fraud")
        for bad in ("", "Fraud", "a" * 41, 5, "abc\n"):
            raises(self, 400, "Invalid category", ban_category, bad)


class UserBansTests(unittest.TestCase):
    def test_rules(self):
        _, _, _, bans, _, make = setup()
        owner, other = make("owner@example.test", "owner"), make("owner2@example.test", "owner")
        admin, admin2, user = make("admin@example.test", "admin"), make("admin2@example.test", "admin"), make("user@example.test")
        reason = {"reason": "Policy violation"}
        raises(self, 403, "You cannot ban your own account", bans.ban, owner["id"], reason, owner)
        raises(self, 403, "Only the admin root can ban an owner", bans.ban, other["id"], reason, owner)
        raises(self, 403, "Only an owner can ban an administrator", bans.ban, admin2["id"], reason, admin)
        raises(self, 404, "User not found", bans.ban, "nobody", reason, ROOT)
        raises(self, 404, "User not found", bans.ban, 5, reason, ROOT)
        raises(self, 404, "User not found", bans.ban, "x" * 101, reason, ROOT)
        self.assertTrue(bans.ban(user["id"], reason, admin)["banned"])
        self.assertTrue(bans.ban(other["id"], reason, ROOT)["banned"])
        raises(self, 403, "Only the admin root can unban an owner", bans.unban, other["id"], reason, owner)
        self.assertFalse(bans.unban(other["id"], reason, ROOT)["banned"])

    def test_ban_cuts_sessions_and_unban_restores_sign_in(self):
        store, _, auth, bans, clock, make = setup()
        user = make("user@example.test")
        session = auth.login(user["email"], PASSWORD, "1.1.1.1")
        view = bans.ban(user["id"], {"reason": " Fraud ", "until": "2026-03-01T11:00:00Z", "category": "fraud"}, ROOT)
        self.assertEqual(view["ban"], {"reason": "Fraud", "category": "fraud", "until": "2026-03-01T11:00:00.000Z",
                                       "at": "2026-03-01T10:00:00.000Z", "by": ROOT_ACTOR})
        row = store.get(session_partition(user["id"]), session["sessionId"])
        self.assertEqual((row["data"]["revokedAt"], row["data"]["revokedReason"]), (NOW_MS, BAN_SESSION_REASON))
        self.assertEqual(store.get(ban_partition(user["id"]), "001772359200000-0000000002")["data"]["action"], "ban")
        raises(self, 401, "Invalid session", auth.actor, "Bearer " + session["token"])
        raises(self, 403, ACCOUNT_SUSPENDED, auth.refresh, session["refreshToken"], "1.1.1.1")
        raises(self, 401, "Invalid session", auth.refresh, session["sessionId"] + "." + "x" * 43, "1.1.1.1")
        raises(self, 403, ACCOUNT_SUSPENDED, auth.login, user["email"], PASSWORD, "1.1.1.1")
        raises(self, 401, "Incorrect email or password", auth.login, user["email"], PASSWORD + "x", "1.1.1.1")
        clock.ms = NOW_MS + 3600000 - 1
        raises(self, 403, ACCOUNT_SUSPENDED, auth.login, user["email"], PASSWORD, "1.1.1.1")
        clock.ms = NOW_MS + 3600000
        self.assertIn("token", auth.login(user["email"], PASSWORD, "1.1.1.1"))
        raises(self, 409, "User is not banned", bans.unban, user["id"], {"reason": "Expired"}, ROOT)
        bans.ban(user["id"], {"reason": "Again"}, ROOT)
        clock.ms += 1000
        bans.ban(user["id"], {"reason": "Updated"}, {"id": "u-admin", "role": "admin"})
        self.assertFalse(bans.unban(user["id"], {"reason": "Appeal"}, ROOT)["banned"])
        self.assertEqual(store.get("USERS", user["id"])["data"]["tokenVersion"], 4)
        raises(self, 401, "Invalid session", auth.refresh, session["refreshToken"], "1.1.1.1")
        self.assertIn("token", auth.login(user["email"], PASSWORD, "1.1.1.1"))
        self.assertEqual([i["action"] for i in bans.history(user["id"])["items"]], ["unban", "update", "ban", "ban"])
        raises(self, 404, "User not found", bans.history, "nobody")

    def test_codes_mfa_and_reset(self):
        store, users, auth, bans, _, make = setup()
        user = make("user@example.test")
        bans.ban(user["id"], {"reason": "Abuse"}, ROOT)
        auth.issue(user["email"], "login", "1.1.1.1")
        raises(self, 403, ACCOUNT_SUSPENDED, auth.consume, user["email"], auth.mail.messages[0]["code"], "login", "1.1.1.1")
        auth.issue(user["email"], "reset", "1.1.1.1")
        self.assertEqual(auth.consume(user["email"], auth.mail.messages[0]["code"], "reset", "1.1.1.1", PASSWORD + "!"),
                         {"message": "Password updated. Sign in to continue."})
        self.assertIsNotNone(store.get("USERS", user["id"])["data"]["ban"])
        # A ban written without a tokenVersion bump (another writer) still refuses the token.
        other = make("other@example.test")
        session = auth.login(other["email"], PASSWORD, "1.1.1.1")
        row = users.get(other["id"])
        store.transact([{"row": {**row, "version": row["version"] + 1, "data": {**row["data"], "ban": {"reason": "x"}}}, "expected": row["version"]}])
        raises(self, 403, ACCOUNT_SUSPENDED, auth.actor, "Bearer " + session["token"])

    def test_conflicts_are_retried(self):
        store = MemoryStore()
        transact = store.transact
        state = {"failures": 0}

        def flaky(writes):
            if state["failures"] and any(w["row"]["pk"].startswith("USER_BANS#") for w in writes):
                state["failures"] -= 1
                raise Conflict()
            return transact(writes)

        store.transact = flaky
        _, _, _, bans, _, make = setup(store=store, sessions=False)
        user = make("user@example.test")
        state["failures"] = 1
        self.assertTrue(bans.ban(user["id"], {"reason": "Retried"}, ROOT)["banned"])
        state["failures"] = 4
        raises(self, 409, "Conflict: refresh and try again", bans.unban, user["id"], {"reason": "Four conflicts"}, ROOT)

    def test_http(self):
        store, users, auth, bans, _, make = setup()
        user = make("user@example.test")
        app = App([users.feature(), bans.feature(), auth.feature()], local_admin=True, authenticate=auth.actor_from_request)

        def call(method, path, body=None, query=None):
            return app.handle(Request(method=method, path=path, body=body or {}, query=query or {}, ip="1.1.1.1"))

        self.assertEqual(call("POST", f"/users/{user['id']}/ban", {"reason": "Spam"}).status, 401)
        banned = call("POST", f"/admin/app/users/{user['id']}/ban", {"reason": "Spam"})
        self.assertEqual((banned.status, banned.body["ban"]["by"]), (200, ROOT_ACTOR))
        self.assertEqual(call("GET", "/admin/app/users", query={"banned": "true"}).body["items"][0]["id"], user["id"])
        self.assertEqual(call("GET", f"/admin/app/users/{user['id']}/bans").body["items"][0]["action"], "ban")
        tools = sorted(e.tool["name"] for e in bans.feature().endpoints)
        self.assertEqual(tools, ["users_ban", "users_bans", "users_unban"])


if __name__ == "__main__":
    unittest.main()
