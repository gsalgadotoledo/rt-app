# Component catalog

Reusable TypeScript packages live in `rt-app/packages/`. Application composition exposes `app.observer`, `app.analytics`, `app.cache`, `app.flags`, `app.visits` and `app.health`. Each new component owns its tests. Browser entry points and admin panels remain inside their owning package; frontend imports must not import server implementations.

## Available

| Component | Purpose | Adapters / interface |
| --- | --- | --- |
| Observer | Structured logs, request correlation, timings, filtered delivery | Console, NoSQL/JSON, CloudWatch, email, SMS, Slack, Datadog, Sentry, HTTPS webhook |
| Analytics | Page views and named product events | Uses Observer outputs; `kind: analytics` and `category: analytics` keep custom events separate from logs |
| Feature flags | Enable/disable features, percentage rollout, explicit subjects | NoSQL persistence (local JSON or DynamoDB), admin editor, browser evaluation |
| Visits | Sampled mouse paths, clicks, viewport heatmaps | NoSQL retention, lightweight browser capture, admin detail/playback |
| Health | Liveness/readiness and dependency status | Named abort-aware probes; cached results and an admin panel |
| Cache | TTL cache-aside, content-derived keys, local loader deduplication | Memory LRU, JSON file, DynamoDB, connected Redis client |
| Authentication / ACL | Identity, permissions, access checks | Local / Cognito; flags never replace authorization |
| Subscriptions / idempotency | Plans, quotas, billing and retry protection | Existing local / Stripe / persistent idempotency components |
| Infra / AWS | Provisioning and resource/cost inspection | Existing Terraform AWS modules |

Analytics is a separate API facade over the same delivery infrastructure. A view is counted once, not both by Analytics and Observer. Public client metrics are untrusted samples: do not use them to bill users or enforce quotas.

## Cache example

```ts
const value = await app.cache.remember(
  'catalog:v1',
  { tenantId, filters }, // include tenant/user scope when the result depends on it
  60_000,
  () => loadCatalog(filters),
);
```

Keys hash canonical JSON: object property order does not matter. Values must be finite JSON, up to 64 KB. `undefined`, Dates, bigint and cyclic values are rejected; use explicit JSON representations. `null` and `false` are valid cached results. TTL is mandatory (milliseconds, maximum 30 days). Errors are not cached. Memory is bounded to 1,000 entries; pending loader deduplication is per process, not a distributed lock. Adapters propagate storage failures; choose application fallback behavior explicitly. Do not cache authorization checks or payment side effects by default.

```ts
import { FileCache } from '@gsalgadotoledo/rt-app-cache-file';
import { DynamoCache } from '@gsalgadotoledo/rt-app-cache-dynamodb';
import { RedisCache } from '@gsalgadotoledo/rt-app-cache-redis';

// createApplication({ ...applicationDependencies, cacheAdapter: new FileCache() });
// createProductionApplication(modules, factories, {cacheAdapter: new DynamoCache(table)});
// RedisCache accepts a connected node-redis client; the caller connects/closes it.
const adapter = new RedisCache(redisClient);
```

File cache defaults to `.rt-app/cache.json` and uses process-safe atomic JSON writes. DynamoDB uses an existing pk/sk table with `ttl` enabled; data is logically expired on reads even before AWS physically deletes it. JSON also prunes expired entries on writes. File storage suits small local datasets. Lambda memory is per execution environment; choose DynamoDB or Redis for shared entries. No Redis server is provisioned automatically.

## Flags example

```ts
if (await app.flags.enabled('new-checkout', user.id)) {
  // New implementation. Keep normal permission and billing checks.
}
```

Admin → Feature flags creates and edits flags. Writes require the current version to avoid overwriting another admin's changes. Unknown or disabled flags return false. A 10% rollout hashes flag key + subject ID, making decisions stable between requests and implementations using the same algorithm. The subject allowlist applies only when enabled. Browser `evaluateFlags(apiUrl, keys, subject)` returns only booleans for flags explicitly marked public. Browser subjects can be forged; backend decisions must use the authenticated identity. Public evaluation accepts at most 20 keys; configure gateway rate limits for public traffic.

