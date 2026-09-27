"""Subscriptions: the service (plans, accounts, credits, billing), the credit ledger, credit
settings/pricing and currencies.

Ports of ``@gsalgadotoledo/rt-app-subscriptions`` (``index.ts``, ``local.ts``, ``ledger.ts``,
``plan-id.ts`` and ``currency.ts``) with JavaScript float64 semantics, so every language computes
the same keys, totals, prices and statements. Contracts: ``spec/contracts/subscriptions-*``; see
``docs/polyglot/subscriptions.md``. ``Subscriptions.feature()`` (``rt_app.subscriptions.feature``)
builds the HTTP feature.
"""
from .credits import (
    DEFAULT_CREDITS,
    CreditPricing,
    CreditRate,
    CreditSettings,
    Estimate,
    default_credits,
    estimate,
    validate_credits,
)
from .currency import CURRENCY_CODES, currency_decimals, currency_step, major_amount, valid_currency, valid_minor_amount
from .local import LocalBilling
from .plans import DEFAULTS, default_settings, plan_id_from_name, validate_metadata, validate_settings
from .reservations import (
    MAX_ACTIVE_RESERVATIONS,
    RESERVATION_TTL_MS,
    reservation_key,
    reservations,
    threshold_of,
    window_usage,
)
from .service import BillingProvider, CatalogPublisher, Subscriptions
from .ledger import (
    LEDGER,
    CurrentWindow,
    LedgerEntry,
    LedgerTotals,
    WindowState,
    apply_totals,
    empty_totals,
    ledger,
    ledger_key,
    ledger_write,
    rollover,
    used_from,
)

__all__ = [
    "Subscriptions",
    "BillingProvider",
    "CatalogPublisher",
    "LocalBilling",
    "DEFAULTS",
    "default_settings",
    "plan_id_from_name",
    "validate_metadata",
    "validate_settings",
    "DEFAULT_CREDITS",
    "CreditPricing",
    "CreditRate",
    "CreditSettings",
    "Estimate",
    "default_credits",
    "estimate",
    "validate_credits",
    "CURRENCY_CODES",
    "currency_decimals",
    "currency_step",
    "major_amount",
    "valid_currency",
    "valid_minor_amount",
    "LEDGER",
    "CurrentWindow",
    "LedgerEntry",
    "LedgerTotals",
    "WindowState",
    "apply_totals",
    "empty_totals",
    "ledger",
    "ledger_key",
    "ledger_write",
    "rollover",
    "used_from",
    "MAX_ACTIVE_RESERVATIONS",
    "RESERVATION_TTL_MS",
    "reservation_key",
    "reservations",
    "threshold_of",
    "window_usage",
]
