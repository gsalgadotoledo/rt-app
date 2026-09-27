"""Local payment simulator (port of ``packages/subscriptions/src/local.ts``).

Explicit simulation: no card numbers, no real charges, persisted in the selected store. It refuses
to start in production (``NODE_ENV`` or ``RT_APP_ENVIRONMENT`` set to ``production``).
"""
from __future__ import annotations

import copy
import os
from collections.abc import Mapping
from typing import Any, Literal

from ..contracts import Clock, epoch_ms
from ..errors import HttpError
from ..nosql import NoSQL


class LocalBilling:
    """``BillingProvider`` in mode ``"local"``: subscriptions, invoices and payment states live in
    ``LOCAL_BILLING/<customer>`` and ``LOCAL_BILLING_OP#<customer>/<key>``."""

    mode: Literal["local"] = "local"
    publishable_key = None

    def __init__(self, store: NoSQL, now: Clock | None = None) -> None:
        if "production" in (os.environ.get("NODE_ENV"), os.environ.get("RT_APP_ENVIRONMENT")):
            raise RuntimeError("Local billing cannot run in production")
        self.store = store
        self._clock = now

    def _now(self) -> float:
        return epoch_ms(self._clock)

    def customer(self, user: Mapping[str, Any], key: str) -> str:
        return "local_" + str(user.get("id"))

    def change(self, customer: str, plan: Mapping[str, Any], subscription_id: str | None, key: str) -> dict[str, Any]:
        existing = self.store.get("LOCAL_BILLING_OP#" + customer, key)
        if existing is not None:
            return existing["data"]
        old = self.store.get("LOCAL_BILLING", customer)
        now = self._now()
        data = old["data"] if old else {}
        continuing = data.get("status") == "active" and _gt(data.get("periodEnd"), now)
        invoice = {
            "id": "sim_" + key,
            "number": "SIMULATION",
            "status": "paid",
            "amountPaid": plan.get("amount"),
            "amountDue": 0,
            "currency": plan.get("currency"),
            "createdAt": now,
        }
        result = {"subscriptionId": "sub_" + customer, "status": "active", "clientSecret": None}
        price = plan.get("stripePriceId")
        self.store.transact(
            [
                {
                    "row": {
                        "pk": "LOCAL_BILLING",
                        "sk": customer,
                        "version": (old["version"] if old else 0) + 1,
                        "data": {
                            **data,
                            **result,
                            "priceId": plan.get("id") if price is None else price,
                            "plan": copy.deepcopy(dict(plan)),
                            "periodStart": data["periodStart"] if continuing else now,
                            "periodEnd": data["periodEnd"] if continuing else now + plan["periodDays"] * 86400000,
                            "invoices": [invoice, *(data.get("invoices") or [])],
                            "paymentMethods": [{"brand": "simulation", "last4": "0000"}],
                            "cancelAtPeriodEnd": False,
                        },
                    },
                    "expected": old["version"] if old else None,
                },
                {"row": {"pk": "LOCAL_BILLING_OP#" + customer, "sk": key, "version": 1, "data": result}, "expected": None},
            ]
        )
        return dict(result)

    def setup(self, customer: str, key: str) -> dict[str, Any]:
        return {"simulated": True}

    def set_payment_method(self, customer: str, setup_id: str, subscription_id: str | None = None) -> None:
        return None

    def cancel(self, customer: str, subscription_id: str | None = None, key: str | None = None) -> dict[str, Any]:
        old = self.store.get("LOCAL_BILLING", customer)
        if old is None:
            raise HttpError(404, "No subscription")
        self.store.transact(
            [{"row": {**old, "version": old["version"] + 1, "data": {**old["data"], "cancelAtPeriodEnd": True}}, "expected": old["version"]}]
        )
        return {"ok": True}

    def snapshot(self, customer: str, subscription_id: str | None = None) -> dict[str, Any]:
        row = self.store.get("LOCAL_BILLING", customer)
        if row is None:
            return {"invoices": [], "paymentMethods": [], "totals": []}
        data = copy.deepcopy(row["data"])
        totals: dict[str, dict[str, Any]] = {}
        for invoice in data.get("invoices") or []:
            bucket = totals.setdefault(invoice.get("currency"), {"paid": 0, "due": 0})
            bucket["paid"] += invoice.get("amountPaid")
            bucket["due"] += invoice.get("amountDue")
        if data.get("cancelAtPeriodEnd") and _ge(self._now(), data.get("periodEnd")):
            data["status"] = "canceled"
        return {**data, "simulated": True, "totals": [{"currency": currency, **v} for currency, v in totals.items()]}

    def verify(self, raw: str, signature: str) -> Any:
        raise RuntimeError("Local simulation does not accept Stripe webhooks")

    def simulate(self, customer: str, status: Any) -> None:
        if status not in ("active", "past_due", "canceled"):
            raise HttpError(400, "Invalid simulated state")
        row = self.store.get("LOCAL_BILLING", customer)
        if row is None:
            raise HttpError(404, "No simulated subscription")
        self.store.transact([{"row": {**row, "version": row["version"] + 1, "data": {**row["data"], "status": status}}, "expected": row["version"]}])


def _gt(a: Any, b: Any) -> bool:
    """JavaScript ``a > b`` for numbers; undefined compares false."""
    return a is not None and b is not None and a > b


def _ge(a: Any, b: Any) -> bool:
    return a is not None and b is not None and a >= b


__all__ = ["LocalBilling"]
