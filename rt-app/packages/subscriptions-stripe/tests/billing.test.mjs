import test from "node:test";
import assert from "node:assert/strict";
import { StripeBilling } from "../dist/index.js";

const plan = {
  id: "pro",
  stripePriceId: "price_pro",
  amount: 2000,
  currency: "usd",
  periodDays: 30,
};
function fixture() {
  const calls = [];
  const state = {
    price: {
      active: true,
      unit_amount: 2000,
      currency: "usd",
      recurring: {
        interval: "month",
        interval_count: 1,
        usage_type: "licensed",
      },
    },
    customer: { invoice_settings: { default_payment_method: "pm_1" } },
    subscription: {
      id: "sub_1",
      customer: "cus_1",
      status: "active",
      items: {
        data: [
          {
            id: "si_1",
            price: { id: "price_pro" },
            current_period_start: 100,
            current_period_end: 200,
          },
        ],
      },
      latest_invoice: { confirmation_secret: { client_secret: "client_1" } },
      cancel_at_period_end: false,
    },
    intent: {
      id: "seti_1",
      customer: "cus_1",
      status: "succeeded",
      payment_method: "pm_1",
      client_secret: "setup_secret",
    },
    invoices: { data: [], has_more: false },
    methods: { data: [] },
  };
  const capture =
    (name, result) =>
    async (...args) => {
      calls.push({ name, args });
      return typeof result === "function" ? result() : result;
    };
  const provider = new StripeBilling(
    "sk_test_fake",
    "whsec_fake",
    "pk_test_fake",
  );
  provider.stripe = {
    prices: { retrieve: capture("price", () => state.price) },
    customers: {
      create: capture("customer.create", { id: "cus_1" }),
      retrieve: capture("customer.read", () => state.customer),
      update: capture("customer.update", {}),
    },
    subscriptions: {
      retrieve: capture("subscription.read", () => state.subscription),
      create: capture("subscription.create", () => state.subscription),
      update: capture("subscription.update", () => state.subscription),
    },
    setupIntents: {
      create: capture("setup.create", () => state.intent),
      retrieve: capture("setup.read", () => state.intent),
    },
    invoices: { list: capture("invoices", () => state.invoices) },
    paymentMethods: { list: capture("methods", () => state.methods) },
  };
  return { provider, state, calls };
}

test("customer, setup, new subscription and cancellation preserve idempotency keys", async () => {
  const { provider, calls } = fixture();
  assert.equal(
    await provider.customer(
      { id: "alice", email: "alice@example.test" },
      "customer-key",
    ),
    "cus_1",
  );
  assert.deepEqual(calls[0].args, [
    { email: "alice@example.test", metadata: { rtAppUserId: "alice" } },
    { idempotencyKey: "customer-key" },
  ]);
  assert.deepEqual(await provider.setup("cus_1", "k"), {
    setupId: "seti_1",
    clientSecret: "setup_secret",
  });
  assert.equal(calls.at(-1).args[1].idempotencyKey, "cus_1:setup:k");
  assert.deepEqual(await provider.change("cus_1", plan, undefined, "k"), {
    subscriptionId: "sub_1",
    clientSecret: "client_1",
    status: "active",
  });
  assert.equal(calls.at(-1).args[1].idempotencyKey, "cus_1:k");
  assert.equal(calls.at(-1).args[0].payment_behavior, "default_incomplete");
  assert.deepEqual(await provider.cancel("cus_1", "sub_1", "k"), { ok: true });
  assert.deepEqual(calls.at(-1).args, [
    "sub_1",
    { cancel_at_period_end: true },
    { idempotencyKey: "cus_1:cancel:k" },
  ]);
  assert.throws(() => new StripeBilling("", "", ""), /required/);
});

test("plan validation rejects mismatched billing terms and free plans without a verified payment method", async () => {
  const { provider, state } = fixture();
  await provider.validatePlan(plan);
  await assert.rejects(
    provider.validatePlan({ ...plan, stripePriceId: undefined }),
    { status: 400 },
  );
  for (const patch of [
    { active: false },
    { unit_amount: 1 },
    { currency: "eur" },
    { recurring: null },
    {
      recurring: {
        interval: "year",
        interval_count: 1,
        usage_type: "licensed",
      },
    },
    {
      recurring: {
        interval: "month",
        interval_count: 1,
        usage_type: "metered",
      },
    },
  ]) {
    const original = state.price;
    state.price = { ...original, ...patch };
    await assert.rejects(provider.validatePlan(plan), { status: 400 });
    state.price = original;
  }
  state.price.unit_amount = 0;
  const free = { ...plan, amount: 0 };
  await assert.rejects(provider.validatePlan(free), { status: 400 });
  await provider.validatePlan(free, "cus_1");
  state.customer = { deleted: true };
  await assert.rejects(provider.validatePlan(free, "cus_1"), { status: 400 });
  state.customer = { invoice_settings: {} };
  await assert.rejects(provider.validatePlan(free, "cus_1"), { status: 400 });
});

