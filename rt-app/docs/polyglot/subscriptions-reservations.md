# Credit reservations: reserve, settle, pre-flight and thresholds

Contracts: `spec/contracts/subscriptions-reservations.contract.yaml` (module, subject
`subscriptions`) and `subscriptions-reservations-api.contract.yaml` (HTTP). Reference:
`packages/subscriptions/src/reservations.ts` and the reservation section of `index.ts`. Ports:
`rt_app.subscriptions.reservations` + `Subscriptions.reserve/settle/release/preflight/usage_summary`
(Python) and `subscriptions/reservations.go` (Go). The contract description holds the exact
algorithm; this page explains the design and what ports get wrong.

## Why

An agent product charges credits per model call. It needs:

- **per-step charging** with a stable key (`"<turnId>:<step>"`): a retry never charges twice, and a
  crash mid-step is reconciled on resume with the usage the provider reports;
- **reserve and settle**: hold the maximum (known input tokens + output cap) before the call, charge
  the real usage after it and release the difference; a crash never leaves credits blocked;
- **pre-flight**: before a batch, say whether its estimate fits and how much is missing;
- **thresholds**: warn at 80 % and 95 % of each window and offer a top-up with its cost.

## Design

**A hold is not a debit.** `consume` debits at once; a reservation only lowers what other charges
can spend until it is settled, released or expires. This keeps the existing money invariants
untouched: the credits of the statement still sum to the balance (weekly allowance left plus
additional credits), and holds are a separate column (`held`).

| Where | What |
| --- | --- |
| Account row `SUB_ACCOUNTS/<userId>` | `reservations`: array of holds `{key, productId, credits, at, expiresAt}` in creation order (an array, not an object: Go maps lose key order) |
| Receipt `SUB_RESERVATION#<userId>/<key>` | `{key, productId, credits, at, expiresAt, status, available, reason, source, actorId?, estimate?, releasedAt?, settlement?}`; status `active` → `settled` \| `released` \| `expired` |
| Ledger `SUB_LEDGER#<userId>` | `reservation` (0 credits, `held` +N, `expiresAt`), `settlement` (− charged, `held` −N or 0, split and details), `release` (0 credits, `held` −N; source `system` with reason `Reservation expired · …` when it expired) |

Every change writes the account row (optimistic version), the receipt and the entry in one
transaction, so two turns of the same user reserving at once serialize: the loser retries on
`Conflict`, sees the winner's hold and fails with 429 when the credits are gone.

**Spendable credits.** `spendable = max(0, allowanceLeft + balance − held)`, taken from the plan
allowance first (`free.allowance = min(allowanceLeft, spendable)`). A charge therefore uses the
allowance (which expires weekly) before additional credits (which do not) whenever every other
hold stays covered. `consume`, `settle`, `estimate` previews and every `available` field use this;
`allowanceLeft` and additional credits are reported raw.

**Expiry.** A hold counts while `now < expiresAt` (`ttlMs`, default 15 minutes, 1 s to 24 h), so
credits are free again the moment the TTL passes, with no write. The release is recorded (entry at
`expiresAt`, receipt `expired`) by the next reservation write of the user (`reserve`, `settle`,
`release`) or by `maintenance`, which also visits accounts without an own plan when they have
expired holds.

**Settlement.** `settle` removes the hold and charges the reported usage like `consume` (allowance
first) from what the other holds leave free. It also works after the hold expired: a process that
crashed after the model call resumes and settles with the provider's numbers. Usage above the
reservation is charged too; what the account cannot cover is returned as `uncovered` and never
charged, so balances never go negative. Token usage is priced with the reserved rate.

**Idempotency.** Keys allow letters, digits and `_ - . :` (1 to 128). `reserve` with the same key
and the same product and credits replays the receipt (`replayed: true`, current status); other
amounts fail with 409 `Reservation key already used with different amounts`. `settle` replays the
stored settlement for the same usage and fails with 409 for other usage; `release` replays a
released or expired reservation. A released reservation cannot be settled (409); a settled one
cannot be released (409).

**Ownership.** Personal endpoints act with source `user` and reach only reservations the user made
(404 for the others), so a user cannot release a reservation the backend holds for a model call
and then refuse the settlement. Owner endpoints (admin token) act with source `api`.

**Limits.** At most 25 active holds per user (429 `Too many active reservations`), which bounds the
account row and the release transaction (DynamoDB accepts 100 items per transaction).

## Surface

