"""Credit reservations of the Subscriptions service (the contract is
spec/contracts/subscriptions-reservations.contract.yaml; these tests cover the Python specifics:
threads racing, injected store failures at every write, random sequences)."""
from __future__ import annotations

import random
import threading
import unittest

from rt_app import HttpError
from rt_app.nosql import MemoryStore
from rt_app.subscriptions import RESERVATION_TTL_MS, Subscriptions, reservation_key, threshold_of, window_usage
from rt_app.subscriptions.reservations import reservation_reason, reservation_ttl, same_usage, settle_usage
from rt_app.web import App, Request

T0 = 1767225600000  # 2026-01-01T00:00:00.000Z
ALICE = {"id": "alice", "email": "alice@example.test", "role": "user"}


class Clock:
    def __init__(self, at=T0):
        self.at = at

    def __call__(self):
        return self.at


class FailingStore(MemoryStore):
    """A memory store whose next transactions fail before or after committing."""

    def __init__(self):
        super().__init__()
        self.failures: list[str] = []
        self.writes = 0

    def transact(self, writes):
        self.writes += 1
        mode = self.failures.pop(0) if self.failures else None
        if mode == "before":
            raise HttpError(503, "Injected store failure")
        super().transact(writes)
        if mode == "after":
            raise HttpError(503, "Injected store failure")


def service():
    store, clock = FailingStore(), Clock()
    return Subscriptions(store, None, None, clock), store, clock


def check(test, store, user_id="alice"):
    """The ledger sum is the balance, holds match the account, nothing is negative."""
    entries, cursor = [], None
    while True:
        page = store.list("SUB_LEDGER#" + user_id, cursor)
        entries.extend(r["data"] for r in page["items"])
        cursor = page.get("cursor")
        if not cursor:
            break
    row = store.get("SUB_ACCOUNTS", user_id)
    account = row["data"] if row else {}
    windows = account.get("ledgerWindows") or {}
    counters = (account.get("adminGrant") or {}).get("counters") if str(windows.get("key", "")).startswith("admin:") else account.get("counters")
    counters = counters or {}
    allowance = sum(
        w["allowance"] - ((counters.get(p) or {}).get("week", 0) if (counters.get(p) or {}).get("weekStart") == w["start"] else 0)
        for p, w in (windows.get("products") or {}).items()
    )
    additional = sum((account.get("creditBalance") or {}).values())
    test.assertEqual(sum(e["credits"] for e in entries), allowance + additional)
    test.assertEqual(sum(e.get("held") or 0 for e in entries), sum(h["credits"] for h in account.get("reservations") or []))
    for entry in entries:
        test.assertGreaterEqual(entry.get("available", 0), 0)
    for value in (account.get("creditBalance") or {}).values():
        test.assertGreaterEqual(value, 0)
    return entries, account


class HelperTests(unittest.TestCase):
    def test_keys_ttls_reasons_usage_and_thresholds(self):
        self.assertEqual(reservation_key("turn-1:0.a_b"), "turn-1:0.a_b")
        for bad in ("", "bad key", "x" * 129, 5, None):
            with self.assertRaisesRegex(HttpError, "Invalid reservation key"):
                reservation_key(bad)
        self.assertEqual((reservation_ttl(None), reservation_ttl(1000), reservation_ttl(1000.0)), (RESERVATION_TTL_MS, 1000, 1000.0))
        for bad in (999, 86400001, 1000.5, "1000", True):
            with self.assertRaisesRegex(HttpError, "Invalid reservation TTL"):
                reservation_ttl(bad)
        self.assertEqual((reservation_reason(None), reservation_reason(" Chat ")), (None, "Chat"))
        for bad in (" ", "r" * 301):
            with self.assertRaisesRegex(HttpError, "short reason"):
                reservation_reason(bad)
        self.assertEqual([threshold_of(p) for p in (0, 79, 80, 94, 95, 99, 100, 250)], [0, 0, 80, 80, 95, 95, 100, 100])
        self.assertEqual(window_usage("day", 60, 25, 100, 9), {"kind": "day", "used": 60, "reserved": 25, "limit": 100, "remaining": 15, "percent": 85, "threshold": 80, "resetAt": 9})
        self.assertEqual(window_usage("week", 0, 0, 0, 1)["percent"], 100)
        self.assertEqual(settle_usage({"inputTokens": 5}), {"inputTokens": 5, "outputTokens": 0})
        for bad in (None, {}, {"outputTokens": 1}):
            with self.assertRaisesRegex(HttpError, "Give credits or token usage"):
                settle_usage(bad)
        for bad in ({"credits": -1}, {"credits": True}, {"inputTokens": 1, "outputTokens": 1.5}):
            with self.assertRaisesRegex(HttpError, "Invalid numeric setting"):
                settle_usage(bad)
        self.assertTrue(same_usage({"credits": 1}, {"credits": 1}))
        self.assertFalse(same_usage({"credits": 1}, {"inputTokens": 1, "outputTokens": 0}))


