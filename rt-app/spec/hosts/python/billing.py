"""Subjects: subscriptions-ledger, subscriptions-credits (mirrors hosts/node/billing.mjs).

Thin adapters over rt_app.subscriptions. Contract method names are camelCase and the host maps
them to snake_case (``LEDGER`` becomes ``ledger``). Wire null means "not given".
"""
from __future__ import annotations

from typing import Any

from rt_app.subscriptions import (
    CreditPricing,
    apply_totals,
    currency_decimals,
    default_credits,
    empty_totals,
    ledger,
    ledger_key,
    ledger_write,
    rollover,
    used_from,
    valid_currency,
    valid_minor_amount,
    validate_credits,
)
from rt_app._jsnum import truthy


class Ledger:
    """Stateless facade over the pure ledger functions; ``init`` is ignored."""

    def empty_totals(self) -> Any:
        return empty_totals()

    def ledger(self, user_id: str) -> str:
        return ledger(user_id)

    def ledger_key(self, at: float, seed: str, sequence: float | None = None) -> str:
        return ledger_key(at, seed, sequence)

    def ledger_write(self, user_id: str, entry: Any, seed: str, sequence: float | None = None) -> Any:
        return ledger_write(user_id, entry, seed, sequence)

    def apply_totals(self, totals: Any, entry: Any) -> Any:
        return apply_totals(totals, entry)

    def rollover(self, previous: Any, current: Any, used: Any, now: float) -> Any:
        # `used` travels as a table {productId: {"<start>": credits}}; missing entries are 0.
        return rollover(previous, current, used_from(used), now)


class Credits:
    """Credit settings and pricing, built from init.credits (validated) or the defaults."""

    def __init__(self, init: Any) -> None:
        stored = init.get("credits") if isinstance(init, dict) else None
        self.pricing = CreditPricing(stored if truthy(stored) else None)  # JavaScript `init.credits ? …`

    def defaults(self) -> Any:
        return default_credits()

    def validate_credits(self, settings: Any) -> Any:
        return validate_credits(settings)

    def estimate(self, request: Any) -> Any:
        # Pricing only: the account preview (userId/productId) is not part of the contract.
        request = request if isinstance(request, dict) else {}
        return self.pricing.estimate(request.get("rateId"), request.get("inputTokens"), request.get("outputTokens"))

    def valid_currency(self, code: Any) -> bool:
        return valid_currency(code)

    def currency_decimals(self, code: str) -> int:
        return currency_decimals(code)

    def valid_minor_amount(self, amount: Any, code: str) -> bool:
        return valid_minor_amount(amount, code)


SUBJECTS = {
    "subscriptions-ledger": lambda init: Ledger(),
    "subscriptions-credits": Credits,
}
