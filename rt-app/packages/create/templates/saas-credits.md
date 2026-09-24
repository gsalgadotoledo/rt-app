---
id: saas-credits
name: SaaS with credits
description: AI/API product sold by plans with weekly credits, top-ups and per-model rates.
kind: fullstack
requirements: [node]
crud:
  - name: projects
    title: Projects
    fields: { name: string, description: string?, archived: boolean }
---
# SaaS with credits

The base project plus `packages/projects`. Billing uses the core **subscriptions** module: plans grant a weekly credit allowance that expires, users can top up credits that never expire, and every movement is on the user's statement (Admin → Subscriptions → Accounts → Balance).

## What to build

1. **Plans:** in Admin → Subscriptions → Plans, define the plans with their weekly credits (`weeklyLimit`) and price. In Settings → Credits, define one rate per model or function (credits per 1k input/output tokens) and the pack price. Validate them in the credit sandbox.
2. **Metered work:** each expensive operation (an LLM call, an export) charges credits before running:
   `await app.subscriptions.consumeUsage(userId, "api", { rateId, inputTokens, outputTokens }, requestId)`.
   Use a stable `requestId` per operation so retries never charge twice. A 429 means "no credits": show a top-up call to action.
3. **Top-ups:** after a successful payment, record the purchase:
   `await app.subscriptions.recordCredits(userId, { requestId: paymentId, productId: "api", credits, kind: "purchase", reason, amountMinor, currency })`.
4. **SPA:** projects list, the current balance and the statement for the signed-in user (`GET /subscriptions/me`).
5. **SSR:** public pricing page generated from the enabled plans.

## Done when

A user subscribes, spends credits through a metered endpoint, runs out, tops up and continues. Their statement shows allowance, usage, expiry and purchase, and tests cover the charge path including retries.
