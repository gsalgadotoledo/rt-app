import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "@gsalgadotoledo/rt-app-dynamodb";
import { LocalBilling } from "../dist/index.js";

test("local billing persists receipts, replays without duplicate invoices and isolates currencies", async (t) => {
  const store = new MemoryStore(),
    billing = new LocalBilling(store);
  const customer = await billing.customer({ id: "alice" });
  assert.equal(customer, "local_alice");
  assert.deepEqual(await billing.snapshot(customer), {
    invoices: [],
    paymentMethods: [],
    totals: [],
  });
  await assert.rejects(billing.cancel(customer), { status: 404 });
  await assert.rejects(billing.simulate(customer, "active"), { status: 404 });
  const plan = { id: "pro", amount: 100, currency: "usd", periodDays: 30 };
  const first = await billing.change(customer, plan, undefined, "k1");
  assert.deepEqual(
    await billing.change(customer, plan, undefined, "k1"),
    first,
  );
  const initial = await billing.snapshot(customer);
  assert.equal(initial.invoices.length, 1);
  await billing.change(
    customer,
    { ...plan, stripePriceId: "price_local", currency: "eur" },
    first.subscriptionId,
    "k2",
  );
  const second = await billing.snapshot(customer);
  assert.equal(second.periodEnd, initial.periodEnd);
  assert.equal(second.invoices.length, 2);
  assert.deepEqual(second.totals, [
    { currency: "eur", paid: 100, due: 0 },
    { currency: "usd", paid: 100, due: 0 },
  ]);
  assert.deepEqual(await billing.setup(), { simulated: true });
  assert.equal(await billing.setPaymentMethod(), undefined);
  assert.throws(() => billing.verify(), /does not accept/);
  await assert.rejects(billing.simulate(customer, "invented"), { status: 400 });
  await billing.simulate(customer, "past_due");
  assert.equal((await billing.snapshot(customer)).status, "past_due");
  await billing.cancel(customer);
  const now = t.mock.method(Date, "now", () => second.periodEnd);
  assert.equal((await billing.snapshot(customer)).status, "canceled");
  now.mock.restore();
});

test("local billing takes an injected clock for periods, invoices and cancellation", async () => {
  const store = new MemoryStore();
  let now = Date.parse("2026-01-01T00:00:00.000Z");
  const billing = new LocalBilling(store, () => now);
  const plan = { id: "pro", amount: 100, currency: "usd", periodDays: 30 };
  await billing.change("local_alice", plan, undefined, "k1");
  const first = await billing.snapshot("local_alice");
  assert.equal(first.periodStart, now);
  assert.equal(first.periodEnd, now + 30 * 86400000);
  assert.equal(first.invoices[0].createdAt, now);
  await billing.cancel("local_alice");
  assert.equal((await billing.snapshot("local_alice")).status, "active");
  now += 30 * 86400000;
  assert.equal((await billing.snapshot("local_alice")).status, "canceled");
});
