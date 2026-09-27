import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "@gsalgadotoledo/rt-app-dynamodb";
import { Subscriptions, defaults, validateSettings, providerCost, rateCredits, exceededWindow, METER } from "../dist/index.js";

const START = Date.parse("2026-01-01T00:00:00.000Z");
const HOUR = 3600000;
const alice = { id: "alice", email: "alice@example.test", role: "user" };
const service = { id: "service:agent", role: "service", grants: [METER] };

const rates = [
  { id: "standard", name: "Standard model", inputPer1k: 1, outputPer1k: 3, minimum: 1, costInputPer1k: 0.3, costOutputPer1k: 1.5 },
  { id: "advanced", name: "Advanced model", inputPer1k: 5, outputPer1k: 15, minimum: 1, costInputPer1k: 1.5, costOutputPer1k: 7.5 },
  { id: "lite", name: "Lite model", inputPer1k: 0.5, outputPer1k: 1, minimum: 1 },
];
const product = (extra = {}) => ({
  id: "api",
  name: "API credits",
  credits: 1000,
  dailyLimit: 100,
  weeklyLimit: 500,
  daySeconds: 86400,
  weekSeconds: 604800,
  ...extra,
});
const capped = (extra = {}, productExtra = {}) => ({
  id: "capped",
  name: "Capped",
  amount: 0,
  currency: "usd",
  periodDays: 30,
  enabled: true,
  maxProviderCostMinor: 10,
  products: [product({ shortLimit: 30, shortSeconds: 18000, rateCaps: [{ rateId: "advanced", day: 40, period: 100 }], ...productExtra })],
  ...extra,
});
const values = (plan = capped(), credits = { pack: defaults.credits.pack, rates }) => ({
  paymentRequired: false,
  notifications: true,
  reminderDays: 3,
  plans: [...structuredClone(defaults.plans), plan],
  credits,
});

async function setup(plan) {
  const store = new MemoryStore();
  let now = START;
  const subscriptions = new Subscriptions(store, undefined, undefined, () => now);
  await subscriptions.saveSettings({ version: 0, values: values(plan) }, "admin");
  await subscriptions.change(alice, "capped", "plan-1");
  const call = (method, path, body, actor = service) => {
    const endpoint = subscriptions.feature().endpoints.find((e) => {
      if (e.method !== method) return false;
      const pattern = new RegExp("^" + e.path.replace(/:[a-z]+/g, "([^/]+)") + "$");
      return pattern.test(path);
    });
    const names = [...endpoint.path.matchAll(/:([a-z]+)/g)].map((m) => m[1]);
    const match = new RegExp("^" + endpoint.path.replace(/:[a-z]+/g, "([^/]+)") + "$").exec(path);
    const params = Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(match[i + 1])]));
    return endpoint.handle({ request: { body: body ?? {}, query: {}, headers: {} }, params, actor });
  };
  return { store, subscriptions, call, at: (ms) => (now = ms) };
}

const status = (promise, code, message) => assert.rejects(promise, (e) => e.status === code && (!message || e.message === message));

test("pure helpers price, cost and find the overflowing window", () => {
  assert.deepEqual(rateCredits(rates[0], 1000, 1000), { exact: 4, credits: 4 });
  assert.equal(rateCredits({ ...rates[2], minimum: 3 }, 0, 0).credits, 3);
  assert.equal(providerCost(rates[0], 2000, 1000), 2.1);
  assert.equal(providerCost(rates[2], 2000, 1000), null);
  assert.equal(providerCost({ ...rates[0], costOutputPer1k: undefined }, 1000, 1000), 0.3);
  const w = [{ kind: "day", used: 5, reserved: 5, limit: 20 }, { kind: "period", used: 5, reserved: 5, limit: 11 }];
  assert.equal(exceededWindow(w, 1), null);
  assert.equal(exceededWindow(w, 2), "period");
  assert.equal(exceededWindow(w, 11), "day");
});

