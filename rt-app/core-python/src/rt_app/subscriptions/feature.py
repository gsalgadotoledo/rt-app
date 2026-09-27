"""HTTP surface of the Subscriptions service (port of ``Subscriptions.feature()``).

Owner endpoints live under ``/subscriptions/admin/*`` and are admin-only: the web layer serves
them only under ``/admin/app`` (see ``rt_app.web.app.admin_only``). Personal endpoints need a
signed-in actor; the webhook is a guest endpoint with a 256 KiB body limit.
"""
from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import TYPE_CHECKING, Any, Final, TypedDict

from .._jsnum import js_string, utf16_slice
from ..errors import HttpError
from ..nosql import NoSQL
from ..web.app import Context, Endpoint, Feature
from .ledger import js_own_keys
from .plans import identifier
from .service import UNDEFINED, WEBHOOK_BODY_LIMIT, _js_number, _js_str

if TYPE_CHECKING:
    from .service import Subscriptions

ADMIN: Final[Mapping[str, Any]] = {
    "id": "subscriptions",
    "title": "Subscriptions",
    "resource": "subscriptions.manage",
    "path": "/subscriptions/admin/accounts",
    "component": "subscriptions",
    "ownerOnly": True,
    "fields": [],
    "actions": [],
}


class Migration(TypedDict):
    id: str
    checksum: str
    description: str


#: ``schemaMigration("subscriptions")``: records schema version 1 once.
MIGRATIONS: Final[tuple[Migration, ...]] = (
    {"id": "subscriptions:001", "checksum": "subscriptions-document-v1", "description": "Register the subscriptions document schema"},
)


def migrate(store: NoSQL) -> None:
    """Run the module migrations: ``SCHEMA/subscriptions`` ``{schemaVersion: 1}`` unless it exists."""
    if store.get("SCHEMA", "subscriptions") is None:
        store.transact([{"row": {"pk": "SCHEMA", "sk": "subscriptions", "version": 1, "data": {"schemaVersion": 1}}, "expected": None}])


MANAGE = "subscriptions.manage"
ME = "subscriptions.me"
#: Scope of the metering endpoints a service key may call (``rt_app.service_keys``).
METER = "subscriptions.meter"


def _body(c: Context) -> dict[str, Any]:
    return c.request.body if isinstance(c.request.body, dict) else {}


def _field(c: Context, name: str) -> Any:
    """``c.request.body.name`` with JavaScript undefined for a missing field."""
    return _body(c).get(name, UNDEFINED)


def _id(value: Any) -> str:
    return identifier(None if value is UNDEFINED else value)


def _details(value: Any) -> Any:
    """The admin ledger handler keeps at most 20 detail entries: keys cut to 40 UTF-16 units,
    numbers and booleans as is, anything else ``String(v)`` cut to 200."""
    if not isinstance(value, Mapping):
        return UNDEFINED
    out: dict[str, Any] = {}
    for key in js_own_keys(value)[:20]:
        item = value[key]
        number = isinstance(item, (bool, int, float))
        out[utf16_slice(key, 40)] = item if number else utf16_slice(js_string(item), 200)
    return out


