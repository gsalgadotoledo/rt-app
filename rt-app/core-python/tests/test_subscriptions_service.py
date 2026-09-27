"""The Subscriptions service port (rt_app.subscriptions.service); the contracts in
spec/contracts/subscriptions-{settings,accounts,usage,overview,api} pin the full behavior."""
import hashlib
import json
import unittest

from rt_app import HttpError
from rt_app.nosql import MemoryStore
from rt_app.subscriptions import LocalBilling, Subscriptions, default_settings, plan_id_from_name, validate_settings
from rt_app.subscriptions.feature import MIGRATIONS, migrate
from rt_app.subscriptions.plans import next_version
from rt_app.web import App, Request

T0 = 1767225600000  # 2026-01-01T00:00:00.000Z
DAY = 86400000
ALICE = {"id": "alice", "email": "alice@example.test", "role": "user"}


class Clock:
    def __init__(self, at=T0):
        self.at = at

    def __call__(self):
        return self.at


def service(paid=False, catalog=None):
    store, clock, sent = MemoryStore(), Clock(), []
    ids = iter(f"id-{i}" for i in range(1000))
    svc = Subscriptions(store, LocalBilling(store, clock) if paid else None, sent.append, clock, catalog, new_id=lambda: next(ids))
    return svc, store, clock, sent


def values(**changes):
    settings = default_settings()
    settings.pop("credits")
    return {**settings, **changes}


class SettingsTests(unittest.TestCase):
    def test_plan_ids_follow_names(self):
        self.assertEqual(plan_id_from_name("  Plan Élite!! "), "plan-elite")
        self.assertEqual(plan_id_from_name("Plan Élite", ["plan-elite", "plan-elite-2"]), "plan-elite-3")
        self.assertEqual(plan_id_from_name("¡¿"), "new-plan")
        self.assertEqual(plan_id_from_name("Ｍａｘ  Ⅱ — Ñandú ﬁ"), "max-ii-nandu-fi")
        self.assertEqual(len(plan_id_from_name("ab-" * 40)), 80)
        self.assertEqual(plan_id_from_name("a" * 79 + "-b"), "a" * 79)

    def test_versions_bump_the_last_number(self):
        self.assertEqual([next_version(v) for v in ("0.0.1", "0.0.9", "1.2.99")], ["0.0.2", "0.0.10", "1.2.100"])

    def test_validation_order(self):
        with self.assertRaisesRegex(HttpError, "Invalid subscription settings"):
            validate_settings(None)
        with self.assertRaisesRegex(HttpError, "Duplicate or unnamed plans/products"):
            validate_settings({**values(), "reminderDays": 99, "plans": [values()["plans"][0]] * 2})
        with self.assertRaisesRegex(HttpError, "Invalid numeric setting"):
            validate_settings({**values(), "reminderDays": 31})
        self.assertEqual(validate_settings({**values(), "plans": [{**values()["plans"][0], "metadata": {}}]})["plans"][0]["metadata"], {})

    def test_changed_content_creates_a_version_and_history(self):
        svc, store, _, _ = service()
        plans = values()["plans"]
        saved = svc.save_settings({"version": 0, "values": values(plans=[plans[0], {**plans[1], "amount": 2500}, plans[2]])}, "root")
        self.assertEqual([p["version"] for p in saved["values"]["plans"]], ["0.0.1", "0.0.2", "0.0.1"])
        self.assertEqual(store.get("SUB_PLAN_HISTORY#pro", "0.0.1")["data"]["amount"], 2000)
        with self.assertRaises(HttpError) as stale:
            svc.save_settings({"version": 0, "values": values()}, "root")
        self.assertEqual((stale.exception.status, stale.exception.message), (409, "Conflict: refresh and try again"))
        # Availability alone keeps the version.
        again = svc.save_settings({"version": 1, "values": values(plans=[plans[0], {**plans[1], "amount": 2500, "enabled": False}, plans[2]])}, "root")
        self.assertEqual(again["values"]["plans"][1]["version"], "0.0.2")
        restored = svc.restore_plan("pro", {"version": 2, "fromVersion": "0.0.1"}, "root")
        self.assertEqual((restored["values"]["plans"][1]["amount"], restored["values"]["plans"][1]["version"]), (2000, "0.0.3"))
        self.assertEqual(store.get("SUB_AUDIT", "id-2")["data"], {"action": "settings", "restoredPlan": "pro", "restoredFrom": "0.0.1", "actorId": "root", "at": T0})

    def test_link_stripe_prices(self):
        svc, _, _, _ = service()
        self.assertEqual(svc.link_stripe_prices({"pro": {"productId": "prod_1", "priceId": "price_1"}}, "tf"), ["pro"])
        self.assertEqual(svc.link_stripe_prices({"pro": {"productId": "prod_1", "priceId": "price_1"}}, "tf"), [])
        with self.assertRaisesRegex(HttpError, "one plan only"):
            svc.link_stripe_prices({"max": {"productId": "prod_2", "priceId": "price_1"}}, "tf")

    def test_publication_resumes_after_a_failure(self):
        class Catalog:
            fail = True

            def publish(self, plan, namespace, previous=None):
                if self.fail:
                    raise HttpError(502, "down")
                return {"stripePriceId": "price_p", "stripeProductId": "prod_p"}

        catalog = Catalog()
        svc, store, _, _ = service(catalog=lambda secret: catalog)
        svc.save_settings({"version": 0, "values": values()}, "root")
        with self.assertRaisesRegex(HttpError, "down"):
            svc.publish_plan("pro", {"version": 1}, "root")
        with self.assertRaisesRegex(HttpError, "Resume the pending Stripe synchronization"):
            svc.save_settings({"version": 2, "values": values()}, "root")
        catalog.fail = False
        settings = svc.publish_plan("pro", {}, "root")
        pro = settings["values"]["plans"][1]
        self.assertEqual((pro["stripePriceId"], pro["stripeManaged"], settings["catalogOperation"]), ("price_p", True, None))
        self.assertEqual(store.get("SUB_PLAN_PRICES", "price_p")["data"]["plan"]["id"], "pro")


