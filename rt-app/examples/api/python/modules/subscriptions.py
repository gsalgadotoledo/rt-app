"""Subscriptions: plans, accounts, credits and billing (personal endpoints need a session; the
owner endpoints are served under /admin/app/subscriptions/admin/...).

Local mode wires the LocalBilling simulator (no card data, no charges; it refuses to start with
NODE_ENV or RT_APP_ENVIRONMENT set to production) and logs notifications instead of mailing
them. In a real app pass a Stripe provider, a mailer and a catalog factory here.
"""
import logging

from rt_app.subscriptions import LocalBilling, Subscriptions

log = logging.getLogger("subscriptions")


def features(components):
    store = components.store.get()
    service = Subscriptions(store, LocalBilling(store), lambda mail: log.info("mail to %s: %s", mail["to"], mail["subject"]))
    return [service.feature()]
