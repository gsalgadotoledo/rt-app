# Subscriptions service in every language

Contracts: `spec/contracts/subscriptions-settings`, `-accounts`, `-usage`, `-overview` (module,
subject `subscriptions`) and `subscriptions-api` (HTTP, local mode). They build on the pure
`subscriptions-ledger` and `subscriptions-credits` contracts (see `polyglot.md`). Hosts:
`spec/hosts/node/subscriptions.mjs`, `spec/hosts/python/subscriptions_service.py`,
`core-go/cmd/contract-host/subscriptions.go`. Ports: `rt_app.subscriptions` (Python) and
`rt.local/core-go/subscriptions` (Go). The contract descriptions hold the full rules; this page
lists the surface and what ports get wrong most often.

Stripe (`subscriptions-stripe`) is not ported yet. The ports define the `BillingProvider` and
`CatalogPublisher` interfaces it will implement, and ship `LocalBilling`.

## Surface and clock

`new Subscriptions(store, provider?, notify?, now?, catalogFactory?)` already takes a clock
(`() => number`, epoch milliseconds). `new LocalBilling(store, now?)` now takes one too (it read
`Date.now()`); both default to the system clock. The ports inject them the same way:

| | TypeScript | Python | Go |
| --- | --- | --- | --- |
| Service | `new Subscriptions(store, provider, notify, now, catalogFactory)` | `Subscriptions(store, provider, notify, now, catalog_factory, new_id=)` | `subscriptions.New(store, WithProvider, WithNotifier, WithClock, WithCatalog, WithIDs)` |
| Simulator | `new LocalBilling(store, now)` | `LocalBilling(store, now)` | `NewLocalBilling(store, now)` |
| Provider | `BillingProvider` | `BillingProvider` (Protocol; optional `validate_plan`, `simulate`) | `BillingProvider` (+ optional `PlanValidator`, `Simulator`) |
| Catalog | `CatalogPublisher` | `CatalogPublisher` (Protocol) | `CatalogPublisher` interface |
| HTTP | `feature()` | `feature()` (`rt_app.subscriptions.feature`) | `Feature()`, `Admin()` |
| Migrations | `schemaMigration("subscriptions")` | `MIGRATIONS`, `migrate(store)` | `Migrations`, `Migrate(ctx, store)` |

Python method names are the snake_case of the TypeScript ones (`save_settings`, `edit_plan`,
`restore_plan`, `publish_plan`, `link_stripe_prices`, `setup_payment`, `set_payment`,
`record_credits`, `consume_usage`, `list_users`); Go uses the exported CamelCase names with a
`context.Context` first (`LinkStripePrices` takes an ordered `[]PriceLink`, `Change` a `User`).
Both simulators refuse to start when `NODE_ENV` or `RT_APP_ENVIRONMENT` is `production` (the
TypeScript one checks only `NODE_ENV`). `new_id` generates audit, operation and
namespace ids (random UUID v4 by default, like `crypto.randomUUID()`).

**Contract subject `subscriptions`.** `init: {now?, rows?, billing?: "local", catalog?: true}`:
a memory store seeded with `rows`, a settable clock (default `2026-01-01T00:00:00.000Z`),
`LocalBilling` when `billing == "local"`, and a fake catalog when `catalog` is true. The
notifier captures mail. Methods are the service methods with the same positional arguments,
plus these helpers:

- `setNow(iso)`: moves the shared clock.
- `setCatalog("ok" | "fail")`: the fake catalog fails with 502 `Catalog unavailable`.
- `published()` and `sent()`: what the fake catalog and the notifier received.
- `row(pk, sk)` and `list(pk, cursor?)`: pin storage formats.
- `audit()`: SUB_AUDIT data sorted by canonical JSON text. The sort keys are random UUIDs.
- `endpoints()`, `admin()` and `migrations()`: the module surface.
- `call(method, path, request, actor)`: runs one endpoint handler with the framework routing
  rules, which covers the personal endpoints the HTTP contract cannot reach.