test("settings validation of the finance limits", () => {
  const check = (plan, message, credits) => assert.throws(() => validateSettings(values(plan, credits)), { message });
  check(capped({}, { shortSeconds: undefined }), "Invalid short window");
  check(capped({}, { shortSeconds: 18000.5 }), "Invalid short window");
  check(capped({}, { rateCaps: [null] }), "Invalid model cap");
  check(capped({}, { rateCaps: [[]] }), "Invalid model cap");
  check(capped({}, { rateCaps: [{ rateId: "advanced", period: -1 }] }), "Invalid model cap");
  check(capped({}, { shortLimit: undefined, shortSeconds: undefined, rateCaps: [{ rateId: "advanced", short: 1 }] }), "Invalid model cap");
  check(capped({ maxProviderCostMinor: 1e13 }), "Invalid margin rule");
  check(capped({ maxProviderCostMinor: 1.5 }), "Invalid margin rule");
  const ok = validateSettings(values(capped({}, { rateCaps: [] })));
  assert.equal(ok.plans.at(-1).products[0].rateCaps, undefined);
  // Saved settings without the new fields keep their exact shape.
  assert.deepEqual(Object.keys(validateSettings(structuredClone({ ...defaults, credits: defaults.credits })).plans[0].products[0]), [
    "id", "name", "credits", "dailyLimit", "weeklyLimit", "daySeconds", "weekSeconds",
  ]);
});

test("margin and cap changes make a new plan version; unrelated saves do not", async () => {
  const { subscriptions } = await setup();
  const settings = await subscriptions.settings();
  const next = structuredClone(settings.values);
  next.plans.find((p) => p.id === "capped").maxProviderCostMinor = 20;
  const saved = await subscriptions.saveSettings({ version: settings.version, values: next }, "admin");
  assert.equal(saved.values.plans.find((p) => p.id === "capped").version, "0.0.2");
  const again = await subscriptions.saveSettings({ version: saved.version, values: saved.values }, "admin");
  assert.equal(again.values.plans.find((p) => p.id === "capped").version, "0.0.2");
});

test("short window, model caps, costs, margin and degrade over one day", async () => {
  const { subscriptions, store, at } = await setup();
  const reserved = await subscriptions.reserve("alice", "api", { key: "t1", estimate: { rateId: "advanced", inputTokens: 2000, maxOutputTokens: 1000 } });
  assert.equal(reserved.credits, 25);
  assert.equal((await store.get("SUB_ACCOUNTS", "alice")).data.reservations[0].rateId, "advanced");
  // While the hold counts, the model window reports it as reserved.
  const during = await subscriptions.usageSummary("alice");
  assert.equal(during.products[0].models[0].windows[0].reserved, 25);
  at(START + 5.5 * HOUR);
  const settled = await subscriptions.settle("alice", "t1", { inputTokens: 2000, outputTokens: 500 });
  assert.deepEqual([settled.used, settled.costMinor, settled.expired], [18, 6.75, true]);
  at(START + 11 * HOUR);
  await status(subscriptions.reserve("alice", "api", { key: "t2", estimate: { rateId: "advanced", inputTokens: 2000, maxOutputTokens: 1000 } }), 429,
    "Model limit reached: Advanced model day limit. Use another model or wait for the reset.");
  const preflight = await subscriptions.preflight("alice", "api", { estimate: { rateId: "advanced", inputTokens: 2000, maxOutputTokens: 1000 } });
  assert.equal(preflight.reason, "model");
  assert.deepEqual(preflight.degrade, { rateId: "standard", name: "Standard model", credits: 5, costMinor: 2.1 });
  assert.equal(preflight.margin.exceeded, true);
  // Plain credits have neither cost nor model.
  const plain = await subscriptions.preflight("alice", "api", { credits: 5 });
  assert.deepEqual([plain.costMinor, plain.model, plain.degrade], [null, null, null]);
  // An estimate with an unknown rate is a 404, like reserve.
  await status(subscriptions.preflight("alice", "api", { estimate: { rateId: "nope", inputTokens: 1 } }), 404);
  const usage = await subscriptions.consumeUsage("alice", "api", { rateId: "advanced", inputTokens: 4000, outputTokens: 0 }, "u1");
  assert.equal(usage.costMinor, 6);
  const replay = await subscriptions.consumeUsage("alice", "api", { rateId: "advanced", inputTokens: 4000, outputTokens: 0 }, "u1");
  assert.equal(replay.replayed, true);
  await status(subscriptions.consumeUsage("alice", "api", { rateId: "advanced", inputTokens: 1000 }, "u2"), 429);
  const lite = await subscriptions.consumeUsage("alice", "api", { rateId: "lite", inputTokens: 1000 }, "u3");
  assert.equal(lite.costMinor, undefined);
  const summary = await subscriptions.usageSummary("alice");
  assert.deepEqual(summary.alerts, [{ productId: "api", window: "day", percent: 95, threshold: 95, rateId: "advanced" }]);
  assert.deepEqual(summary.margin.costMinor, 12.75);
  const me = await subscriptions.me("alice");
  assert.equal(me.usage[0].shortUsed, 21);
  // A courtesy "all" reset clears the short window and the per-model counters too.
  await subscriptions.reset("alice", { requestId: "r1", scope: "all", reason: "Courtesy" }, "admin");
  const counters = (await store.get("SUB_ACCOUNTS", "alice")).data.counters.api;
  assert.deepEqual([counters.short, counters.day, counters.rates.advanced], [0, 0, { short: 0, day: 0, week: 0, period: 0 }]);
});