| Method | Returns |
| --- | --- |
| `reserve(userId, productId, {key, credits \| estimate: {rateId, inputTokens, maxOutputTokens}, ttlMs?, reason?}, meta?)` | `{key, productId, credits, status, at, expiresAt, available, replayed}` |
| `settle(userId, key, {credits} \| {inputTokens, outputTokens}, meta?)` | `{key, productId, reserved, used, credits, fromAllowance, fromBalance, uncovered, expired, status, at, available, valueMinor, currency, usage, replayed}` |
| `release(userId, key, meta?)` | `{key, productId, credits, status, releasedAt, replayed}` |
| `preflight(userId, productId, {credits} \| {estimate})` | `{productId, credits, fits, reason: null \| inactive \| payment \| product \| credits, available, missing, allowanceLeft, additionalCredits, reserved, windows, topUp}` |
| `usageSummary(userId)` (Python `usage_summary`, Go `UsageSummary`) | `{userId, active, products: [{productId, name, allowanceLeft, additionalCredits, reserved, available, threshold, windows}], reservations, alerts, pack}` |

`meta` is `{source?, actorId?}` (Go: `ReservationMeta{Source, ActorID}`). A window is `{kind: day |
week | period, used, reserved, limit, remaining, percent, threshold, resetAt}` with `reserved =
min(held, allowanceLeft)`, `percent = floor((used + reserved) * 100 / limit)` (100 for a 0 limit)
and `threshold` the highest of 80, 95, 100 reached (else 0). `topUp` (only when credits are missing
and the account is chargeable) is `{credits: missing, packs: ceil(missing / pack.credits),
amountMinor: packs * pack.amountMinor, valueMinor: round(missing * pack.amountMinor /
pack.credits), currency}`.

HTTP (see `subscriptions-reservations-api`):

| Endpoint | Access | Service call |
| --- | --- | --- |
| `GET /subscriptions/credits/usage` | authenticated | `usageSummary(me)` |
| `POST /subscriptions/credits/preflight` | authenticated | body `{productId, credits \| estimate}` |
| `POST /subscriptions/credits/reservations` | authenticated | body `{key, productId, credits \| estimate, ttlMs?, reason?}` |
| `POST /subscriptions/credits/reservations/:key/settle` | authenticated | body `{credits}` or `{inputTokens, outputTokens}` |
| `POST /subscriptions/credits/reservations/:key/release` | authenticated | |
| `GET /subscriptions/admin/accounts/:id/usage` | owner, admin only | tool `subscriptions_credits_usage` |
| `POST /subscriptions/admin/accounts/:id/preflight` | owner, admin only | tool `subscriptions_credits_preflight` |
| `POST /subscriptions/admin/accounts/:id/reservations` | owner, admin only | tool `subscriptions_credits_reserve` |
| `POST /subscriptions/admin/accounts/:id/reservations/:key/settle` | owner, admin only | tool `subscriptions_credits_settle` |
| `POST /subscriptions/admin/accounts/:id/reservations/:key/release` | owner, admin only | tool `subscriptions_credits_release` |

Only the documented body fields reach the service.

## Contract helpers

The `subscriptions` facade gains three helpers for these contracts:

- `failWrites(count, mode)`: the next `count` store transactions fail with 503 `Injected store
  failure`, `before` committing (nothing written) or `after` (written, reply lost). Every write
  point of reserve, settle, release, consume and maintenance is exercised this way.
- `race(calls)` runs `[{call, args}]` concurrently (Promise, threads, goroutines); `batch(calls)`
  runs them one after the other. Both return `{fulfilled, rejected: [{status, message}]}` sorted
  by message, so the outcome is deterministic even though the winner is not.
- `ledgerCheck(userId)`: `{entries, credits, held, reserved, allowance, additional, balanced,
  negative}` over the stored rows. `balanced` is `Σ credits == Σ (allowance − used) over
  ledgerWindows + Σ creditBalance` and `Σ held == Σ account holds`. The property cases assert it
  after every few steps.

## What ports get wrong

- **No negative zero.** A settlement that charges nothing writes `credits: 0`, not `-0` (Go's
  `encoding/json` prints `-0`).
- **Message numbers** use JavaScript `String(number)`: `Not enough credits: 10 missing. …`.
- **`reservations` is an array** and is written even when empty after a release (`[]`, not
  `null`), so the account row compares equal across languages.
- **Order of writes in one transaction** does not matter, but the order of ledger entries does
  (their sequence numbers): window rollover, then expired-hold releases in array order, then the
  method's own entry.
- **The receipt of the key being settled or released** is written once per transaction: the sweep
  skips it (a store rejects two writes of one row in a transaction).
- **Replays read no clock-dependent state** except the status of an expired active receipt, which
  reads as `expired`.
