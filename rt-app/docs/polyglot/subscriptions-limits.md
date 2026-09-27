# Finance limits and unit economics: contracts and ports

Contracts: `spec/contracts/subscriptions-limits.contract.yaml`, `subscriptions-economics.contract.yaml`
(module, subject `subscriptions`) and `subscriptions-limits-api.contract.yaml` (HTTP). Reference:
`packages/subscriptions/src/index.ts` ("Finance limits" section, `economics`, `validateLimits`).
User guide: `docs/subscriptions.md` "Finance limits" and "Unit economics". The contract
descriptions hold the exact algorithms; this page explains the design.

## Why

Roadmap N4 of the agent product: limits like chat products (a short window, weekly and period
windows, per model), a margin rule per plan (a maximum provider cost per user) with a warning and
a cheaper model before exceeding it, and unit economics (cost, revenue and margin per user and
plan) to validate the prices.

## Design

| Limit | Where | Read from | Enforced by |
| --- | --- | --- | --- |
| Short window | plan product `shortLimit`, `shortSeconds` | the plan as subscribed (like day/week) | allowance of consume, reserve, settle, preflight |
| Model caps | plan product `rateCaps` | the **current** settings (plan with the same id) | reserve (estimate), consumeUsage; counted by settle |
| Provider cost | rate `costInputPer1k`, `costOutputPer1k` | the current settings | recorded by settle (tokens) and consumeUsage |
| Margin rule | plan `maxProviderCostMinor` | the current settings | advisory: preflight `margin.exceeded` + `degrade` |

- **Why live caps.** Accounts keep a copy of their plan (grandfathering). Caps and the margin rule
  protect the business, so they must apply to current subscribers without a migration.
- **Short window start.** It starts with the first use after the previous one ended (normalizing
  an expired window sets `shortStart = now`), not on a fixed grid: an idle account always sees a
  full window.
- **Caps count every source.** A cap limits a model's credits whatever pays for them (allowance or
  additional credits); the windows keep bounding the allowance only. Holds of a capped rate carry
  `rateId` and count as `reserved` in the model windows, so parallel steps cannot overshoot.
- **Counters.** `counters[product].rates[rateId] = {short?, day, week, period}` counts the credits
  used at a capped rate on every window (a cap added later starts from real usage) and resets with
  the product window of the same name. Uncapped rates are not counted (no row changes for plans
  without caps).
- **Cost.** `providerCost = round4(in/1000 * costIn + out/1000 * costOut)` in minor units of the
  pack currency; settlements charge the full usage cost (uncovered usage still cost us). The
  account keeps `providerCost = {totalMinor: {<currency>: n}, periodStart, periodMinor}`.
- **Degrade.** Least degradation: among strictly cheaper rates (by cost, then credits) that fit
  the credits, their caps and the margin left, the most expensive one.
- **Economics.** A scan of `SUB_ACCOUNTS` like the overview: cost (all time), revenue
  (`ledgerTotals.paidMinor`: purchases and paid plans) and margin per currency, grouped by the
  current plan; the users with the highest cost. Per-conversation cost is the `costMinor` of each
  settlement (the caller keeps it with its turn).

Everything new is optional and only written when configured, so rows and outputs of accounts and
settings without it are unchanged (the existing contracts pin them). Nullable result fields
(`costMinor`, `model`, `margin`, `degrade`) are `null` when not applicable.

## What ports get wrong

- `round4(x) = floor(x * 1e4 + 0.5) / 1e4` after every addition, in the same order as the
  reference (account order for economics); never emit `-0` (a margin of `0 - 0`).
- `rateCredits` must keep the reference operation order: `(in / 1000) * inputPer1k + (out / 1000) * outputPer1k`.
- Validation order: existing plan checks, `reminderDays`, credits, then `validateLimits` per plan
  and product (short window, caps), then the plan's margin rule.
- Optional fields: JSON `null` equals missing; a `rateCaps: []` is dropped; rate costs are written
  as a pair (the missing one as 0).
- The short window is normalized after the day and week rollover; per-model counters reset with
  each product window, including a courtesy reset.
- Model windows are listed in the order short, day, week, period and skip `short` when the
  subscribed product has no short window.