class AccountTests(unittest.TestCase):
    def test_unpaid_change_consume_and_limits(self):
        svc, store, clock, _ = service()
        self.assertEqual(svc.change(ALICE, "starter", "p1"), {"ok": True})
        self.assertEqual(svc.change(ALICE, "starter", "p1"), {"ok": True})
        with self.assertRaisesRegex(HttpError, "Already subscribed"):
            svc.change(ALICE, "starter", "p2")
        receipt = svc.consume("alice", "api", 60, "u1")
        self.assertEqual((receipt["fromAllowance"], receipt["replayed"]), (60, False))
        self.assertTrue(svc.consume("alice", "api", 60, "u1")["replayed"])
        with self.assertRaises(HttpError) as limit:
            svc.consume("alice", "api", 50, "u2")
        # The reference names the first fully used window (day, week, period), not the binding one.
        self.assertEqual((limit.exception.status, limit.exception.message), (429, "Subscription period limit reached. Add credits or wait for the reset."))
        svc.record_credits("alice", {"requestId": "top", "productId": "api", "credits": 100, "kind": "purchase", "reason": "Top-up", "amountMinor": 1000, "currency": "USD"})
        split = svc.consume("alice", "api", 50, "u2")
        self.assertEqual((split["fromAllowance"], split["fromBalance"]), (40, 10))
        me = svc.me("alice")
        self.assertEqual((me["usage"][0]["used"], me["usage"][0]["extraCredits"], me["active"]), (100, 90, True))
        clock.at = T0 + 31 * DAY
        self.assertEqual(svc.me("alice")["periodStart"], T0 + 30 * DAY)  # unpaid plans renew lazily
        self.assertEqual(store.get("SUB_STATS", "day:2026-01-01")["data"], {"new": 1, "canceled": 0})

    def test_windows_roll_over_into_the_ledger(self):
        svc, _, clock, _ = service()
        svc.change(ALICE, "starter", "p1")
        svc.consume("alice", "api", 100, "u1")
        clock.at = T0 + 7 * DAY + 3600000
        pending = svc.ledger("alice")["pending"]
        self.assertEqual([(e["kind"], e["credits"]) for e in pending], [("expiry", -400), ("allowance", 500)])
        svc.consume("alice", "api", 10, "u2")
        entries = svc.ledger("alice")["entries"]
        self.assertEqual([e["kind"] for e in entries], ["allowance", "plan", "usage", "expiry", "allowance", "usage"])
        self.assertEqual(entries[3]["id"][:27], "001767830400000-0000000004-")

    def test_billing_operations_use_the_provider(self):
        svc, store, _, _ = service(paid=True)
        svc.save_settings({"version": 0, "values": values(paymentRequired=True)}, "root")
        result = svc.change(ALICE, "pro", "pay-1")
        self.assertEqual(result["subscriptionId"], "sub_local_alice")
        fingerprint = hashlib.sha256(json.dumps({"action": "change", "planId": "pro"}, separators=(",", ":")).encode()).hexdigest()
        self.assertEqual(store.get("SUB_BILLING_OP#alice", "pay-1")["data"]["fingerprint"], fingerprint)
        me = svc.me("alice")
        self.assertEqual((me["mode"], me["active"], me["plan"]["id"]), ("local", True, "pro"))
        with self.assertRaisesRegex(HttpError, "Conflict"):
            svc.change(ALICE, "starter", "pay-1")
        self.assertEqual(svc.cancel(ALICE, "c1"), {"ok": True})
        self.assertTrue(svc.me("alice")["cancelAtPeriodEnd"])
        self.assertEqual(svc.billing("alice")["totals"], [{"currency": "usd", "paid": 2000, "due": 0}])

    def test_grants_are_idempotent_and_block_user_changes(self):
        svc, store, _, _ = service()
        store.transact([{"row": {"pk": "USERS", "sk": "alice", "version": 1, "data": {"email": "alice@example.test"}}, "expected": None}])
        grant = {"requestId": "g1", "kind": "plan", "planId": "pro", "reason": " Partner ", "currency": "USD", "valueMinor": 2000}
        self.assertEqual(svc.grant("alice", grant, "root"), {"ok": True})
        self.assertEqual(svc.grant("alice", grant, "root"), {"ok": True})
        stored = store.get("SUB_GRANTS#alice", "g1")["data"]["fingerprint"]
        self.assertEqual(stored, '{"kind":"plan","target":"pro","credits":0,"valueMinor":2000,"currency":"usd","reason":"Partner","actorId":"root"}')
        with self.assertRaisesRegex(HttpError, "administrator-assigned"):
            svc.change(ALICE, "max", "p1")
        self.assertTrue(svc.me("alice")["assignedByAdmin"])

    def test_record_fingerprint_follows_the_input_order(self):
        svc, store, _, _ = service()
        svc.record_credits("alice", {"requestId": "r1", "productId": "api", "credits": 5, "reason": "Gift", "source": "admin", "actorId": "root"})
        text = '{"requestId":"r1","productId":"api","credits":5,"reason":"Gift","source":"admin","actorId":"root","kind":"adjustment"}'
        self.assertEqual(store.get("SUB_LEDGER_OP#alice", "r1")["data"]["fingerprint"], hashlib.sha256(text.encode()).hexdigest())