## Visits

The Next.js starter includes `@gsalgadotoledo/rt-app-visits/browser` on its public pages. It respects Do Not Track and Global Privacy Control. Set `NEXT_PUBLIC_RT_APP_VISITS=false` at build time to disable capture. Other applications can call `startVisitCapture({apiUrl, pages})` and call its returned cleanup function on unmount. Server `visitPages` and client `pages` must agree.

- Default allowlist: `/`, `/about`, `/services`. No query strings, text, DOM snapshots, selectors, input values, cookies or authentication tokens.
- Form/private elements (`data-private`) are excluded. Pointer movement is sampled at most twice per second; batches contain at most 20 points.
- Up to 120 events/session, 30-minute capture token, last 10 sessions per application, 24-hour retention. Older sessions are discarded atomically when new ones arrive. Reads prune expired entries; DynamoDB TTL/JSON writes handle later physical cleanup.
- Browser session ID/token lives only in memory. The backend signs capture tokens; reads/deletion are admin-only. Browser events can still be fabricated by a visitor.
- Admin → Visit sessions lists sessions, displays click heatmaps and animates a sampled path on normalized viewport coordinates. This is diagnostic geometry, not video, DOM replay, or a true full-page heatmap across different layouts.
- Storage is deliberately a small shared document. This keeps retention strict but introduces write contention at high traffic. Use a sampled queue/partitioned adapter before scaling beyond diagnostic traffic; this is not a high-volume analytics warehouse.

## Health

`GET /health/live` reports that the process responds. `GET /health/ready` checks required dependencies and returns 503 on failure without exposing internal errors. Admin → Service health shows named checks and latency. Default probe reads the application's database. Checks are cached for 10 seconds and capped at a one-second timeout; custom checks should pass the abort signal to their transport.

An external monitor must poll readiness to detect full outages. A process cannot report after it crashes. Uptime histories, external scheduled probes, geographic checks and durable alert escalation are roadmap items, not implemented monitors.

## Next components to prioritize

| Priority | Component | Why / contemporary reference |
| --- | --- | --- |
| 1 | Durable outbox + queues | Deliver notifications/retries after a crash; equivalents: Laravel queues/Horizon, BullMQ/SQS |
| 1 | External uptime monitor | Detect unavailable API/SPA/SSR independently; integrate health endpoints |
| 1 | Distributed rate limiter | Protect public ingestion/login across Lambda instances; Redis/DynamoDB adapters |
| 2 | Scheduler + leases | Recurring work without double execution across instances; Laravel scheduler / EventBridge |
| 2 | OpenTelemetry tracing | Follow a request across services; supplement today's process-local request IDs |
| 2 | Object storage + uploads | Local/S3 adapters, signed URLs and file validation |
| 2 | Notification preferences | Templates, channels, opt-outs and durable delivery policies |
| 3 | Search | NoSQL-friendly filters today; later dedicated full-text adapter |
| 3 | Webhooks inbox/outbox | Signature validation, replay detection, retries and delivery inspection |
| 3 | Audit trail | Immutable domain actions separate from sampled operational logs |

These are an architectural shortlist, not a popularity ranking or a claim that every package above is already implemented. Reuse mature provider clients behind our contracts rather than recreating infrastructure engines.

