"""Subject: subscriptions (the Subscriptions service; mirrors hosts/node/subscriptions.mjs).

A facade over a MemoryStore, an optional LocalBilling, a fake catalog publisher and a settable
clock, with the surface documented in spec/contracts/subscriptions-settings.contract.yaml and
docs/polyglot/subscriptions.md. Wire null means "not given" for optional arguments.
"""
from __future__ import annotations

import re
from typing import Any

from identity import _Clock, _init
from storage import memory_store, rows_of

from rt_app import HttpError
from rt_app._canonical import canonical
from rt_app.subscriptions import LocalBilling, Subscriptions
from rt_app.subscriptions.feature import MIGRATIONS
from rt_app.web import Context, Request
from rt_app.web.app import DEFAULT_BODY_LIMIT, decode_uri_component

_DEFAULT_NOW = "2026-01-01T00:00:00.000Z"


def _fail(kind: str) -> Exception:
    return TypeError("Not JSON")


class _Catalog:
    """Deterministic publisher: ids from the plan id and version; "fail" mode raises 502."""

    def __init__(self) -> None:
        self.mode = "ok"
        self.published: list[dict[str, Any]] = []

    def publish(self, plan: Any, namespace: Any, previous: Any = None) -> dict[str, str]:
        if self.mode == "fail":
            raise HttpError(502, "Catalog unavailable")
        self.published.append(
            {
                "planId": plan["id"],
                "version": plan.get("version"),
                "previousVersion": previous.get("version") if isinstance(previous, dict) else None,
                "namespace": "string" if isinstance(namespace, str) else type(namespace).__name__,
            }
        )
        version = plan.get("version")
        suffix = plan["id"].replace("-", "_") + "_" + ("0.0.1" if version is None else str(version)).replace(".", "_")
        return {"stripePriceId": "price_" + suffix, "stripeProductId": "prod_" + suffix}


