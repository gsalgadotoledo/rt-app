import unittest

from rt_app import HttpError
from rt_app.content import DEFAULT_HOME, Content, migrate
from rt_app.nosql import MemoryStore
from rt_app.web import App, Request


class ContentTests(unittest.TestCase):
    def setUp(self):
        self.store = MemoryStore()
        self.content = Content(self.store)

    def assertHttpError(self, status, message, fn, *args):
        with self.assertRaises(HttpError) as caught:
            fn(*args)
        self.assertEqual((caught.exception.status, caught.exception.message), (status, message))

    def test_defaults_until_the_first_save(self):
        self.assertEqual(self.content.home(), dict(DEFAULT_HOME))
        settings = self.content.settings()
        self.assertEqual(settings["version"], 0)
        self.assertEqual([f["name"] for f in settings["fields"]], ["title", "content"])
        self.assertIsNone(self.store.get("CONTENT", "home"))

    def test_save_trims_and_increments_the_version(self):
        saved = self.content.save({"version": 0, "values": {"title": " Hi　", "content": " Body ", "x": 1}})
        self.assertEqual((saved["version"], saved["values"]), (1, {"title": "Hi", "content": "Body"}))
        self.assertEqual(self.content.save({"version": 1.0, "values": {"title": "B", "content": "b"}})["version"], 2)
        self.assertEqual(self.store.get("CONTENT", "home"), {"pk": "CONTENT", "sk": "home", "version": 2, "data": {"title": "B", "content": "b"}})

    def test_version_rules_come_before_the_values(self):
        for version in (None, "0", 0.5, True, [0], {}):
            self.assertHttpError(400, "Version is required", self.content.save, {"version": version, "values": {}})
        self.assertHttpError(409, "Conflict: refresh and try again", self.content.save, {"version": 3, "values": {}})
        self.assertHttpError(409, "Conflict: refresh and try again", self.content.save, {"version": 1e300})
        self.assertHttpError(400, "Invalid field: title", self.content.save, {"version": 0, "values": "text"})

    def test_limits_count_utf16_units_before_trimming(self):
        self.assertHttpError(400, "Invalid field: title", self.content.save, {"version": 0, "values": {"title": "😀" * 61, "content": "c"}})
        self.assertHttpError(400, "Invalid field: title", self.content.save, {"version": 0, "values": {"title": "a" + " " * 120, "content": "c"}})
        self.assertHttpError(400, "Invalid field: content", self.content.save, {"version": 0, "values": {"title": "t", "content": "𝄞" * 1001}})
        self.assertEqual(self.content.save({"version": 0, "values": {"title": "😀" * 60, "content": "𝄞" * 1000}})["version"], 1)
        # U+200B and U+0085 are not JavaScript whitespace.
        self.assertEqual(self.content.save({"version": 1, "values": {"title": "​", "content": "\u0085"}})["values"]["title"], "​")

    def test_migration_runs_once(self):
        migrate(self.store)
        migrate(self.store)
        self.assertEqual(self.store.get("SCHEMA", "content")["data"], {"schemaVersion": 1})

    def test_http_routes(self):
        app = App([self.content.feature()], local_admin=True)
        self.assertEqual(app.handle(Request("GET", "/")).body, dict(DEFAULT_HOME))
        self.assertEqual(app.handle(Request("GET", "/content/settings")).status, 401)  # plain path needs a session
        response = app.handle(Request("PUT", "/admin/app/content/settings", body={"version": 0, "values": {"title": "T", "content": "C"}}))
        self.assertEqual((response.status, response.body["version"]), (200, 1))
        self.assertEqual(app.handle(Request("GET", "/")).body, {"title": "T", "content": "C"})


if __name__ == "__main__":
    unittest.main()
