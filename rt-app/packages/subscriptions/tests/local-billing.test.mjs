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
