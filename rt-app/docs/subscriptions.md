# Subscriptions

`@gsalgadotoledo/rt-app-subscriptions` owns plans, product credits, access limits, audit records and notifications. `@gsalgadotoledo/rt-app-subscriptions-stripe` handles Stripe. Both use the configured NoSQL adapter: JSON locally, DynamoDB on AWS.

## Local

Run `npm run dev`. Open Admin → Subscriptions, edit plans and settings. Users select a plan in SPA → My account → Subscription & billing.

Payments are optional by default. Enable **Require payment** to exercise the local payment simulator. Simulated invoices and cards are clearly labeled; no charges occur. Admin subscriber details can simulate `past_due`, `active` or `canceled`. The simulator is rejected in production and does not accept card numbers or webhooks.

## Stripe

Start the backend with `SUBSCRIPTIONS_PROVIDER=stripe`, `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY` and `STRIPE_WEBHOOK_SECRET` set in its environment. Use test keys first. Register `POST <api-url>/subscriptions/webhook`; for localhost, forward events with Stripe CLI. Configure these events:

- `invoice.paid`, `invoice.payment_failed`, `invoice.upcoming`
- `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.trial_will_end`

In Admin, map each plan to an existing recurring Stripe Price, then enable Require payment. Price, currency and interval must match. Supported currencies: USD, EUR, GBP, CAD, AUD, COP, MXN, BRL (minor units). One licensed subscription item; monthly uses 30 as configuration shorthand, yearly 365. Actual paid renewal dates come from Stripe. Tax, discounts, trials, multi-item subscriptions and automatic Stripe Product/Price creation are not configured by this module.

The app uses custom screens with Stripe Payment Element for secure card fields and authentication. Card numbers never pass through our API. The browser cannot grant access: signed webhooks and authenticated synchronization retrieve Stripe's current state. Only active, unexpired subscriptions permit consumption; payment failure/past-due status blocks it. Pending paid upgrades retain the existing paid plan until confirmed.

For AWS, set Terraform `stripe_enabled=true`. The module creates `<environment-name>/stripe` in Secrets Manager. Populate its JSON value separately with `secretKey`, `webhookSecret`, `publishableKey`, then restart/redeploy Lambda. Secret values never enter Terraform state. An empty secret intentionally fails closed until populated. Update bootstrap policies before deploying the new EventBridge schedule. No AWS or Stripe resources are created by running local development.

## Meter a business endpoint

```ts
{
  method: 'POST', path: '/reports/generate', access: 'authenticated',
  resource: 'reports.generate',
  subscription: { product: 'api', credits: 10 },
  handle: async context => generateReport(context.actor!.id),
}
```

Clients send a stable `Idempotency-Key` header (letters, numbers, `_`, `-`, up to 100 characters). Framework authorization runs first, then an atomic credit debit, then the handler. Insufficient credits returns 429; inactive subscriptions return 402. A repeated charge key returns 409 without executing the handler again. Choose keys unique across the user's business operations.

For direct composition: `await app.subscriptions.consume(userId, 'api', 10, requestId)`. If `replayed` is true, do not repeat side effects. Charging and an external business action are not a distributed transaction: if the action fails or times out after charging, reconcile it explicitly. This initial API does not automatically refund or retry uncertain side effects.

Daily/weekly windows are fixed intervals anchored to the subscription's period start. Courtesy resets zero selected counters, keep the scheduled boundaries and never reactivate unpaid subscriptions. Each reset requires a reason and persisted idempotency key. Plan changes preserve existing counters inside the same billing period. Unpaid plans renew lazily; canceled ones expire. Existing plan snapshots retain limits until plan change or paid synchronization.

## Credits: weekly allowance, top-ups and the statement

Each plan product grants its `weeklyLimit` as a **weekly allowance**. The daily limit and the period credits also cap it. Whatever is not used by the end of the week **expires**. When the allowance runs out, consumption continues from **additional credits** (top-ups, purchases, administrator assignments), which never expire. Without them the request fails with 429 `… limit reached. Add credits or wait for the reset.`

Every movement is recorded in the user's statement (`SUB_LEDGER#<userId>`) in the same transaction as the account change:

| Kind | Credits | Written by |
| --- | --- | --- |
| allowance / expiry | + weekly allowance / − unused part | system, on the first write after a window closes (shown as *pending* until then) |
| usage | − credits, split `fromAllowance` / `fromBalance` | `consume`, `consumeUsage`, metered endpoints |
| purchase / grant / adjustment | ± credits, optional money (`amountMinor`, `currency`) | `recordCredits`, admin |
| plan | 0, with price for paid periods | plan start, change, renewal, cancellation, admin assignment |
| reset | + allowance restored | courtesy reset |

Each entry stores the credits available right after it. The account keeps running totals: credits in and out, expired, money paid per currency, and the value recorded for admin assignments, which is not a charge.

```ts
// Log a credit (+) or debit (−); idempotent per requestId. Debits use the allowance first.
await app.subscriptions.recordCredits(userId, {
  requestId: "stripe-pi_123", productId: "api", credits: 1000,
  kind: "purchase", reason: "Top-up", amountMinor: 1000, currency: "usd",
});

// Price a model request with the configured rates and charge it atomically.
await app.subscriptions.consumeUsage(userId, "api", { rateId: "standard", inputTokens: 1200, outputTokens: 300 }, requestId);
```

**Rates** live in Settings → Credits. Each model or function sets credits per 1,000 input and output tokens, with an optional minimum per request. The result is rounded up to whole credits. The pack price (e.g. 1,000 credits = USD 10) sets the money value of a credit. The **credit sandbox** in Settings prices any token count for a model and previews how the charge splits for a given user, and can charge it to that user for testing. `POST /subscriptions/admin/credits/estimate` never writes.