test("plan changes enforce ownership/status, update the existing item, and restart canceled subscriptions", async () => {
  const { provider, state, calls } = fixture();
  await provider.change("cus_1", plan, "sub_1", "k");
  assert.deepEqual(calls.at(-1).args[1].items, [
    { id: "si_1", price: "price_pro" },
  ]);
  assert.equal(calls.at(-1).args[1].payment_behavior, "pending_if_incomplete");
  state.subscription.status = "paused";
  await assert.rejects(provider.change("cus_1", plan, "sub_1", "k"), {
    status: 409,
  });
  state.subscription.status = "active";
  state.subscription.items.data.push({ id: "extra" });
  await assert.rejects(provider.change("cus_1", plan, "sub_1", "k"), {
    status: 409,
  });
  state.subscription.items.data.pop();
  for (const status of ["canceled", "incomplete_expired"]) {
    state.subscription.status = status;
    await provider.change("cus_1", plan, "sub_1", "k");
    assert.equal(calls.at(-1).name, "subscription.create");
  }
  state.subscription.customer = "someone-else";
  await assert.rejects(provider.change("cus_1", plan, "sub_1", "k"), {
    status: 403,
  });
});

test("payment method verification gates writes and preserves subscription ownership", async () => {
  const { provider, state, calls } = fixture();
  for (const patch of [
    { status: "processing" },
    { payment_method: null },
    { customer: "other" },
  ]) {
    const original = state.intent;
    state.intent = { ...original, ...patch };
    await assert.rejects(provider.setPaymentMethod("cus_1", "seti_1"), {
      status: 400,
    });
    assert.equal(
      calls.some((c) => c.name.endsWith(".update")),
      false,
    );
    state.intent = original;
  }
  await provider.setPaymentMethod("cus_1", "seti_1");
  assert.deepEqual(calls.at(-1).args[1], {
    invoice_settings: { default_payment_method: "pm_1" },
  });
  await provider.setPaymentMethod("cus_1", "seti_1", "sub_1");
  assert.deepEqual(calls.at(-1).args, [
    "sub_1",
    { default_payment_method: "pm_1" },
  ]);
  calls.length = 0;
  state.subscription.customer = "other";
  await assert.rejects(provider.setPaymentMethod("cus_1", "seti_1", "sub_1"), {
    status: 403,
  });
  assert.equal(
    calls.some((c) => c.name.endsWith(".update")),
    false,
  );
});

test("snapshot keeps currencies separate, open balances only and indicates pagination", async () => {
  const { provider, state } = fixture();
  state.invoices = {
    has_more: true,
    data: [
      {
        id: "i1",
        currency: "usd",
        status: "paid",
        amount_paid: 1000,
        amount_remaining: 0,
        created: 10,
      },
      {
        id: "i2",
        currency: "usd",
        status: "open",
        amount_paid: 100,
        amount_remaining: 900,
        created: 20,
      },
      {
        id: "i3",
        currency: "eur",
        status: "void",
        amount_paid: 0,
        amount_remaining: 200,
        created: 30,
      },
    ],
  };
  state.methods.data = [
    {
      id: "pm_1",
      card: { brand: "visa", last4: "4242", exp_month: 1, exp_year: 2030 },
    },
    { id: "pm_empty" },
  ];
  const summary = await provider.snapshot("cus_1");
  assert.deepEqual(summary.totals, [
    { currency: "usd", paid: 1100, due: 900 },
    { currency: "eur", paid: 0, due: 0 },
  ]);
  assert.equal(summary.partial, true);
  assert.equal(summary.invoices[0].createdAt, 10000);
  assert.equal(summary.paymentMethods[0].last4, "4242");
  const detail = await provider.snapshot("cus_1", "sub_1");
  assert.equal(detail.periodEnd, 200000);
  state.subscription.status = "past_due";
  assert.equal((await provider.snapshot("cus_1", "sub_1")).status, "past_due");
  for (const [invoice, expected] of [
    ["in_1", null],
    [null, null],
    [{}, null],
    [{ payment_intent: { client_secret: "legacy" } }, "legacy"],
  ]) {
    state.subscription.latest_invoice = invoice;
    assert.equal(
      (await provider.change("cus_1", plan, undefined, "k")).clientSecret,
      expected,
    );
  }
});