## Semantics ports must copy

- **Data is plain JSON with JavaScript semantics.** Account, plan and settings data are loose
  JSON objects: port them as dicts or `map[string]any`, not structs. The rules:
  - object spread keeps first-seen key order;
  - `undefined` and `null` are both "missing" on the wire;
  - comparisons with a missing number are false (`now < undefined`);
  - numbers are float64: `Math.floor`, and `Math.round` rounds halves up;
  - `String(number)` renders integers without `.0`.
- **Ledger entry order is part of the storage format.** The account's `ledgerSequence` goes into
  every entry key, so each method must create its entries in the reference order:
  - `change`: settle, then the plan entry;
  - `grant`: settle, then the entry;
  - `sync`: settle, then the billing plan entry, then the cancel entry;
  - `consume` and `recordCredits`: settle, then the entry;
  - `reset`: settle, then one entry per counter, in JavaScript key order.
- **Fingerprints are stored and must match byte for byte.** Each is JSON.stringify output in a
  fixed key order:
  - billing operations: `sha256hex` of the input without `plan`, for example
    `{"action":"change","planId":"pro"}`;
  - grants: the text `{"kind",...,"actorId"}` (it is visible in `SUB_GRANTS`);
  - `recordCredits`: `sha256hex(JSON.stringify({...input, kind, source}))`. `kind` and `source`
    keep their position when the input has them. The HTTP handler builds the input in the order
    `requestId, productId, credits, kind, reason, amountMinor, currency, details, source,
    actorId`, and undefined fields are omitted.
- **Plan versions.** A plan counts as changed when its content (`id`, `family ?? id`, `name`,
  `description ?? ""`, `amount`, `currency`, `periodDays`, `products`, `metadata ?? {}`)
  differs. The reference compares SHA-256 digests of JSON text; the ports compare canonical JSON,
  which gives the same answer because stored metadata is sorted. The last number of the version
  goes up (`0.0.9` → `0.0.10`).
- **Retries.** `retry` runs up to eight attempts, and only on the optimistic-concurrency
  `Conflict` (409 `Conflict: refresh and try again`). Other 409s, such as `Already subscribed
  to this plan`, fail right away.
- **Windows.** Settling a window uses the `rollover` port with `used(product, start) =
  counters[product].week` when `weekStart == start`, else 0. For an `admin:` key, the counters
  come from the admin grant.
- **Error messages.** 429 names the first window that is fully used, checked in the order day,
  week, period. It is not the window that actually limits the request: with 60 of 100 daily
  credits used, a request for 50 reports `period`. The contract pins this reference behavior.
- **Random values** are the audit sort keys, catalog operation ids and namespaces, and the seeds
  of `sync` ledger entries. The contracts match them with `$regex`.

### Known divergences

- **Go key order.** Go maps do not keep key order, so after a store round trip Go orders these
  keys like JavaScript objects: array-index keys first, then the effective plan's products, then
  the rest sorted. This applies to `counters`, `creditBalance` extras and
  `ledgerWindows.products`. It matches the reference unless a plan change carries counters of
  products the new plan lacks. It also affects the fingerprint of `details` objects whose keys
  are not sorted.
- **Metadata key order.** Python and Go do not reproduce the `localeCompare` order of plan
  metadata keys. Key order is not part of the contract.
- **Webhook body limit.** The webhook allows 256 KiB. Python has per-endpoint body limits; the Go
  web layer has one limit for every endpoint, so Go rejects webhooks over 16 KiB.

## HTTP (local mode)

The Python and Go example APIs wire `LocalBilling` and no catalog. The TypeScript reference
always wires the Stripe catalog, so `catalogAvailable` is matched by type.

- The personal endpoints need a session: 401 `Sign in`. No example API seeds a demo account or
  offers login, so the signed-in flows are pinned through `call()` in the module contracts.
- The webhook answers 400 `Invalid webhook signature`.
- `/subscriptions/admin/*` answers 404 at its plain path, and runs as `rt-app-root` under
  `/admin/app`.
