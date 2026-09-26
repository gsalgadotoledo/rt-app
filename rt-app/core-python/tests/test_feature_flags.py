import unittest
from datetime import datetime, timezone

from rt_app import HttpError
from rt_app.feature_flags import FeatureFlags, rollout_bucket
from rt_app.nosql import MemoryStore

DEFINITION = {"description": "", "enabled": True, "public": True, "rollout": 100, "subjects": []}
NOW = datetime(2026, 1, 2, 3, 4, 5, 678901, tzinfo=timezone.utc)


class FeatureFlagTests(unittest.TestCase):
    def setUp(self):
        self.flags = FeatureFlags(MemoryStore(), now=lambda: NOW)

    def assertHttpError(self, status, message, fn, *args):
        with self.assertRaises(HttpError) as caught:
            fn(*args)
        self.assertEqual((caught.exception.status, caught.exception.message), (status, message))

    def test_save_get_and_update(self):
        saved = self.flags.save("checkout", {**DEFINITION, "subjects": ["vip", "vip", "beta"]}, None, "owner-1")
        self.assertEqual(saved, {
            "key": "checkout", "description": "", "enabled": True, "public": True, "rollout": 100,
            "subjects": ["vip", "beta"], "updatedAt": "2026-01-02T03:04:05.678Z", "updatedBy": "owner-1", "version": 1,
        })
        self.assertEqual(self.flags.get("checkout"), saved)
        self.assertHttpError(409, "Conflict: refresh and try again", self.flags.save, "checkout", DEFINITION, None, "a")
        self.assertEqual(self.flags.save("checkout", DEFINITION, 1.0, "b")["version"], 2)  # JSON 1.0 is 1
        self.assertEqual([f["key"] for f in self.flags.list()["items"]], ["checkout"])

    def test_validation_follows_javascript_types(self):
        invalid = [
            ({**DEFINITION, "rollout": True}, None),
            ({**DEFINITION, "enabled": 1}, None),
            ({**DEFINITION, "description": 5}, None),
            ({**DEFINITION, "description": "😀" * 201}, None),  # 402 UTF-16 units
            ({**DEFINITION, "subjects": ["s" * 121]}, None),
            ({**DEFINITION, "rollout": float("nan")}, None),
            (DEFINITION, True),
            (DEFINITION, 1.5),
            (DEFINITION, 0),
        ]
        for definition, version in invalid:
            with self.subTest(definition=definition, version=version):
                self.assertHttpError(400, "Invalid flag configuration", self.flags.save, "f", definition, version, "a")
        self.assertHttpError(400, "Invalid flag key", self.flags.get, "Bad Key")
        self.assertHttpError(400, "Invalid flag key", self.flags.get, "ok\n")
        self.assertHttpError(400, "Invalid flag subject", self.flags.enabled, "f", "😀" * 61)
        self.assertHttpError(400, "Invalid flag subject", self.flags.enabled, "f", 42)
        self.flags.save("f", {**DEFINITION, "description": "😀" * 200, "subjects": ["é" * 120]}, None, "a")

    def test_evaluation(self):
        self.flags.save("half", {**DEFINITION, "rollout": 50}, None, "a")
        self.flags.save("private", {**DEFINITION, "public": False}, None, "a")
        self.flags.save("vip", {**DEFINITION, "rollout": 0, "subjects": ["vip"]}, None, "a")
        self.assertFalse(self.flags.enabled("missing"))
        self.assertTrue(self.flags.enabled("vip", "vip"))
        self.assertFalse(self.flags.enabled("vip", "other"))
        self.assertTrue(self.flags.enabled("private"))
        self.assertFalse(self.flags.enabled("private", "", True))
        self.assertFalse(self.flags.enabled("half"))
        expected = {"alice": False, "bob": True, "carol": True, "josé": False, "用户": False, "😀": True}
        self.assertEqual({s: self.flags.enabled("half", s) for s in expected}, expected)
        self.assertTrue(0 <= rollout_bucket("half", "\ud800") < 100)  # lone surrogate hashes like Node (U+FFFD)
        self.assertEqual(rollout_bucket("half", "\ud800"), rollout_bucket("half", "�"))


if __name__ == "__main__":
    unittest.main()
