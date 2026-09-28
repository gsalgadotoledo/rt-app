"""Test users (port of packages/users/tests/test-users.test.mjs)."""
import unittest

from rt_app import HttpError
from rt_app import users as users_module
from rt_app.auth import Auth, LocalMailbox
from rt_app.jwt import JwtTokens
from rt_app.nosql import MemoryStore
from rt_app.users import Users, view_account
from rt_app.web import App, Request

SECRET = "users-test-flag-secret-users-test-flag-secret"
PASSWORD = "correct horse battery"
NOW_MS = 1772359200000  # 2026-03-01T10:00:00.000Z
BASE = {"role": "user", "grants": [], "active": True, "tokenVersion": 1}


def raises(case, status, message, fn, *args):
    with case.assertRaises(HttpError) as caught:
        fn(*args)
    case.assertEqual((caught.exception.status, caught.exception.message), (status, message))


def seed(store, *rows):
    store.transact([{"row": {"pk": "USERS", "sk": data["id"], "version": 1, "data": {**BASE, **data}}, "expected": None} for data in rows])


class TestUsers(unittest.TestCase):
    def test_validators_are_strict(self):
        self.assertFalse(users_module.is_test_user(None))
        self.assertFalse(users_module.is_test_user({"testUser": "true"}))
        self.assertFalse(users_module.is_test_user({"testUser": 1}))
        self.assertTrue(users_module.is_test_user({"testUser": True}))
        self.assertIsNone(users_module.test_user_input(None))
        self.assertIs(users_module.test_user_input(False), False)
        for bad in ("true", 1, 0, {}, []):
            raises(self, 400, "Invalid field: testUser", users_module.test_user_input, bad)
        for ok in (None, "", "true", "false"):
            users_module.test_user_filter(ok)
        for bad in ("yes", "TRUE", "1"):
            raises(self, 400, "Invalid testUser filter", users_module.test_user_filter, bad)
        self.assertEqual(view_account({"id": "u", "testUser": True}, NOW_MS)["testUser"], True)
        self.assertEqual(view_account({"id": "u"}, NOW_MS)["testUser"], False)

    def test_create_and_bootstrap(self):
        users = Users(MemoryStore(), now=lambda: NOW_MS)
        owner = users.bootstrap_owner({"email": "owner@example.test", "name": "Owner", "password": PASSWORD, "testUser": "ignored"})
        self.assertNotIn("testUser", owner["data"])
        self.assertIs(users.create({"email": "qa@example.test", "name": "QA", "password": PASSWORD, "testUser": True})["data"]["testUser"], True)
        self.assertNotIn("testUser", users.create({"email": "r@example.test", "name": "R", "password": PASSWORD, "testUser": False})["data"])
        raises(self, 400, "Invalid field: testUser", users.create, {"email": "b@example.test", "name": "B", "password": PASSWORD, "testUser": 1})
        raises(self, 400, "The password must contain 12 to 128 characters", users.create, {"email": "b@example.test", "name": "B", "password": "x", "testUser": 1})
        self.assertIsNone(users.by_email("b@example.test"))

    def test_update_toggles_and_keeps_bans_and_sessions(self):
        store = MemoryStore()
        users = Users(store, now=lambda: NOW_MS)
        ban = {"reason": "Spam", "category": None, "until": None, "at": "2026-03-01T09:00:00.000Z", "by": "rt-app-root"}
        seed(store, {"id": "u-1", "email": "a@example.test", "name": "A", "tokenVersion": 3, "ban": ban})
        view = users.update("u-1", {"testUser": True}, "admin-1")
        self.assertEqual((view["testUser"], view["banned"], view["name"], view["updatedBy"]), (True, True, "A", "admin-1"))
        row = store.get("USERS", "u-1")
        self.assertEqual((row["version"], row["data"]["testUser"], row["data"]["tokenVersion"], row["data"]["ban"]), (2, True, 3, ban))
        self.assertTrue(users.update("u-1", {"name": " Ana "}, "admin-1")["testUser"])
        self.assertFalse(users.update("u-1", {"name": None, "testUser": False}, "admin-1")["testUser"])
        self.assertEqual(store.get("USERS", "u-1")["data"]["testUser"], False)
        for body, message in (
            ({}, "Invalid field: name"),
            ({"testUser": None}, "Invalid field: name"),
            ({"testUser": "yes"}, "Invalid field: testUser"),
            ({"name": "B", "testUser": 1}, "Invalid field: testUser"),
            ({"email": "x"}, "Only name and testUser can be edited; email requires verification"),
        ):
            raises(self, 400, message, users.update, "u-1", body, "admin-1")
        raises(self, 404, "User not found", users.update, "missing", {"email": "x"}, "admin-1")
        self.assertEqual(store.get("USERS", "u-1")["version"], 4)
        raises(self, 400, "Only name can be edited; email requires verification", users.profile, "u-1", {"testUser": True})

    def test_list_filter_and_ids(self):
        store = MemoryStore()
        users = Users(store, now=lambda: NOW_MS)
        seed(
            store,
            {"id": "u-1", "email": "a@example.test", "name": "A", "testUser": True},
            {"id": "u-2", "email": "b@example.test", "name": "B"},
            {"id": "u-3", "email": "c@example.test", "name": "C", "testUser": "yes"},
            {"id": "u-4", "email": "d@example.test", "name": "D", "testUser": True, "deletedAt": "2026-02-01T00:00:00.000Z"},
        )
        app = App([users.feature()], local_admin=True)

        def ids(query):
            return [u["id"] for u in app.handle(Request(method="GET", path="/admin/app/users", query=query)).body["items"]]

        self.assertEqual(ids({"testUser": "true"}), ["u-1"])
        self.assertEqual(ids({"testUser": "false"}), ["u-2", "u-3"])
        self.assertEqual(ids({"testUser": ""}), ["u-1", "u-2", "u-3"])
        self.assertEqual(ids({"testUser": "true", "trash": "true"}), ["u-4"])
        bad = app.handle(Request(method="GET", path="/admin/app/users", query={"testUser": "yes"}))
        self.assertEqual((bad.status, bad.body), (400, {"error": "Invalid testUser filter"}))
        self.assertEqual(users_module.test_user_ids(store), {"u-1", "u-4"})
        self.assertIn("testUser", users.feature().admin["fields"])

    def test_http_only_admins_set_the_flag(self):
        store = MemoryStore()
        users = Users(store, now=lambda: NOW_MS)
        auth = Auth(users, JwtTokens(SECRET, now=lambda: NOW_MS), LocalMailbox(), SECRET, now=lambda: NOW_MS)
        app = App([users.feature(), auth.feature()], local_admin=True, authenticate=auth.actor_from_request)

        def call(method, path, body=None, query=None, token=None):
            headers = {"authorization": "Bearer " + token} if token else {}
            return app.handle(Request(method=method, path=path, body=body or {}, query=query or {}, headers=headers, ip="1.1.1.1"))

        created = call("POST", "/admin/app/users", {"name": "QA", "email": "qa@example.test", "password": PASSWORD, "testUser": True})
        self.assertEqual((created.status, created.body["testUser"], created.body["banned"]), (200, True, False))
        token = call("POST", "/auth/login", {"email": "qa@example.test", "password": PASSWORD}).body["token"]
        self.assertEqual(call("PATCH", "/users/me", {"testUser": False}, token=token).status, 400)
        self.assertEqual(call("PATCH", f"/users/{created.body['id']}", {"testUser": False}, token=token).status, 403)
        toggled = call("PATCH", f"/admin/app/users/{created.body['id']}", {"testUser": False})
        self.assertEqual((toggled.status, toggled.body["testUser"]), (200, False))
        self.assertEqual(call("GET", "/users/me", token=token).status, 200)


if __name__ == "__main__":
    unittest.main()