test("caps and margins are read from the current settings and removed plans fall back to the subscribed one", async () => {
  const { subscriptions, store } = await setup();
  const settings = await subscriptions.settings();
  const next = structuredClone(settings.values);
  const plan = next.plans.find((p) => p.id === "capped");
  plan.maxProviderCostMinor = undefined;
  plan.products[0].rateCaps = [{ rateId: "standard", week: 3 }];
  await subscriptions.saveSettings({ version: settings.version, values: next }, "admin");
  // Advanced is no longer capped: no rate on the hold, nothing counted.
  await subscriptions.reserve("alice", "api", { key: "a1", estimate: { rateId: "advanced", inputTokens: 2000, maxOutputTokens: 1000 } });
  assert.equal((await store.get("SUB_ACCOUNTS", "alice")).data.reservations[0].rateId, undefined);
  await status(subscriptions.consumeUsage("alice", "api", { rateId: "standard", inputTokens: 4000 }, "s1"), 429,
    "Model limit reached: Standard model week limit. Use another model or wait for the reset.");
  assert.equal((await subscriptions.usageSummary("alice")).margin, null);
  // The account keeps a copy of the plan: an account whose plan id left the settings still has its caps.
  const account = await store.get("SUB_ACCOUNTS", "alice");
  await store.transact([{ row: { ...account, version: account.version + 1, data: { ...account.data, plan: { ...account.data.plan, id: "retired" } } }, expected: account.version }]);
  const summary = await subscriptions.usageSummary("alice");
  assert.equal(summary.products[0].models[0].rateId, "advanced");
  assert.equal(summary.margin.capMinor, 10);
});

test("a zero margin cap reads as fully used and caps skip windows the plan lacks", async () => {
  const { subscriptions } = await setup(capped({ maxProviderCostMinor: 0 }, { shortLimit: undefined, shortSeconds: undefined, rateCaps: [{ rateId: "advanced", day: 40 }] }));
  const summary = await subscriptions.usageSummary("alice");
  assert.deepEqual([summary.margin.percent, summary.margin.threshold], [100, 100]);
  assert.deepEqual(summary.products[0].windows.map((w) => w.kind), ["day", "week", "period"]);
  // A live cap that adds a short window to a plan subscribed without one ignores that window.
  const settings = await subscriptions.settings();
  const next = structuredClone(settings.values);
  const plan = next.plans.find((p) => p.id === "capped");
  plan.products[0] = { ...plan.products[0], shortLimit: 10, shortSeconds: 3600, rateCaps: [{ rateId: "advanced", short: 1, day: 40 }] };
  await subscriptions.saveSettings({ version: settings.version, values: next }, "admin");
  const after = await subscriptions.usageSummary("alice");
  assert.deepEqual(after.products[0].models[0].windows.map((w) => w.kind), ["day"]);
  await subscriptions.consumeUsage("alice", "api", { rateId: "advanced", inputTokens: 1000 }, "u1");
  const inactive = await subscriptions.preflight("nobody", "api", { estimate: { rateId: "advanced", inputTokens: 1 } });
  assert.deepEqual([inactive.reason, inactive.model, inactive.margin, inactive.degrade], ["inactive", null, null, null]);
});