class OverviewTests(unittest.TestCase):
    def test_overview_and_maintenance(self):
        svc, store, clock, sent = service(paid=True)
        svc.change(ALICE, "starter", "a1")
        svc.save_settings({"version": 0, "values": values(paymentRequired=True)}, "root")
        svc.change({"id": "bob", "email": "bob@example.test"}, "pro", "b1")
        overview = svc.overview()
        self.assertEqual((overview["customers"], overview["paying"], overview["mrrMinor"]), (2, 1, {"usd": 2000}))
        self.assertEqual([p["planId"] for p in overview["plans"]], ["starter", "pro"])
        self.assertEqual(overview["series"][-1], {"month": "2026-01", "customers": 2, "paying": 1, "new": 2, "canceled": 0})
        with self.assertRaisesRegex(HttpError, "Invalid numeric setting"):
            svc.overview(37)
        clock.at = T0 + 28 * DAY
        self.assertEqual(svc.maintenance(), {"processed": 2, "partial": False})
        self.assertEqual([m["to"] for m in sent], ["alice@example.test", "bob@example.test"])
        self.assertEqual(svc.maintenance(), {"processed": 2, "partial": False})
        self.assertEqual(len(sent), 2)


class FeatureTests(unittest.TestCase):
    def test_admin_endpoints_are_mounted_under_admin_app_only(self):
        svc, store, _, _ = service(paid=True)
        app = App([svc.feature()], local_admin=True)
        self.assertEqual(app.handle(Request("GET", "/subscriptions/admin/settings")).status, 404)
        self.assertEqual(app.handle(Request("GET", "/subscriptions/me")).body, {"error": "Sign in"})
        settings = app.handle(Request("GET", "/admin/app/subscriptions/admin/settings"))
        self.assertEqual((settings.status, settings.body["provider"]), (200, "local"))
        webhook = app.handle(Request("POST", "/subscriptions/webhook", raw_body="{}"))
        self.assertEqual((webhook.status, webhook.body), (400, {"error": "Invalid webhook signature"}))
        record = app.handle(
            Request("POST", "/admin/app/subscriptions/admin/accounts/alice/ledger", body={"requestId": "r1", "productId": "api", "credits": 5, "reason": "x", "details": {"o": {}, "n": None}})
        )
        self.assertEqual(record.status, 200)
        entry = store.list("SUB_LEDGER#alice")["items"][0]["data"]
        self.assertEqual((entry["source"], entry["actorId"], entry["details"]), ("admin", "rt-app-root", {"o": "[object Object]", "n": "null"}))

    def test_migrations(self):
        store = MemoryStore()
        migrate(store)
        migrate(store)
        self.assertEqual(store.get("SCHEMA", "subscriptions")["data"], {"schemaVersion": 1})
        self.assertEqual(MIGRATIONS[0]["id"], "subscriptions:001")


if __name__ == "__main__":
    unittest.main()