class ReservationTests(unittest.TestCase):
    def test_reserve_settle_release_and_idempotency(self):
        svc, store, _ = service()
        with self.assertRaises(HttpError) as inactive:
            svc.reserve("alice", "api", {"key": "t:1", "credits": 1})
        self.assertEqual(inactive.exception.status, 402)
        svc.change(ALICE, "starter", "plan")
        reserved = svc.reserve("alice", "api", {"key": "turn-1:0", "estimate": {"rateId": "standard", "inputTokens": 12000, "maxOutputTokens": 8000}})
        self.assertEqual((reserved["credits"], reserved["available"], reserved["expiresAt"]), (36, 64, T0 + RESERVATION_TTL_MS))
        with self.assertRaisesRegex(HttpError, "limit reached"):
            svc.consume("alice", "api", 65, "u1")
        svc.consume("alice", "api", 64, "u1")
        settled = svc.settle("alice", "turn-1:0", {"inputTokens": 12000, "outputTokens": 2000})
        self.assertEqual((settled["used"], settled["credits"], settled["available"]), (18, 18, 18))
        self.assertEqual(svc.settle("alice", "turn-1:0", {"inputTokens": 12000, "outputTokens": 2000}), {**settled, "replayed": True})
        with self.assertRaisesRegex(HttpError, "different usage"):
            svc.settle("alice", "turn-1:0", {"credits": 18})
        with self.assertRaisesRegex(HttpError, "already settled"):
            svc.release("alice", "turn-1:0")
        with self.assertRaisesRegex(HttpError, "different amounts"):
            svc.reserve("alice", "api", {"key": "turn-1:0", "credits": 35})
        svc.reserve("alice", "api", {"key": "r1", "credits": 5, "reason": "Batch"})
        self.assertEqual(svc.release("alice", "r1")["status"], "released")
        self.assertTrue(svc.release("alice", "r1")["replayed"])
        with self.assertRaisesRegex(HttpError, "was released"):
            svc.settle("alice", "r1", {"credits": 1})
        svc.reserve("alice", "api", {"key": "r2", "credits": 5})
        with self.assertRaisesRegex(HttpError, "with credits"):
            svc.settle("alice", "r2", {"inputTokens": 1})
        self.assertEqual(svc.settle("alice", "r2", {"credits": 0})["credits"], 0)
        entries, _ = check(self, store)
        self.assertEqual([e["kind"] for e in entries][-3:], ["release", "reservation", "settlement"])
        self.assertEqual(entries[-1]["credits"], 0)

    def test_expiry_crash_resume_and_maintenance(self):
        svc, store, clock = service()
        svc.change(ALICE, "starter", "plan")
        svc.reserve("alice", "api", {"key": "turn-9:2", "estimate": {"rateId": "advanced", "inputTokens": 2000, "maxOutputTokens": 1000}, "ttlMs": 60000})
        svc.reserve("alice", "api", {"key": "e2", "credits": 10, "ttlMs": 60000})
        clock.at += 60000
        self.assertEqual(svc.usage_summary("alice")["products"][0]["reserved"], 0)
        settled = svc.settle("alice", "turn-9:2", {"inputTokens": 2000, "outputTokens": 400})
        self.assertEqual((settled["credits"], settled["expired"]), (16, True))
        svc.reserve("alice", "api", {"key": "e3", "credits": 5, "ttlMs": 1000})
        clock.at += 1000
        self.assertEqual(svc.release("alice", "e3")["status"], "expired")
        self.assertEqual(svc.maintenance(), {"processed": 1, "partial": False})
        self.assertEqual(store.get("SUB_RESERVATION#alice", "e2")["data"]["status"], "expired")
        self.assertEqual(store.get("SUB_ACCOUNTS", "alice")["data"]["reservations"], [])
        check(self, store)

    def test_admin_granted_plans_are_swept_by_maintenance(self):
        svc, store, clock = service()
        store.transact([{"row": {"pk": "USERS", "sk": "bob", "version": 1, "data": {"id": "bob", "email": "bob@example.test"}}, "expected": None}])
        svc.grant("bob", {"requestId": "g", "kind": "plan", "planId": "pro", "reason": "Pilot", "currency": "usd", "valueMinor": 0}, "root")
        svc.reserve("bob", "api", {"key": "b", "credits": 900, "ttlMs": 1000})
        self.assertEqual(svc.preflight("bob", "api", {"credits": 101})["missing"], 1)
        clock.at += 1000
        svc.maintenance()
        _, account = check(self, store, "bob")
        self.assertEqual(account["reservations"], [])

    def test_threads_racing_for_the_last_credits(self):
        svc, store, _ = service()
        svc.change(ALICE, "starter", "plan")
        svc.consume("alice", "api", 40, "u0")
        results: list[object] = []
        barrier = threading.Barrier(3)

        def call(fn):
            barrier.wait()
            try:
                results.append(fn())
            except HttpError as error:
                results.append(error)

        threads = [
            threading.Thread(target=call, args=(lambda: svc.reserve("alice", "api", {"key": "a", "credits": 60}),)),
            threading.Thread(target=call, args=(lambda: svc.reserve("alice", "api", {"key": "b", "credits": 60}),)),
            threading.Thread(target=call, args=(lambda: svc.consume("alice", "api", 60, "u1"),)),
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(sum(1 for r in results if isinstance(r, dict)), 1)
        self.assertTrue(all(r.status == 429 for r in results if isinstance(r, HttpError)))
        check(self, store)

    def test_preflight_thresholds_and_payment(self):
        from rt_app.subscriptions import LocalBilling, default_settings

        svc, store, _ = service()
        self.assertEqual(svc.preflight("alice", "api", {"credits": 10})["reason"], "inactive")
        svc.change(ALICE, "starter", "plan")
        self.assertEqual(svc.preflight("alice", "gpu", {"credits": 1})["reason"], "product")
        svc.consume("alice", "api", 70, "u1")
        svc.reserve("alice", "api", {"key": "t", "credits": 10})
        self.assertEqual(svc.usage_summary("alice")["alerts"], [{"productId": "api", "window": "day", "percent": 80, "threshold": 80}])
        svc.consume("alice", "api", 15, "u2")
        short = svc.preflight("alice", "api", {"credits": 10})
        self.assertEqual((short["reason"], short["missing"], short["topUp"]), ("credits", 5, {"credits": 5, "packs": 1, "amountMinor": 1000, "valueMinor": 5, "currency": "usd"}))
        self.assertTrue(svc.preflight("alice", "api", {"estimate": {"rateId": "standard", "inputTokens": 1000, "maxOutputTokens": 1000}})["fits"])
        with self.assertRaisesRegex(HttpError, "Give credits or an estimate"):
            svc.preflight("alice", "api", {"estimate": [1]})
        paid_store = MemoryStore()
        paid = Subscriptions(paid_store, LocalBilling(paid_store, Clock()), None, Clock())
        paid.change(ALICE, "starter", "plan")
        settings = default_settings()
        settings["paymentRequired"] = True
        paid.save_settings({"version": 0, "values": settings}, "root")
        self.assertEqual(paid.preflight("alice", "api", {"credits": 1})["reason"], "payment")
        self.assertFalse(paid.usage_summary("alice")["active"])

    def test_injected_failures_at_every_write_point(self):
        scenario = [
            lambda s: s.change(ALICE, "starter", "plan"),
            lambda s: s.record_credits("alice", {"requestId": "pi", "productId": "api", "credits": 30, "reason": "Top-up"}),
            lambda s: s.reserve("alice", "api", {"key": "a", "credits": 50}),
            lambda s: s.reserve("alice", "api", {"key": "b", "estimate": {"rateId": "standard", "inputTokens": 10000, "maxOutputTokens": 5000}}),
            lambda s: s.consume("alice", "api", 20, "u1"),
            lambda s: s.settle("alice", "a", {"credits": 45}),
            lambda s: s.release("alice", "b"),
            lambda s: s.reserve("alice", "api", {"key": "c", "credits": 30, "ttlMs": 1000}),
        ]

        def run(point=None, mode=None):
            svc, store, clock = service()
            for step in scenario:
                if point is not None and store.writes == point:
                    store.failures.append(mode)
                try:
                    step(svc)
                except HttpError as error:
                    self.assertEqual(error.message, "Injected store failure")
                    step(svc)
            clock.at += 1000
            svc.settle("alice", "c", {"credits": 12})
            entries, account = check(self, store)
            return [(e["kind"], e["credits"], e.get("held"), e.get("requestId")) for e in entries], account["creditBalance"], account["counters"]

        clean = run()
        for point in range(12):
            for mode in ("before", "after"):
                self.assertEqual(run(point, mode), clean, f"failure {mode} write {point}")

    def test_random_sequences_keep_the_ledger_balanced(self):
        rng = random.Random(7)
        for round_ in range(10):
            svc, store, clock = service()
            svc.change(ALICE, "starter" if round_ % 2 else "pro", "plan")
            keys: list[str] = []
            for step in range(40):
                key = f"k{round_}-{step}"
                action = rng.randrange(8)
                try:
                    if action == 0:
                        svc.reserve("alice", "api", {"key": key, "credits": 1 + rng.randrange(120), "ttlMs": 1000 + rng.randrange(4) * 3600000})
                        keys.append(key)
                    elif action == 1 and keys:
                        svc.settle("alice", rng.choice(keys), {"credits": rng.randrange(150)})
                    elif action == 2 and keys:
                        svc.release("alice", rng.choice(keys))
                    elif action == 3:
                        svc.consume("alice", "api", 1 + rng.randrange(60), key)
                    elif action == 4:
                        svc.record_credits("alice", {"requestId": key, "productId": "api", "credits": 1 + rng.randrange(80), "reason": "Top-up"})
                    elif action == 5:
                        clock.at += rng.randrange(3) * 3600000 + rng.randrange(2) * 86400000
                    elif action == 6:
                        svc.maintenance()
                    else:
                        svc.reserve("alice", "api", {"key": key, "estimate": {"rateId": "advanced", "inputTokens": rng.randrange(9000), "maxOutputTokens": rng.randrange(4000)}})
                        keys.append(key)
                except HttpError as error:
                    self.assertIn(error.status, (402, 409, 429))
                check(self, store)

    def test_http_endpoints_keep_user_and_backend_reservations_apart(self):
        svc, store, _ = service()
        svc.change(ALICE, "starter", "plan")
        app = App([svc.feature()], local_admin=True, authenticate=lambda request: ALICE if request.headers.get("authorization") == "alice" else None)
        auth = {"authorization": "alice"}

        def post(path, body=None, headers=None):
            return app.handle(Request("POST", path, body=body or {}, headers=headers or {}))

        mine = post("/subscriptions/credits/reservations", {"key": "u:1", "productId": "api", "credits": 10, "extra": 1}, auth)
        self.assertEqual((mine.status, mine.body["status"]), (200, "active"))
        self.assertEqual(post("/subscriptions/credits/reservations", {"key": "u:1", "productId": "api", "credits": 10}).status, 401)
        backend = post("/admin/app/subscriptions/admin/accounts/alice/reservations", {"key": "s:1", "productId": "api", "credits": 5})
        self.assertEqual(backend.status, 200)
        self.assertEqual(post("/subscriptions/credits/reservations/s:1/release", headers=auth).body, {"error": "Reservation not found"})
        self.assertEqual(post("/subscriptions/credits/reservations/u%3A1/settle", {"credits": 4}, auth).body["credits"], 4)
        self.assertEqual(post("/admin/app/subscriptions/admin/accounts/alice/reservations/s:1/settle", {"credits": 5}).body["credits"], 5)
        post("/subscriptions/credits/reservations", {"key": "u:2", "productId": "api", "credits": 1}, auth)
        self.assertEqual(post("/subscriptions/credits/reservations/u:2/release", headers=auth).body["status"], "released")
        post("/admin/app/subscriptions/admin/accounts/alice/reservations", {"key": "s:2", "productId": "api", "credits": 1})
        self.assertEqual(post("/admin/app/subscriptions/admin/accounts/alice/reservations/s:2/release").body["status"], "released")
        self.assertTrue(post("/subscriptions/credits/preflight", {"productId": "api", "credits": 1}, auth).body["fits"])
        self.assertTrue(post("/admin/app/subscriptions/admin/accounts/alice/preflight", {"productId": "api", "credits": 1}).body["fits"])
        self.assertEqual(app.handle(Request("GET", "/subscriptions/credits/usage", headers=auth)).body["userId"], "alice")
        self.assertEqual(app.handle(Request("GET", "/admin/app/subscriptions/admin/accounts/alice/usage")).body["userId"], "alice")
        self.assertEqual(app.handle(Request("GET", "/subscriptions/admin/accounts/alice/usage")).status, 404)
        entries, _ = check(self, store)
        self.assertEqual([(e["source"], e.get("actorId")) for e in entries if e["kind"] == "reservation"][:2], [("user", "alice"), ("api", "rt-app-root")])


if __name__ == "__main__":
    unittest.main()
