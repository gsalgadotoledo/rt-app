import unittest
from datetime import datetime, timezone

from rt_app import HttpError
from rt_app.nosql import MemoryStore
from rt_app.tasks import Tasks, migrate, welcome_rows
from rt_app.web import App, Request

ALICE = {"id": "alice", "role": "user", "grants": []}
BOB = {"id": "bob", "role": "user", "grants": []}
OWNER = {"id": "root", "role": "owner"}
MANAGER = {"id": "mgr", "role": "admin", "grants": ["tasks.manage"]}


class TasksTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 1, 2, 3, 4, 5, 678000, tzinfo=timezone.utc)
        self.store = MemoryStore()
        ids = iter(f"id-{n}" for n in range(100))
        self.tasks = Tasks(self.store, now=lambda: self.now, new_id=lambda: next(ids))

    def assertHttpError(self, status, message, fn, *args):
        with self.assertRaises(HttpError) as caught:
            fn(*args)
        self.assertEqual((caught.exception.status, caught.exception.message), (status, message))

    def test_create_with_audit_fields(self):
        task = self.tasks.create({"title": " Milk ", "done": True, "ownerId": "bob"}, ALICE)
        stamp = "2026-01-02T03:04:05.678Z"
        self.assertEqual(task, {
            "id": "id-0", "title": "Milk", "done": False, "ownerId": "alice", "createdAt": stamp, "createdBy": "alice",
            "updatedAt": stamp, "updatedBy": "alice", "deletedAt": None, "deletedBy": None,
        })
        self.assertEqual(self.store.get("TASKS", "id-0")["version"], 1)
        self.assertHttpError(400, "Invalid field: title", self.tasks.create, {"title": "🙂" * 101}, ALICE)
        self.assertHttpError(400, "Invalid field: title", self.tasks.create, {}, ALICE)

    def test_default_ids_are_uuid4(self):
        task = Tasks(MemoryStore()).create({"title": "x"}, ALICE)
        self.assertRegex(task["id"], r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")

    def test_lists_filters_and_trash(self):
        self.tasks.create({"title": "Ärger"}, ALICE)
        self.tasks.create({"title": "Other"}, BOB)
        self.assertEqual([t["id"] for t in self.tasks.list({}, ALICE)["items"]], ["id-0"])
        self.assertEqual([t["id"] for t in self.tasks.list({}, OWNER, everyone=True)["items"]], ["id-0", "id-1"])
        self.assertEqual([t["id"] for t in self.tasks.list({"title": "äR"}, OWNER, everyone=True)["items"]], ["id-0"])
        self.assertEqual([t["id"] for t in self.tasks.list({"done": "FAL"}, OWNER, everyone=True)["items"]], ["id-0", "id-1"])
        self.assertHttpError(400, "Unsupported filter: status", self.tasks.list, {"status": "x"}, ALICE)
        self.assertHttpError(400, "Invalid trash filter", self.tasks.list, {"trash": "yes", "status": "x"}, ALICE)
        self.tasks.remove("id-0", ALICE)
        self.assertEqual(self.tasks.list({}, ALICE)["items"], [])
        self.assertEqual(self.tasks.list({"trash": "true"}, ALICE)["items"][0]["deletedBy"], "alice")

    def test_edit_rules(self):
        self.tasks.create({"title": "Mine"}, ALICE)
        self.assertHttpError(404, "Task not found", self.tasks.update, "nope", {}, ALICE)
        self.assertHttpError(403, "This task belongs to another user", self.tasks.update, "id-0", {"done": "x"}, BOB)
        self.assertHttpError(400, "Invalid field: title", self.tasks.update, "id-0", {"title": None, "done": 1}, ALICE)
        self.assertHttpError(400, "done must be a boolean", self.tasks.update, "id-0", {"done": 1}, ALICE)
        self.now = datetime(2026, 3, 4, tzinfo=timezone.utc)
        updated = self.tasks.update("id-0", {"title": "By manager", "done": True}, MANAGER)
        self.assertEqual((updated["title"], updated["done"], updated["updatedBy"], updated["updatedAt"]), ("By manager", True, "mgr", "2026-03-04T00:00:00.000Z"))
        self.assertEqual(updated["createdAt"], "2026-01-02T03:04:05.678Z")
        self.assertEqual(self.store.get("TASKS", "id-0")["version"], 2)

    def test_trash_and_restore(self):
        self.tasks.create({"title": "T"}, ALICE)
        self.assertHttpError(404, "Task not found", self.tasks.restore, "id-0", ALICE)
        self.assertHttpError(403, "Requires tasks.manage", self.tasks.admin_remove, "nope", ALICE)
        self.assertEqual(self.tasks.admin_remove("id-0", OWNER), {"ok": True})
        self.assertHttpError(404, "Task not found", self.tasks.remove, "id-0", ALICE)
        self.assertHttpError(403, "This task belongs to another user", self.tasks.restore, "id-0", {**BOB, "grants": ["tasks.restore"]})
        restored = self.tasks.restore("id-0", ALICE)
        self.assertEqual((restored["deletedAt"], restored["restoredBy"]), (None, "alice"))

    def test_unknown_fields_and_ttl_survive_edits(self):
        self.store.transact([{"row": {"pk": "TASKS", "sk": "w", "version": 3, "ttl": 99, "data": {"id": "w", "title": "W", "done": False, "ownerId": "alice", "color": "red", "deletedAt": ""}}, "expected": None}])
        self.tasks.update("w", {"done": True}, ALICE)
        row = self.store.get("TASKS", "w")
        self.assertEqual((row["version"], row["ttl"], row["data"]["color"], row["data"]["done"]), (4, 99, "red", True))

    def test_empty_containers_are_truthy_deletion_marks(self):
        self.store.transact([{"row": {"pk": "TASKS", "sk": "x", "version": 1, "data": {"id": "x", "title": "X", "ownerId": "alice", "deletedAt": []}}, "expected": None}])
        self.assertHttpError(404, "Task not found", self.tasks.update, "x", {}, ALICE)

    def test_migration_and_seed(self):
        migrate(self.store)
        migrate(self.store)
        self.assertEqual(self.store.get("SCHEMA", "tasks")["version"], 1)
        rows = welcome_rows([{"pk": "USERS", "sk": "u1", "version": 1, "data": {"id": "u1"}}], self.now)
        self.assertEqual(rows, [{"pk": "TASKS", "sk": "welcome-u1", "data": {
            "id": "welcome-u1", "title": "Explore my first task in RT-App", "done": False, "ownerId": "u1", "createdAt": "2026-01-02T03:04:05.678Z"}}])

    def test_http_routes_in_local_mode(self):
        app = App([self.tasks.feature()], local_admin=True)
        self.assertEqual((app.handle(Request("GET", "/tasks")).status), 401)
        self.assertEqual(app.handle(Request("DELETE", "/tasks/admin")).status, 401)
        self.assertEqual(app.handle(Request("GET", "/admin/app/tasks/admin")).body, {"items": [], "cursor": None})
        response = app.handle(Request("PATCH", "/admin/app/tasks/admin/nope", body={"title": "x"}))
        self.assertEqual((response.status, response.body), (404, {"error": "Task not found"}))


if __name__ == "__main__":
    unittest.main()