## Overview

Subscriptions opens on **Overview**:
- customers with an active plan, and how many of them pay;
- projected monthly revenue per currency (the monthly equivalent of active paid plans billed by the payment provider; subscriptions ending this period and admin assignments are excluded);
- new and canceled subscriptions today and this month;
- a monthly chart.

New and canceled subscriptions are counted per day in `SUB_STATS` when they happen. A payment problem is neither new nor canceled. The customer line uses a daily snapshot saved when the overview is opened, so there is no history before the first visit.

## Recovery and notifications

Billing requests persist their key and plan snapshot before calling Stripe. Retry pending operations from the profile; never issue a new key to bypass a pending payment. Operations older than 23 hours require manual Stripe reconciliation because provider idempotency keys expire. There is no automatic operator reconciliation screen yet.

Webhook events are deduplicated. A durable email outbox respects admin and user notification preferences. Local maintenance runs every minute; AWS EventBridge invokes Lambda every five minutes. Pagination cursors keep maintenance progressing across accounts and notices. Email delivery is at least once: an interrupted send can repeat a notice. Configure SES sender permissions/verification for production; local uses the existing mailbox adapter.

Invoices show the latest 100 per customer, with totals labeled as partial when more exist. Usage and courtesy-reset audit records are persisted. Admin subscription endpoints are owner-only and exposed through the admin API, not the public application API.

Tests use isolated JSON stores and Stripe SDK signature generation; live Stripe charges, 3DS and AWS deployment require an integration check with your test account.

## Administrative assignments

Subscriptions → Accounts lists all non-deleted users, including those without a subscription. Search and cursor pagination process one bounded user-storage page per request; continue to search subsequent pages. Select a user to assign any configured plan or additional product credits.

Plan assignments grant the same product entitlements for the plan's period, with fresh limits, without charging Stripe. They temporarily override entitlement selection, preserve underlying billing, and expire without automatic renewal. Existing Stripe recurring charges continue. User-initiated plan changes are blocked during the override. Additional credits do not expire, require an active plan containing the product, and are consumed once the plan allowance (the tightest of its daily, weekly and period windows) is used up. Daily/weekly limits bound the plan allowance only, not additional credits. Courtesy resets do not refund spent additional credits.

Each assignment records administrator, reason, date, currency and nominal value in minor units in `SUB_GRANTS#<userId>`. This is an administrative ledger, not a paid invoice or foreign-exchange conversion. Account updates and receipts are atomic and request IDs prevent duplicate grants. Both JSON and DynamoDB adapters use the same service. Administrative grant endpoints remain owner-only behind the admin proxy.

## Plan catalog and Stripe publication

Plans are listed in the admin. Open one for General, Pricing, Limits, Metadata, Stripe and History tabs. Max is the third starter plan: USD 50 per exact 30-day period, 50,000 period credits, 5,000 daily and 25,000 weekly. All numbers are editable examples.

Each stable plan ID has a family and an automatically incremented patch version, starting at `0.0.1`. Changes to name, description, price, currency, period, metered products/limits or custom metadata create the next version when saved. Availability alone does not increment the version. Older snapshots remain in `SUB_PLAN_HISTORY#<id>` and published price mappings in `SUB_PLAN_PRICES`, so existing subscriptions retain their historical entitlements. Disable plans instead of deleting their IDs.

The Stripe tab offers **Save & sync Stripe**. Use the backend `STRIPE_SECRET_KEY`, or enter a secret/restricted key for that request only. Temporary keys are not stored in the database or browser storage and are cleared after publication; use HTTPS for a remote admin. Products and Prices read/write permissions are required. Once a plan has been published, subsequent saves synchronize too; automatic saves need the server key, or a newly entered temporary key. Billing still requires `SUBSCRIPTIONS_PROVIDER=stripe`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` and the webhook setup above. Catalog publication does not enable paid billing by itself.

Each version creates a new Stripe Product and recurring Price. Metadata includes `B_version`, `family`, `State` (`Enabled`/`Disabled`), `rtAppPlanId` and `rtAppCatalog`. Native Stripe `active` is updated as well; metadata alone is not an access restriction. Previous managed products/prices are archived after the replacement exists. Existing subscriptions are not migrated, canceled or repriced. Pricing uses `interval=day` with the exact configured day count, not calendar-month arithmetic. Names and custom metadata also create versions to retain an immutable offer history.

Publication persists an operation snapshot and locks configuration changes until it finishes. Retry **Resume Stripe sync** after a failure; deterministic product IDs and price lookup keys avoid duplicate resources. Keys are never included in that snapshot. Stripe and the database cannot commit atomically, so during a partial failure remote resources may already exist while the UI still shows a pending operation. Resolve that operation before making further catalog edits. No automatic scheduled retry or cross-account catalog migration is provided.

### Editing plans and currencies

New plan IDs follow the name while the plan is a draft (`Plan Élite` → `plan-elite`), with numeric suffixes to avoid collisions, including archived IDs. After the first save the ID stays fixed. Renaming a saved plan changes its public name, not existing references.

Archive hides a plan from the default admin list and disables new selections without canceling existing subscriptions. Show archived plans to unarchive; unarchived plans stay disabled until enabled explicitly. History → Restore as new version copies the historical configuration into a fresh version, preserving current availability and all previous versions. Configuration updates use optimistic concurrency; restoring published plans follows the normal Stripe publication flow.

Currency fields use a searchable picker with ISO/CLDR currency codes and English/Spanish name matching. Catalog inclusion does not imply Stripe/account availability. Monetary display and conversion use explicit, browser-independent charge units, including zero-decimal currencies and Stripe's special ISK/UGX representation. See https://docs.stripe.com/currencies. Values are never automatically converted between currencies.