class SubscriptionsFacade:
    def __init__(self, init: Any) -> None:
        init = _init(init)
        self._clock = _Clock(init.get("now") or _DEFAULT_NOW)
        self._store = memory_store(rows_of(init))
        self._sent: list[dict[str, Any]] = []
        self._catalog = _Catalog()
        billing = LocalBilling(self._store, self._clock.now) if init.get("billing") == "local" else None
        self.service = Subscriptions(
            self._store,
            billing,
            self._sent.append,
            self._clock.now,
            (lambda secret: self._catalog) if init.get("catalog") is True else None,
        )
        self._feature = self.service.feature()

    # Settings and catalog
    def settings(self) -> Any:
        return self.service.settings()

    def save_settings(self, input: Any, actor_id: Any) -> Any:
        return self.service.save_settings(input, actor_id)

    def edit_plan(self, action: Any, input: Any, actor_id: Any) -> Any:
        return self.service.edit_plan(action, input, actor_id)

    def restore_plan(self, plan_id: Any, input: Any, actor_id: Any) -> Any:
        return self.service.restore_plan(plan_id, input, actor_id)

    def publish_plan(self, plan_id: Any, input: Any, actor_id: Any) -> Any:
        return self.service.publish_plan(plan_id, input or {}, actor_id)

    def link_stripe_prices(self, links: Any, actor_id: Any) -> Any:
        return self.service.link_stripe_prices(links, actor_id)

    # Accounts
    def me(self, user_id: Any) -> Any:
        return self.service.me(user_id)

    def preferences(self, user_id: Any, enabled: Any) -> Any:
        return self.service.preferences(user_id, enabled)

    def change(self, user: Any, plan_id: Any, key: Any) -> Any:
        return self.service.change(user, plan_id, key)

    def setup_payment(self, user: Any, key: Any) -> Any:
        return self.service.setup_payment(user, key)

    def set_payment(self, user: Any, setup_id: Any) -> Any:
        return self.service.set_payment(user, setup_id)

    def cancel(self, user: Any, key: Any) -> Any:
        return self.service.cancel(user, key)

    def sync(self, user_id: Any) -> None:
        self.service.sync(user_id)
        return None

    def billing(self, user_id: Any) -> Any:
        return self.service.billing(user_id)

    def grant(self, user_id: Any, input: Any, actor_id: Any) -> Any:
        return self.service.grant(user_id, input, actor_id)

    def reset(self, user_id: Any, input: Any, actor_id: Any) -> Any:
        return self.service.reset(user_id, input, actor_id)

    def list_users(self, query: Any = None) -> Any:
        return self.service.list_users(query or {})

    def webhook(self, raw: Any, signature: Any) -> Any:
        return self.service.webhook(raw, signature)

    # Credits
    def consume(self, user_id: Any, product_id: Any, credits: Any, request_id: Any, meta: Any = None) -> Any:
        return self.service.consume(user_id, product_id, credits, request_id, meta)

    def record_credits(self, user_id: Any, input: Any) -> Any:
        return self.service.record_credits(user_id, input)

    def estimate(self, input: Any) -> Any:
        return self.service.estimate(input)

    def consume_usage(self, user_id: Any, product_id: Any, usage: Any, request_id: Any) -> Any:
        return self.service.consume_usage(user_id, product_id, usage, request_id)

    def ledger(self, user_id: Any, cursor: Any = None) -> Any:
        return self.service.ledger(user_id, cursor)

    # Overview and maintenance
    def overview(self, months: Any = None) -> Any:
        return self.service.overview(12 if months is None else months)

    def maintenance(self) -> Any:
        return self.service.maintenance()

    # Module surface
    def endpoints(self) -> Any:
        return [
            {
                "method": e.method,
                "path": e.path,
                "access": e.access,
                "resource": e.resource,
                "tool": e.tool.get("name") if e.tool else None,
                "maxBodyBytes": None if e.max_body_bytes == DEFAULT_BODY_LIMIT else e.max_body_bytes,
            }
            for e in self._feature.endpoints
        ]

    def call(self, method: Any, path: Any, request: Any = None, actor: Any = None) -> Any:
        request = request if isinstance(request, dict) else {}
        # Literal routes win over :param routes (stable order otherwise).
        for endpoint in sorted(self._feature.endpoints, key=lambda e: ":" in e.path):
            if endpoint.method != method:
                continue
            names: list[str] = []
            parts = []
            for part in endpoint.path.split("/"):
                if part.startswith(":"):
                    names.append(part[1:])
                    parts.append("([^/]+)")
                else:
                    parts.append(re.escape(part))
            match = re.fullmatch("/".join(parts) + "/?", path)
            if match:
                params = {name: decode_uri_component(value) for name, value in zip(names, match.groups())}
                raw = request.get("raw")
                return endpoint.handle(
                    Context(
                        request=Request(
                            method=method,
                            path=path,
                            body=request.get("body") or {},
                            query=request.get("query") or {},
                            headers=request.get("headers") or {},
                            raw_body="" if raw is None else raw,
                        ),
                        params=params,
                        actor=actor,
                    )
                )
        raise HttpError(404, "Endpoint not found")

    def admin(self) -> Any:
        return self._feature.admin

    def migrations(self) -> Any:
        return list(MIGRATIONS)

    # Helpers
    def set_now(self, iso: Any) -> None:
        return self._clock.set(iso)

    def set_catalog(self, mode: Any) -> None:
        self._catalog.mode = mode
        return None

    def published(self) -> Any:
        return self._catalog.published

    def sent(self) -> Any:
        return self._sent

    def row(self, pk: Any, sk: Any) -> Any:
        return self._store.get(pk, sk)

    def list(self, pk: Any, cursor: Any = None) -> Any:
        return self._store.list(pk, cursor)

    def audit(self) -> Any:
        rows: list[Any] = []
        cursor = None
        while True:
            page = self._store.list("SUB_AUDIT", cursor)
            rows.extend(r["data"] for r in page["items"])
            cursor = page.get("cursor")
            if not cursor:
                break
        return sorted(rows, key=lambda data: canonical(data, _fail))


SUBJECTS = {"subscriptions": SubscriptionsFacade}
