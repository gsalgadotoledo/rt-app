import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "@gsalgadotoledo/rt-app-dynamodb";
import { Subscriptions } from "../dist/index.js";

const plan = {
  id: "pro",
  name: "Pro",
  amount: 2000,
  currency: "usd",
  periodDays: 30,
  stripePriceId: "price_pro",
  enabled: true,
  products: [{ id: "api", name: "API credits", credits: 100, dailyLimit: 10, weeklyLimit: 50, daySeconds: 86400, weekSeconds: 604800 }],
};

test("one sync that starts and cancels a subscription writes the day's stats row once", async () => {
  const store = new MemoryStore();
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  await store.transact([
    { row: { pk: "SUB_CONFIG", sk: "settings", version: 1, data: { paymentRequired: true, notifications: true, reminderDays: 3, plans: [plan] } }, expected: null },
    { row: { pk: "SUB_ACCOUNTS", sk: "alice", version: 1, data: { userId: "alice", email: "alice@example.test", customerId: "cus_1", subscriptionId: "sub_1" } }, expected: null },
    { row: { pk: "SUB_STATS", sk: "day:2026-01-01", version: 1, data: { new: 2, canceled: 0 } }, expected: null },
  ]);
  // Stripe state before the first webhook arrived: active, but already canceling at period end.
  const provider = {
    mode: "stripe",
    snapshot: async () => ({
      invoices: [],
      paymentMethods: [],
      totals: [],
      partial: false,
      subscriptionId: "sub_1",
      priceId: "price_pro",
      status: "active",
      periodStart: now,
      periodEnd: now + 30 * 86400000,
      cancelAtPeriodEnd: true,
    }),
  };
  const service = new Subscriptions(store, provider, undefined, () => now);
  await service.sync("alice");
  assert.deepEqual((await store.get("SUB_STATS", "day:2026-01-01")).data, { new: 3, canceled: 1 });
  const account = (await store.get("SUB_ACCOUNTS", "alice")).data;
  assert.equal(account.status, "active");
  assert.equal(account.cancelAtPeriodEnd, true);
  const reasons = (await store.list("SUB_LEDGER#alice")).items.map((r) => r.data.reason);
  assert.deepEqual(reasons.slice(-2), ["Plan started: Pro", "Subscription canceled: Pro"]);
  // A second sync changes nothing in the statistics.
  await service.sync("alice");
  assert.deepEqual((await store.get("SUB_STATS", "day:2026-01-01")).data, { new: 3, canceled: 1 });
});