def feature(service: Subscriptions) -> Feature:
    """Endpoints in the reference order (plan actions first)."""

    def owner(method: str, path: str, handle: Callable[[Context], Any], tool: Mapping[str, Any] | None) -> Endpoint:
        return Endpoint(method, path, MANAGE, "owner", handle, tool=tool)

    def personal(method: str, path: str, handle: Callable[[Context], Any]) -> Endpoint:
        return Endpoint(method, path, ME, "authenticated", handle)

    def actor_id(c: Context) -> str:
        assert c.actor is not None
        return c.actor["id"]

    def plan_action(action: str) -> Endpoint:
        return owner(
            "POST",
            f"/subscriptions/admin/plans/actions/{action}",
            lambda c: service.edit_plan(action, c.request.body, actor_id(c)),
            {
                "name": f"subscriptions_plan_{action}",
                "description": f"{action} a plan. Read settings first; body.version is its concurrency revision. Body.id selects an existing plan. Create/update accept body.plan (name, amount, currency, periodDays, products). Product entries define id, name, credits, dailyLimit, weeklyLimit, daySeconds, weekSeconds. Create generates ID and starts disabled. Archive/unarchive leave disabled. Version snapshots even unchanged content. Publish separately to synchronize Stripe.",
                "example": {"body": {"version": 0, "id": "pro"}},
            },
        )

    def sync(c: Context) -> Any:
        assert c.actor is not None
        service.sync(c.actor["id"])
        return service.me(c.actor["id"])

    def account(c: Context) -> Any:
        user_id = c.params["id"]
        me = service.me(user_id)
        user = service.store.get("USERS", user_id)
        return {
            "account": {**me, "email": user["data"].get("email") if user else None},
            "billing": service.billing(user_id),
            "grants": service.store.list("SUB_GRANTS#" + user_id, c.request.query.get("historyCursor")),
            "usage": service.store.list("SUB_USAGE#" + user_id, c.request.query.get("cursor")),
        }

    def overview(c: Context) -> Any:
        months = c.request.query.get("months")
        return service.overview(_js_number(months) if months else 12)

    def economics(c: Context) -> Any:
        limit = c.request.query.get("limit")
        return service.economics(_js_number(limit) if limit else 50)

    # Metering for backends with a scoped service key: the owner calls on the account in the
    # path, source "api" and actorId "service:<key id>". No user, settings or plan endpoint.
    def meter(method: str, path: str, handle: Callable[[Context], Any]) -> Endpoint:
        return Endpoint(method, "/service/subscriptions/accounts/:id" + path, METER, "service", handle)

    def meter_account(c: Context) -> str:
        return identifier(c.params["id"])

    def meter_ledger(c: Context) -> Any:
        body = _body(c)
        user_id = meter_account(c)
        credits = body.get("credits")
        if isinstance(credits, (int, float)) and not isinstance(credits, bool) and credits > 0:
            raise HttpError(403, "Service keys can only record debits")
        return service.record_credits(
            user_id,
            {
                "requestId": _field(c, "requestId"),
                "productId": _field(c, "productId"),
                "credits": _field(c, "credits"),
                "kind": _field(c, "kind"),
                "reason": _field(c, "reason"),
                "details": _details(_field(c, "details")),
                "source": "api",
                "actorId": actor_id(c),
            },
        )

    def record(c: Context) -> Any:
        return service.record_credits(
            c.params["id"],
            {
                "requestId": _field(c, "requestId"),
                "productId": _field(c, "productId"),
                "credits": _field(c, "credits"),
                "kind": _field(c, "kind"),
                "reason": _field(c, "reason"),
                "amountMinor": _field(c, "amountMinor"),
                "currency": _field(c, "currency"),
                "details": _details(_field(c, "details")),
                "source": "admin",
                "actorId": actor_id(c),
            },
        )

    def simulate(c: Context) -> Any:
        simulate = getattr(service.provider, "simulate", None) if service.provider else None
        if simulate is None:
            raise HttpError(404, "Simulation unavailable")
        row = service.store.get("SUB_ACCOUNTS", c.params["id"])
        customer = row["data"].get("customerId") if row else None
        if not customer:
            raise HttpError(404, "No simulated customer")
        simulate(customer, _body(c).get("status"))
        service.sync(c.params["id"])
        return {"ok": True}

    def user(c: Context) -> Mapping[str, Any]:
        assert c.actor is not None
        return c.actor

    # Request bodies of the reservation endpoints: only the documented fields reach the service.
    def amount(c: Context) -> dict[str, Any]:
        body = _body(c)
        return {"credits": body.get("credits"), "estimate": body.get("estimate")}

    def reservation(c: Context) -> dict[str, Any]:
        body = _body(c)
        return {name: body.get(name) for name in ("key", "credits", "estimate", "ttlMs", "reason")}

    def usage(c: Context) -> dict[str, Any]:
        body = _body(c)
        return {name: body.get(name) for name in ("credits", "inputTokens", "outputTokens")}

    def as_user(c: Context) -> dict[str, Any]:
        return {"source": "user", "actorId": user(c)["id"]}

    def as_api(c: Context) -> dict[str, Any]:
        return {"source": "api", "actorId": actor_id(c)}

    meter_endpoints = [
        meter("GET", "/usage", lambda c: service.usage_summary(meter_account(c))),
        meter("POST", "/preflight", lambda c: service.preflight(meter_account(c), _body(c).get("productId"), amount(c))),
        meter("POST", "/reservations", lambda c: service.reserve(meter_account(c), _body(c).get("productId"), reservation(c), as_api(c))),
        meter("POST", "/reservations/:key/settle", lambda c: service.settle(meter_account(c), c.params["key"], usage(c), as_api(c))),
        meter("POST", "/reservations/:key/release", lambda c: service.release(meter_account(c), c.params["key"], as_api(c))),
        meter("POST", "/ledger", meter_ledger),
    ]

    endpoints = [
        *(plan_action(action) for action in ("create", "update", "archive", "unarchive", "version")),
        personal("GET", "/subscriptions/me", lambda c: service.me(user(c)["id"])),
        personal("GET", "/subscriptions/billing", lambda c: service.billing(user(c)["id"])),
        personal("POST", "/subscriptions/change", lambda c: service.change(user(c), _js_str(_field(c, "planId")), _id(_field(c, "requestId")))),
        personal("POST", "/subscriptions/payment/setup", lambda c: service.setup_payment(user(c), _id(_field(c, "requestId")))),
        personal("POST", "/subscriptions/payment/save", lambda c: service.set_payment(user(c), _id(_field(c, "setupId")))),
        personal("POST", "/subscriptions/cancel", lambda c: service.cancel(user(c), _id(_field(c, "requestId")))),
        personal("POST", "/subscriptions/sync", sync),
        personal("PUT", "/subscriptions/preferences", lambda c: service.preferences(user(c)["id"], _body(c).get("notifications"))),
        Endpoint(
            "POST",
            "/subscriptions/webhook",
            "subscriptions.webhook",
            "guest",
            lambda c: service.webhook(c.request.raw_body or "", c.request.headers.get("stripe-signature") or ""),
            max_body_bytes=WEBHOOK_BODY_LIMIT,
        ),
        owner(
            "GET",
            "/subscriptions/admin/settings",
            lambda c: service.settings(),
            {"name": "subscriptions_settings_get", "description": "Read settings and optimistic concurrency version. Read before editing plans.", "example": {}},
        ),
        owner(
            "PUT",
            "/subscriptions/admin/settings",
            lambda c: service.save_settings(c.request.body, actor_id(c)),
            {
                "name": "subscriptions_settings_save",
                "description": "Save complete settings with version. Add plans, edit products/prices/limits, or set archived:true and enabled:false. Changed plan content creates a version; preserve all existing plan IDs.",
                "example": {"body": {"version": 0, "values": {}}},
            },
        ),
        owner(
            "POST",
            "/subscriptions/admin/plans/:id/publish",
            lambda c: service.publish_plan(c.params["id"], c.request.body, actor_id(c)),
            {
                "name": "subscriptions_plan_publish",
                "description": "Synchronize a saved plan to Stripe. Creates paid catalog resources; requires configured Stripe credentials. Body: version.",
                "example": {"params": {"id": "pro"}, "body": {"version": 1}},
            },
        ),
        owner(
            "POST",
            "/subscriptions/admin/plans/:id/restore",
            lambda c: service.restore_plan(c.params["id"], c.request.body, actor_id(c)),
            {
                "name": "subscriptions_plan_restore",
                "description": "Restore history as a new version. Body: version (settings revision), fromVersion (plan version).",
                "example": {"params": {"id": "pro"}, "body": {"version": 1, "fromVersion": "0.0.1"}},
            },
        ),
        owner(
            "GET",
            "/subscriptions/admin/plans/:id/history",
            lambda c: service.store.list("SUB_PLAN_HISTORY#" + c.params["id"], c.request.query.get("cursor")),
            {"name": "subscriptions_plan_history", "description": "Read paginated plan history; optional query.cursor.", "example": {"params": {"id": "pro"}}},
        ),
        owner(
            "GET",
            "/subscriptions/admin/accounts",
            lambda c: service.list_users(c.request.query),
            {"name": "subscriptions_accounts_list", "description": "Search users one page at a time; optional query.q and query.cursor.", "example": {}},
        ),
        owner(
            "GET",
            "/subscriptions/admin/accounts/:id",
            account,
            {
                "name": "subscriptions_account_get",
                "description": "Read account, invoices, grants and usage. params.id identifies the user.",
                "example": {"params": {"id": "USER_ID"}},
            },
        ),
        owner(
            "GET",
            "/subscriptions/admin/overview",
            overview,
            {
                "name": "subscriptions_overview",
                "description": "Customers, paying customers, projected monthly revenue per currency (minor units), new and canceled subscriptions today, this month and per month. query.months (1-36, default 12).",
                "example": {"query": {"months": "12"}},
            },
        ),
        owner(
            "GET",
            "/subscriptions/admin/economics",
            economics,
            {
                "name": "subscriptions_economics",
                "description": "Unit economics: provider cost (settlements priced with the rates' costs), revenue (money paid) and margin per currency, per plan and for the users with the highest cost. query.limit (1-200, default 50). Never writes.",
                "example": {"query": {"limit": "50"}},
            },
        ),
        owner(
            "GET",
            "/subscriptions/admin/accounts/:id/ledger",
            lambda c: service.ledger(c.params["id"], c.request.query.get("cursor")),
            {
                "name": "subscriptions_account_ledger",
                "description": "Chronological credit statement (allowances, usage, expiries, grants, purchases, plans), balances and totals. params.id user; query.cursor continues.",
                "example": {"params": {"id": "USER_ID"}},
            },
        ),
        owner(
            "POST",
            "/subscriptions/admin/accounts/:id/ledger",
            record,
            {
                "name": "subscriptions_account_record",
                "description": "Record a credit (+) or debit (−) on the user's statement. Body: requestId, productId, credits (non-zero integer), kind (purchase|adjustment|grant|usage), reason, optional amountMinor+currency for money paid, details. Debits use the plan allowance first. Reuse requestId for retries.",
                "example": {
                    "params": {"id": "USER_ID"},
                    "body": {"requestId": "unique-request-id", "productId": "api", "credits": 1000, "kind": "purchase", "reason": "Top-up", "amountMinor": 1000, "currency": "usd"},
                },
            },
        ),
        owner(
            "POST",
            "/subscriptions/admin/credits/estimate",
            lambda c: service.estimate(c.request.body),
            {
                "name": "subscriptions_credits_estimate",
                "description": "Credit sandbox: price a request by rate (model) and tokens; with userId shows how it would be charged. Body: rateId, inputTokens, outputTokens, optional userId, productId. Never writes.",
                "example": {"body": {"rateId": "standard", "inputTokens": 1000, "outputTokens": 500}},
            },
        ),
        owner(
            "POST",
            "/subscriptions/admin/accounts/:id/grant",
            lambda c: service.grant(c.params["id"], c.request.body, actor_id(c)),
            {
                "name": "subscriptions_account_grant",
                "description": "Assign plan or credits without charging a card. Body: requestId,kind(plan|credits),planId or productId,credits,valueMinor,currency,reason. Reuse requestId for retries.",
                "example": {
                    "params": {"id": "USER_ID"},
                    "body": {"kind": "credits", "productId": "api", "credits": 100, "valueMinor": 100, "currency": "usd", "reason": "Courtesy", "requestId": "unique-request-id"},
                },
            },
        ),
        owner(
            "POST",
            "/subscriptions/admin/accounts/:id/reset",
            lambda c: service.reset(c.params["id"], c.request.body, actor_id(c)),
            {
                "name": "subscriptions_account_reset",
                "description": "Reset usage window. Body: requestId,scope(day|week|period|all),reason.",
                "example": {"params": {"id": "USER_ID"}, "body": {"requestId": "unique-request-id", "scope": "day", "reason": "Courtesy"}},
            },
        ),
        owner(
            "POST",
            "/subscriptions/admin/accounts/:id/simulate",
            simulate,
            {"name": "subscriptions_account_simulate", "description": "Local billing only: simulate payment status. params.id and body.status required."},
        ),
        owner(
            "POST",
            "/subscriptions/admin/maintenance",
            lambda c: service.maintenance(),
            {"name": "subscriptions_maintenance", "description": "Run subscription maintenance and configured notifications.", "example": {}},
        ),
        # Credit reservations. Personal endpoints act on the signed-in user's own reservations
        # (source "user"); a backend that meters model calls uses the owner endpoints (admin
        # token), whose reservations the user cannot settle or release.
        personal("GET", "/subscriptions/credits/usage", lambda c: service.usage_summary(user(c)["id"])),
        personal("POST", "/subscriptions/credits/preflight", lambda c: service.preflight(user(c)["id"], _body(c).get("productId"), amount(c))),
        personal("POST", "/subscriptions/credits/reservations", lambda c: service.reserve(user(c)["id"], _body(c).get("productId"), reservation(c), as_user(c))),
        personal("POST", "/subscriptions/credits/reservations/:key/settle", lambda c: service.settle(user(c)["id"], c.params["key"], usage(c), as_user(c))),
        personal("POST", "/subscriptions/credits/reservations/:key/release", lambda c: service.release(user(c)["id"], c.params["key"], as_user(c))),
        owner(
            "GET",
            "/subscriptions/admin/accounts/:id/usage",
            lambda c: service.usage_summary(c.params["id"]),
            {
                "name": "subscriptions_credits_usage",
                "description": "Usage against limits for a user: per product the day/week/period windows (used, reserved, limit, percent, threshold 0|80|95|100), active reservations, alerts at 80% or more and the credit pack for a top-up. params.id user. Never writes.",
                "example": {"params": {"id": "USER_ID"}},
            },
        ),
        owner(
            "POST",
            "/subscriptions/admin/accounts/:id/preflight",
            lambda c: service.preflight(c.params["id"], _body(c).get("productId"), amount(c)),
            {
                "name": "subscriptions_credits_preflight",
                "description": "Check whether a batch fits before running it. Body: productId and credits, or estimate {rateId, inputTokens, maxOutputTokens}. Returns fits, reason (inactive|payment|product|credits), available, missing, windows and a topUp offer. Never writes.",
                "example": {"params": {"id": "USER_ID"}, "body": {"productId": "api", "estimate": {"rateId": "standard", "inputTokens": 1200, "maxOutputTokens": 800}}},
            },
        ),
        owner(
            "POST",
            "/subscriptions/admin/accounts/:id/reservations",
            lambda c: service.reserve(c.params["id"], _body(c).get("productId"), reservation(c), as_api(c)),
            {
                "name": "subscriptions_credits_reserve",
                "description": "Hold credits before a model call. Body: key (stable, e.g. turnId:step), productId, credits or estimate {rateId, inputTokens, maxOutputTokens}, optional ttlMs (default 900000) and reason. Reuse the key for retries; the same key with another amount fails with 409.",
                "example": {"params": {"id": "USER_ID"}, "body": {"key": "turn-1:0", "productId": "api", "estimate": {"rateId": "standard", "inputTokens": 1200, "maxOutputTokens": 800}}},
            },
        ),
        owner(
            "POST",
            "/subscriptions/admin/accounts/:id/reservations/:key/settle",
            lambda c: service.settle(c.params["id"], c.params["key"], usage(c), as_api(c)),
            {
                "name": "subscriptions_credits_settle",
                "description": "Charge the real usage of a reservation and release the rest. Body: inputTokens and outputTokens (priced with the reserved rate) or credits. Works after the reservation expired; returns uncovered credits it could not charge. Idempotent per key.",
                "example": {"params": {"id": "USER_ID", "key": "turn-1:0"}, "body": {"inputTokens": 1200, "outputTokens": 150}},
            },
        ),
        owner(
            "POST",
            "/subscriptions/admin/accounts/:id/reservations/:key/release",
            lambda c: service.release(c.params["id"], c.params["key"], as_api(c)),
            {
                "name": "subscriptions_credits_release",
                "description": "Release a reservation without charging it (the call did not run). Idempotent per key.",
                "example": {"params": {"id": "USER_ID", "key": "turn-1:0"}},
            },
        ),
        *meter_endpoints,
    ]
    return Feature(id="subscriptions", endpoints=endpoints, admin=ADMIN)


__all__ = ["ADMIN", "METER", "MIGRATIONS", "Migration", "migrate", "feature"]