test("economics groups users by plan and orders them by cost", async () => {
  const { subscriptions } = await setup();
  await subscriptions.consumeUsage("alice", "api", { rateId: "advanced", inputTokens: 2000 }, "a1");
  await subscriptions.change({ id: "bob", email: "bob@example.test", role: "user" }, "starter", "p-bob");
  await subscriptions.consumeUsage("bob", "api", { rateId: "standard", inputTokens: 10000 }, "b1");
  await subscriptions.recordCredits("carol", { requestId: "buy", productId: "api", credits: 5, kind: "purchase", reason: "Top-up", amountMinor: 300, currency: "usd" });
  const economics = await subscriptions.economics();
  assert.deepEqual(economics.users.map((u) => u.userId), ["alice", "bob", "carol"]);
  assert.deepEqual(economics.plans.map((p) => p.planId), ["capped", "none", "starter"]);
  assert.deepEqual(economics.totals, { users: 3, costMinor: { usd: 6 }, revenueMinor: { usd: 300 }, marginMinor: { usd: 294 } });
  await status(subscriptions.economics(0), 400);
  const endpoint = subscriptions.feature().endpoints.find((e) => e.path === "/subscriptions/admin/economics");
  assert.equal((await endpoint.handle({ request: { query: { limit: "1" } } })).users.length, 1);
  assert.equal((await endpoint.handle({ request: { query: {} } })).users.length, 3);
});

test("service metering endpoints: account in the path, debits only, key as actor", async () => {
  const { call, store } = await setup();
  await assert.rejects(call("GET", "/service/subscriptions/accounts/bad id/usage"), { message: "Invalid identifier" });
  assert.equal((await call("GET", "/service/subscriptions/accounts/alice/usage")).userId, "alice");
  assert.equal((await call("POST", "/service/subscriptions/accounts/alice/preflight", { productId: "api", credits: 1 })).fits, true);
  await call("POST", "/service/subscriptions/accounts/alice/reservations", { key: "k:1", productId: "api", credits: 3 });
  assert.equal((await store.get("SUB_RESERVATION#alice", "k:1")).data.actorId, "service:agent");
  await call("POST", "/service/subscriptions/accounts/alice/reservations/k%3A1/settle", { credits: 2 });
  await call("POST", "/service/subscriptions/accounts/alice/reservations", { key: "k:2", productId: "api", credits: 3 });
  assert.equal((await call("POST", "/service/subscriptions/accounts/alice/reservations/k:2/release")).status, "released");
  await status(call("POST", "/service/subscriptions/accounts/alice/ledger", { requestId: "c1", productId: "api", credits: 5, reason: "Free" }), 403,
    "Service keys can only record debits");
  const debit = await call("POST", "/service/subscriptions/accounts/alice/ledger", {
    requestId: "d1", productId: "api", credits: -1, reason: "Tool", amountMinor: 5, currency: "usd", details: { a: 1, b: true, c: { x: 1 } },
  });
  assert.equal(debit.credits, 1);
  const entries = (await store.list("SUB_LEDGER#alice")).items.map((r) => r.data);
  const usage = entries.find((e) => e.requestId === "d1");
  assert.deepEqual([usage.actorId, usage.source, usage.amountMinor, usage.details], ["service:agent", "api", undefined, { a: 1, b: true, c: "[object Object]" }]);
  // Owner ledger records still sanitize details the same way.
  const record = await call("POST", "/subscriptions/admin/accounts/alice/ledger", { requestId: "o1", productId: "api", credits: 2, kind: "grant", reason: "Owner", details: [1] }, { id: "rt-app-root", role: "owner" });
  assert.equal(record.credits, 2);
});
