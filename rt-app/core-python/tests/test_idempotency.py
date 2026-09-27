"""Idempotency port: claims, replay, conflicts, uncertainty and validation."""
from __future__ import annotations

import unittest

from rt_app.errors import Conflict
from rt_app.idempotency import (
    Idempotency,
    IdempotencyError,
    IdempotentModule,
    NoSQLIdempotencyStore,
    create_idempotency,
)
from rt_app.nosql import MemoryStore

NOW = 1767323045678  # 2026-01-02T03:04:05.678Z


class ExecutorTest(unittest.TestCase):
    def setUp(self) -> None:
        self.store = MemoryStore()
        self.executor = create_idempotency(self.store, now=lambda: NOW)
        self.calls: list = []

    def work(self, result):
        def run(context):
            self.calls.append(context)
            return result

        return run

    def code(self, request, work=None) -> str:
        with self.assertRaises(IdempotencyError) as caught:
            self.executor.execute(request, work or self.work(None))
        self.assertEqual(caught.exception.message, "RT-App idempotency: " + caught.exception.code)
        return caught.exception.code

    def test_replay_conflict_and_row_format(self) -> None:
        request = {"scope": "shop:u1:charge:v1", "key": "order-1", "input": {"currency": "USD", "amount": 10}}
        self.assertEqual(self.executor.execute(request, self.work({"id": "paid"})), {"id": "paid"})
        self.assertEqual(self.executor.execute({**request, "input": {"amount": 10, "currency": "USD"}}, self.work(2)), {"id": "paid"})
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.calls[0].idempotency_key, "rtapp-1d70ab84a2b68564ecc7595944c41ee98bb8df1f468c300f39ab1a64eeea9c85")
        row = self.store.get("IDEMPOTENCY#shop:u1:charge:v1", "order-1")
        assert row
        self.assertEqual(row["version"], 2)
        self.assertEqual(row["data"]["fingerprint"], "1748e5b562237637f7af0d4e3d15d118c268e47a60ed8f248142dc1c978dc6c9")
        self.assertEqual(row["data"]["createdAt"], "2026-01-02T03:04:05.678Z")
        self.assertEqual(self.code({**request, "input": {"amount": 11}}), "CONFLICT")

    def test_failures_are_uncertain_and_never_rerun(self) -> None:
        def boom(_):
            raise RuntimeError("gateway timeout")

        request = {"scope": "s", "key": "k", "input": 1}
        with self.assertRaises(IdempotencyError) as caught:
            self.executor.execute(request, boom)
        self.assertEqual(caught.exception.code, "UNCERTAIN")
        self.assertIsInstance(caught.exception.__cause__, RuntimeError)
        self.assertEqual(self.code(request), "UNCERTAIN")
        self.assertEqual(self.calls, [])

    def test_pending_while_running(self) -> None:
        request = {"scope": "s", "key": "k", "input": 1}
        codes = []

        def reenter(_):
            codes.append(self.code(request))
            return "done"

        self.assertEqual(self.executor.execute(request, reenter), "done")
        self.assertEqual(codes, ["PENDING"])

    def test_validation(self) -> None:
        for request in (
            {"scope": "", "key": "k", "input": 1},
            {"scope": "\u00a0\ufeff", "key": "k", "input": 1},
            {"scope": 5, "key": "k", "input": 1},
            {"scope": "s", "key": "😀" * 129, "input": 1},
            {"scope": "", "key": "k"},
        ):
            self.assertEqual(self.code(request), "INVALID_KEY")
        self.assertEqual(self.code({"scope": "s", "key": "k"}), "INVALID_JSON")
        self.assertEqual(self.code({"scope": "s", "key": "k", "input": float("nan")}), "INVALID_JSON")
        self.assertEqual(self.executor.execute({"scope": "\u200b", "key": "k", "input": None}, self.work(None)), None)
        with self.assertRaises(IdempotencyError) as caught:
            Idempotency().init()
        self.assertEqual(caught.exception.code, "NOT_CONFIGURED")
        with self.assertRaises(IdempotencyError):
            IdempotentModule().execute_idempotent({"scope": "s", "key": "k", "input": 1}, self.work(1))


class StoreTest(unittest.TestCase):
    def test_owner_rules(self) -> None:
        adapter = NoSQLIdempotencyStore(MemoryStore(), now=lambda: 0)
        claim = {"scope": "s", "key": "k", "fingerprint": "f", "owner": "a"}
        self.assertEqual(adapter.claim(claim), {"state": "acquired"})
        self.assertEqual(adapter.claim({**claim, "owner": "b"}), {"state": "pending"})
        self.assertEqual(adapter.claim({**claim, "fingerprint": "g"}), {"state": "conflict"})
        with self.assertRaises(Conflict):
            adapter.complete({**claim, "owner": "b"}, 1)
        adapter.complete(claim, None)
        adapter.mark_uncertain(claim)
        self.assertEqual(adapter.claim(claim), {"state": "completed", "result": None})


if __name__ == "__main__":
    unittest.main()