References: [Yii application components](https://www.yiiframework.com/doc/guide/2.0/en/structure-application-components), [Yii caching](https://www.yiiframework.com/doc/guide/2.0/en/caching-data), [Laravel cache](https://laravel.com/framework/docs/12.x/cache), [Laravel Pennant](https://github.com/laravel/pennant), [Laravel Pulse](https://pulse.laravel.com/), [NestJS health checks](https://docs.nestjs.com/recipes/terminus), [NestJS queues](https://docs.nestjs.com/techniques/queues), [Redis expiry](https://redis.io/docs/latest/commands/expire/).

No Go/Python duplicates are needed for browser capture or these initial TS modules. Those languages can call the same protected APIs; native adapters should be added with equivalent contract tests when a backend actually needs them. This change does not publish a new npm release or deploy infrastructure.

## Commerce and backoffice research

The following are proposed modules, **not implemented commerce features**. Existing `subscriptions` manages recurring plans/credits; it is not an inventory system or a complete checkout. Keep independent contracts and package-owned tests before adding admin screens.

| Module | Responsibility | Important test invariants |
| --- | --- | --- |
| `catalog` | Products, variants/SKUs, collections, attributes, media references, published/archived state | Unique SKU per tenant, soft-delete visibility, versioned edits, paginated queries |
| `inventory` | Stock by location, reservations and expiry | Atomic reservation, no overselling, idempotent release, concurrent checkout |
| `cart` | Selected variant/quantity; server-side repricing | Never trust browser totals, quantity bounds, stale/archived items |
| `orders` | Immutable item/price snapshots, order state, fulfillment/refunds | Explicit transitions, retry-safe checkout, purchase history survives catalog edits |
| `payments` | One-time authorization/capture/refund behind local/Stripe adapters | Integer minor units, currency, idempotency, verified webhooks, ownership before mutation |
| `crm` | Contacts, companies, opportunities/stages, activities and ownership | Tenant isolation, field permissions, audit trail, safe import/export |
| `notifications` | Business messages, templates, channel preferences and delivery state | Opt-out, retry policy, rate limits, duplicate delivery, sensitive-field redaction |

Dependency direction: cart reads catalog; checkout reserves inventory and creates an order; payments settles the order; subscriptions can consume payment events for entitlements. Observer receives diagnostic events from all of them. Business records and durable delivery belong in their own stores/outbox; sampled logs must never be the authoritative order/payment ledger. Catalog plan products and shop SKUs need distinct IDs and contracts.

This separation is informed by [Shopify's product/order/inventory API domains](https://shopify.dev/docs/apps/build/apis), [Shopify inventory and fulfillment use cases](https://shopify.dev/docs/apps/build/orders-fulfillment), and [Laravel Cashier's billing scope](https://laravel.com/framework/docs/billing). These are design references, not a claim of Shopify compatibility.

## Messaging integrations

General messaging should be separate from `ObserverOutputHandler`. A notification channel accepts recipient + message/template and returns a provider receipt; an Observer adapter may call that channel for an alert. Existing `observer-slack` sends log alerts only. General Slack/Telegram/WhatsApp notification packages are still proposed.

| Channel | Proposed adapter contract and setup |
| --- | --- |
| Local | JSON outbox + local inbox, no network; same delivery contract as remote adapters |
| Slack | Bot token and destination channel; `chat.postMessage`; parse API-level `ok` even on HTTP 200; honor provider rate limits |
| Telegram | Bot token + authorized chat ID; `sendMessage`; plain text by default; honor text limits and `retry_after` |
| WhatsApp | Business account/phone number ID + server-side access token; explicit text/template message types; provider receipt/status webhooks; verify current account eligibility and message rules during adapter implementation |
| Email/SMS | Reuse transport clients behind domain notification adapters; templates/preferences/outbox separate from Observer filtering |

No credentials belong in browser bundles. Do not retry ambiguous delivery blindly: record `pending`, `accepted`, `failed` or `unknown`, correlate webhook receipts and use provider idempotency where supported. A successful API response is acceptance, not proof that the person received/read a message. Queue/outbox support should precede reliable business notification delivery.

Sources: [Laravel notification channels and queues](https://laravel.com/framework/docs/12.x/notifications), [Slack chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/), [Telegram Bot API sendMessage](https://core.telegram.org/bots/api#sendmessage), [Meta WhatsApp template payload reference](https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/messages/template/). Meta's linked SDK reference is an older payload reference; revalidate current Cloud API rules before shipping the adapter.
