"""Service keys, the web layer's service access and finance limits beyond the contracts
(spec/contracts/service-keys*, subscriptions-limits*, subscriptions-economics)."""
import json
import os
import tempfile
import unittest

from rt_app import HttpError, ServiceKeys, service_keys_from_env
from rt_app.nosql import MemoryStore
from rt_app.service_keys import parse_service_keys, service_key_hash
from rt_app.subscriptions import Subscriptions
from rt_app.subscriptions.feature import METER
from rt_app.web import App, Endpoint, Feature, Request
from rt_app.web.app import admin_only

SECRET = "service-keys-test-secret-0123456789abcdef"
TOKEN = "rtsk_agent.envsecret-envsecret-envsecret-0123"
CONFIG = [{"id": "agent", "secretHash": service_key_hash(TOKEN), "scopes": [METER]}]


def request(method, path, token=None, body=None):
    headers = {"authorization": "Bearer " + token} if token else {}
    return Request(method=method, path=path, body=body or {}, headers=headers)


class EnvTest(unittest.TestCase):
    def test_reads_json_or_a_secrets_file(self):
        self.assertIsNone(service_keys_from_env({}))
        self.assertIsNone(service_keys_from_env({"RT_APP_SERVICE_KEYS": "  "}))
        self.assertEqual(service_keys_from_env({"RT_APP_SERVICE_KEYS": json.dumps(CONFIG)}), CONFIG)
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as file:
            json.dump(CONFIG, file)
        try:
            self.assertEqual(service_keys_from_env({"RT_APP_SERVICE_KEYS_FILE": file.name}), CONFIG)
            # The variable wins over the file.
            self.assertEqual(service_keys_from_env({"RT_APP_SERVICE_KEYS": "[]", "RT_APP_SERVICE_KEYS_FILE": file.name}), [])
        finally:
            os.unlink(file.name)
        with self.assertRaises(HttpError) as error:
            service_keys_from_env({"RT_APP_SERVICE_KEYS": "{nope"})
        self.assertEqual((error.exception.status, error.exception.message), (400, "Invalid service key configuration"))

    def test_parse_hashes_plain_secrets(self):
        [key] = parse_service_keys([{"id": "agent", "secret": "envsecret-envsecret-envsecret-0123", "scopes": [METER]}], [METER])
        self.assertEqual(key["secretHash"], service_key_hash(TOKEN))
        self.assertEqual(key["rateLimit"], 600)

    def test_invalid_configuration_fails_on_validate(self):
        keys = ServiceKeys(MemoryStore(), SECRET, keys=[{"id": "x"}], scopes=[METER])
        with self.assertRaises(HttpError):
            keys.validate()

    def test_scopes_may_be_a_function(self):
        keys = ServiceKeys(MemoryStore(), SECRET, keys=CONFIG, scopes=lambda: [METER])
        self.assertEqual(keys.validate(), ["agent"])
        self.assertEqual(keys.list()["scopes"], [METER])

    def test_default_random_ids_and_tokens(self):
        keys = ServiceKeys(MemoryStore(), SECRET, scopes=[METER])
        created = keys.create({"description": "Agent", "scopes": [METER]}, "root")
        self.assertRegex(created["key"]["id"], r"^[A-Za-z0-9_-]{12}$")
        self.assertRegex(created["token"], r"^rtsk_[A-Za-z0-9_-]{12}\.[A-Za-z0-9_-]{43}$")
        self.assertEqual(keys.actor("Bearer " + created["token"])["id"], "service:" + created["key"]["id"])


class WebTest(unittest.TestCase):
    def app(self, service=True):
        store = MemoryStore()
        keys = ServiceKeys(store, SECRET, keys=CONFIG, scopes=["service-keys.self", METER])
        subscriptions = Subscriptions(store)
        features = [keys.feature(), subscriptions.feature()]
        return App(features, local_admin=True, service=keys if service else None)

    def test_admin_only_and_service_routes(self):
        self.assertTrue(admin_only(Endpoint("GET", "/service-keys", "x", "owner", lambda c: None)))
        app = self.app()
        paths = {(e.method, e.path) for e in app.endpoints}
        self.assertIn(("GET", "/admin/app/service-keys"), paths)
        self.assertNotIn(("GET", "/service-keys"), paths)
        self.assertIn(("GET", "/service/subscriptions/accounts/:id/usage"), paths)
        self.assertFalse(any(p.startswith("/admin/app/service/") for _, p in paths))

    def test_service_paths_are_reserved(self):
        with self.assertRaises(ValueError):
            App([Feature(id="x", endpoints=[Endpoint("GET", "/service/x", "x", "authenticated", lambda c: None)])])
        with self.assertRaises(ValueError):
            App([Feature(id="x", endpoints=[Endpoint("GET", "/x", "x", "service", lambda c: None)])])

    def test_service_endpoints_take_only_service_keys(self):
        app = self.app()
        path = "/service/subscriptions/accounts/u1/usage"
        self.assertEqual(app.handle(request("GET", path)).body, {"error": "Service key required"})
        self.assertEqual(app.handle(request("GET", path, "nope")).status, 401)
        ok = app.handle(request("GET", path, TOKEN))
        self.assertEqual((ok.status, ok.body["userId"]), (200, "u1"))
        self.assertEqual(app.handle(request("GET", "/service/keys/self", TOKEN)).body, {"error": "Service key not allowed for this resource"})

    def test_without_a_policy_service_endpoints_answer_401(self):
        app = self.app(service=False)
        path = "/service/subscriptions/accounts/u1/usage"
        self.assertEqual(app.handle(request("GET", path)).body, {"error": "Service key required"})
        self.assertEqual(app.handle(request("GET", path, TOKEN)).body, {"error": "Invalid service key"})


class LimitsTest(unittest.TestCase):
    def test_margin_and_economics_without_rules(self):
        service = Subscriptions(MemoryStore(), now=lambda: 1767225600000)
        service.change({"id": "u1", "email": "u1@example.test"}, "starter", "p1")
        self.assertIsNone(service.usage_summary("u1")["margin"])
        result = service.preflight("u1", "api", {"estimate": {"rateId": "standard", "inputTokens": 1000}})
        self.assertEqual((result["costMinor"], result["model"], result["margin"], result["degrade"]), (None, None, None, None))
        economics = service.economics()
        self.assertEqual(economics["users"], [{"userId": "u1", "planId": "starter", "costMinor": {}, "revenueMinor": {}, "marginMinor": {}, "periodCostMinor": 0, "capMinor": None}])

    def test_http_economics_limit_query(self):
        service = Subscriptions(MemoryStore(), now=lambda: 1767225600000)
        app = App([service.feature()], local_admin=True)
        self.assertEqual(app.handle(request("GET", "/admin/app/subscriptions/admin/economics")).status, 200)
        self.assertEqual(app.handle(Request(method="GET", path="/admin/app/subscriptions/admin/economics", query={"limit": "0"})).status, 400)


if __name__ == "__main__":
    unittest.main()
