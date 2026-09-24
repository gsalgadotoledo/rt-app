import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "@gsalgadotoledo/rt-app-dynamodb";
import { Subscriptions, LocalBilling, defaults, validateSettings, validateCredits, rollover, applyTotals, ledgerKey } from "../dist/index.js";

const WEEK = 7 * 86400000;
const user = { id: "alice", email: "alice@example.test", role: "user", grants: [] };

async function fixture({ paid = false, start = Date.UTC(2026, 8, 1) } = {}) {
  const store = new MemoryStore();
  let now = start;
  const service = new Subscriptions(store, paid ? new LocalBilling(store) : undefined, async () => {}, () => now);
  await store.transact([{ row: { pk: "USERS", sk: user.id, version: 1, data: { ...user, name: "Alice" } }, expected: null }]);
  return { store, service, advance: ms => (now += ms), at: () => now };
}

const statement = async (service, id = user.id) => (await service.ledger(id)).entries.map(e => [e.kind, e.credits]);

test("weekly allowance is granted, consumed, and its unused part expires at the end of the week", async () => {
  const { service, advance } = await fixture();
  await service.change(user, "starter", "plan"); // Starter: 500 per week, 100 per day
  await service.consume(user.id, "api", 80, "r1");
  let ledger = await service.ledger(user.id);
  assert.deepEqual(ledger.entries.map(e => [e.kind, e.credits]), [["allowance", 500], ["plan", 0], ["usage", -80]]);
  assert.equal(ledger.entries[2].available, 20, "daily window binds the allowance");
  assert.deepEqual(ledger.balances, [{ productId: "api", allowanceLeft: 20, additionalCredits: 0, available: 20 }]);

  advance(WEEK);
  // Nothing was written yet: the closed week is shown as pending.
  ledger = await service.ledger(user.id);
  assert.deepEqual(ledger.pending.map(e => [e.kind, e.credits]), [["expiry", -420], ["allowance", 500]]);
  await service.consume(user.id, "api", 10, "r2");
  ledger = await service.ledger(user.id);
  assert.deepEqual(ledger.entries.map(e => [e.kind, e.credits]).slice(3), [["expiry", -420], ["allowance", 500], ["usage", -10]]);
  assert.deepEqual(ledger.pending, []);
  assert.equal(ledger.totals.expired, 420);
  assert.equal(ledger.totals.creditsIn, 1000);
  assert.equal(ledger.totals.creditsOut, 90);
  assert.equal(ledger.totals.consumed, 90);
});

test("weeks without activity collapse into one expiry entry", async () => {
  const { service, advance } = await fixture();
  await service.change(user, "starter", "plan");
  advance(3 * WEEK + 1000);
  await service.consume(user.id, "api", 1, "later");
  const expiry = (await service.ledger(user.id)).entries.find(e => e.kind === "expiry");
  assert.equal(expiry.credits, -1500);
  assert.match(expiry.reason, /3 weeks expired/);
  assert.deepEqual(expiry.details, { unused: 500, skippedWeeks: 2 });
});

test("top-ups: purchase recorded with money, used after the weekly allowance, never expire", async () => {
  const { service, advance } = await fixture();
  await service.change(user, "starter", "plan");
  for (let day = 0; day < 5; day++) {
    await service.consume(user.id, "api", 100, "d" + day);
    advance(86400000);
  }
  await assert.rejects(service.consume(user.id, "api", 1, "blocked"), /week limit reached\. Add credits/);
  const purchase = { requestId: "pi_1", productId: "api", credits: 300, kind: "purchase", reason: "Top-up", amountMinor: 300, currency: "usd" };
  assert.equal((await service.recordCredits(user.id, purchase)).available, 300);
  assert.equal((await service.recordCredits(user.id, purchase)).replayed, true);
  await assert.rejects(service.recordCredits(user.id, { ...purchase, credits: 301 }), /Conflict/);
  const receipt = await service.consume(user.id, "api", 120, "after-topup");
  assert.deepEqual([receipt.fromAllowance, receipt.fromBalance], [0, 120]);
  advance(WEEK);
  await service.consume(user.id, "api", 10, "next-week");
  const ledger = await service.ledger(user.id);
  assert.deepEqual(ledger.balances[0], { productId: "api", allowanceLeft: 90, additionalCredits: 180, available: 270 });
  assert.equal(ledger.entries.find(e => e.kind === "expiry"), undefined, "the whole allowance was used");
  assert.deepEqual(ledger.totals.paidMinor, { usd: 300 });
});

test("recordCredits: debits charge like usage, validation rejects without writing", async () => {
  const { service, store } = await fixture();
  await service.change(user, "starter", "plan");
  const debit = await service.recordCredits(user.id, { requestId: "job-1", productId: "api", credits: -30, reason: "Batch export", details: { rows: 1200 } });
  assert.equal(debit.fromAllowance, 30);
  const entry = (await service.ledger(user.id)).entries.at(-1);
  assert.deepEqual([entry.kind, entry.credits, entry.source, entry.details.rows], ["usage", -30, "api", 1200]);
  const before = (await store.list("SUB_LEDGER#alice")).items.length;
  for (const bad of [
    { credits: 0 },
    { credits: 1.5 },
    { reason: "" },
    { kind: "refund" },
    { source: "robot" },
    { productId: "missing" },
    { amountMinor: 10, currency: "zzz" },
    { amountMinor: -1, currency: "usd" },
  ])
    await assert.rejects(service.recordCredits(user.id, { requestId: "bad", productId: "api", credits: 5, reason: "x", ...bad }));
  assert.equal((await store.list("SUB_LEDGER#alice")).items.length, before);
});

test("concurrent debits on the statement never overdraw and never duplicate", async () => {
  const { service, store } = await fixture();
  await service.change(user, "starter", "plan");
  await service.recordCredits(user.id, { requestId: "gift", productId: "api", credits: 50, reason: "Gift" });
  const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => service.consume(user.id, "api", 30, "c" + i)));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 5, "100 daily allowance + 50 top-up = 150");
  const ledger = await service.ledger(user.id);
  assert.equal(ledger.entries.filter(e => e.kind === "usage").length, 5);
  assert.equal(ledger.balances[0].available, 0);
  assert.equal((await store.list("SUB_USAGE#alice")).items.length, 5);
});

test("admin grants and courtesy resets appear on the statement with value and actor", async () => {
  const { service } = await fixture();
  await service.grant(user.id, { kind: "plan", planId: "pro", valueMinor: 2000, currency: "usd", reason: "Manual payment", requestId: "g1" }, "root");
  await service.grant(user.id, { kind: "credits", productId: "api", credits: 250, valueMinor: 0, currency: "usd", reason: "Courtesy", requestId: "g2" }, "root");
  await service.consume(user.id, "api", 1000, "big");
  await service.reset(user.id, { scope: "day", reason: "Incident", requestId: "reset" }, "root");
  const ledger = await service.ledger(user.id);
  const kinds = ledger.entries.map(e => [e.kind, e.source, e.credits]);
  assert.deepEqual(kinds, [["allowance", "system", 5000], ["plan", "admin", 0], ["grant", "admin", 250], ["usage", "api", -1000], ["reset", "admin", 1000]]);
  assert.equal(ledger.entries[1].actorId, "root");
  assert.match(ledger.entries[1].reason, /Plan assigned by administrator: Pro · Manual payment/);
  assert.deepEqual(ledger.totals.grantedValueMinor, { usd: 2000 });
  assert.deepEqual(ledger.totals.paidMinor, {});
});

test("changing plan closes the previous allowance and opens the new one", async () => {
  const { service, advance } = await fixture();
  await service.change(user, "starter", "a");
  await service.consume(user.id, "api", 50, "u");
  advance(1000);
  await service.change(user, "pro", "b");
  const entries = (await service.ledger(user.id)).entries.map(e => [e.kind, e.credits]);
  assert.deepEqual(entries, [["allowance", 500], ["plan", 0], ["usage", -50], ["expiry", -450], ["allowance", 5000], ["plan", 0]]);
});

test("credit sandbox prices requests by model and previews the charge for a user", async () => {
  const { service } = await fixture();
  let estimate = await service.estimate({ rateId: "standard", inputTokens: 1000, outputTokens: 500 });
  assert.deepEqual([estimate.exactCredits, estimate.credits, estimate.valueMinor, estimate.currency], [2.5, 3, 3, "usd"]);
  estimate = await service.estimate({ rateId: "advanced", inputTokens: 1, outputTokens: 0 });
  assert.equal(estimate.credits, 1, "minimum per request");
  assert.equal((await service.estimate({ rateId: "standard", inputTokens: 0 })).credits, 1);
  await assert.rejects(service.estimate({ rateId: "nope", inputTokens: 1 }), /rate not found/);
  await assert.rejects(service.estimate({ rateId: "standard", inputTokens: -1 }), /Invalid/);
  estimate = await service.estimate({ rateId: "advanced", inputTokens: 10000, outputTokens: 5000, userId: user.id });
  assert.deepEqual(estimate.account, { userId: user.id, productId: "api", allowanceLeft: 0, additionalCredits: 0, available: 0, fromAllowance: 0, fromBalance: 125, allowed: false, availableAfter: 0 });
  await service.change(user, "starter", "p");
  estimate = await service.estimate({ rateId: "advanced", inputTokens: 10000, outputTokens: 5000, userId: user.id });
  assert.deepEqual([estimate.account.fromAllowance, estimate.account.fromBalance, estimate.account.allowed], [100, 25, false]);
  const charged = await service.consumeUsage(user.id, "api", { rateId: "standard", inputTokens: 2000, outputTokens: 1000 }, "llm-1");
  assert.deepEqual([charged.credits, charged.valueMinor], [5, 5]);
  const entry = (await service.ledger(user.id)).entries.at(-1);
  assert.deepEqual(entry.details, { rateId: "standard", inputTokens: 2000, outputTokens: 1000 });
  assert.equal(entry.reason, "Standard model request");
});

test("credit settings are validated and older settings get defaults", () => {
  const legacy = structuredClone(defaults);
  delete legacy.credits;
  assert.deepEqual(validateSettings(legacy).credits, defaults.credits);
  const ok = validateCredits({ pack: { credits: 100, amountMinor: 250, currency: "USD" }, rates: [{ id: "mini", name: "Mini", inputPer1k: 0.0125, outputPer1k: 0.05 }] });
  assert.deepEqual(ok, { pack: { credits: 100, amountMinor: 250, currency: "usd" }, rates: [{ id: "mini", name: "Mini", inputPer1k: 0.0125, outputPer1k: 0.05, minimum: 0 }] });
  for (const bad of [
    { pack: { credits: 0, amountMinor: 1, currency: "usd" }, rates: [] },
    { pack: { credits: 1, amountMinor: 1, currency: "zzz" }, rates: [] },
    { pack: { credits: 1, amountMinor: 1.5, currency: "usd" }, rates: [] },
    { pack: { credits: 1, amountMinor: 1, currency: "usd" }, rates: "x" },
    { pack: { credits: 1, amountMinor: 1, currency: "usd" }, rates: [{ id: "a", name: "A", inputPer1k: 0.00001, outputPer1k: 0 }] },
    { pack: { credits: 1, amountMinor: 1, currency: "usd" }, rates: [{ id: "a", name: "A", inputPer1k: -1, outputPer1k: 0 }] },
    { pack: { credits: 1, amountMinor: 1, currency: "usd" }, rates: [{ id: "a", name: "", inputPer1k: 1, outputPer1k: 0 }] },
    { pack: { credits: 1, amountMinor: 1, currency: "usd" }, rates: [{ id: "a", name: "A", inputPer1k: 1, outputPer1k: 0 }, { id: "a", name: "B", inputPer1k: 1, outputPer1k: 0 }] },
  ])
    assert.throws(() => validateCredits(bad), undefined, JSON.stringify(bad));
});

test("overview counts customers, paying customers, projected revenue, new and canceled subscriptions", async () => {
  const { service, store, advance } = await fixture({ paid: true });
  const settings = await service.settings();
  await service.saveSettings({ version: settings.version, values: { ...settings.values, paymentRequired: true } }, "root");
  const bob = { ...user, id: "bob", email: "bob@example.test" }, eve = { ...user, id: "eve", email: "eve@example.test" };
  for (const u of [bob, eve])
    await store.transact([{ row: { pk: "USERS", sk: u.id, version: 1, data: { ...u, name: u.id } }, expected: null }]);
  await service.change(user, "pro", "a");
  await service.change(bob, "max", "b");
  await service.grant(eve.id, { kind: "plan", planId: "pro", valueMinor: 0, currency: "usd", reason: "Partner", requestId: "e" }, "root");
  await service.cancel(bob, "cancel-b");
  const overview = await service.overview(3);
  assert.equal(overview.customers, 3);
  assert.equal(overview.paying, 2);
  assert.equal(overview.canceling, 1);
  assert.deepEqual(overview.mrrMinor, { usd: 2000 }, "canceled Max is not projected; admin assignments are not revenue");
  assert.deepEqual(overview.today, { date: overview.today.date, new: 3, canceled: 1 });
  assert.deepEqual([overview.month.new, overview.month.canceled], [3, 1]);
  assert.equal(overview.series.length, 3);
  assert.deepEqual(overview.series.at(-1), { month: overview.month.month, customers: 3, paying: 2, new: 3, canceled: 1 });
  assert.equal(overview.series[0].customers, null, "no snapshot before the first overview");
  assert.deepEqual(overview.plans.find(p => p.planId === "pro"), { planId: "pro", name: "Pro", customers: 2, paying: 1 });
  advance(40 * 86400000);
  const later = await service.overview(1);
  assert.deepEqual([later.today.new, later.today.canceled], [0, 0]);
  await assert.rejects(service.overview(0), /Invalid/);
});

test("rollover, totals and keys are pure and ordered", () => {
  assert.deepEqual(rollover(undefined, undefined, () => 0, 0), { entries: [], state: undefined });
  const previous = { key: "own:starter", products: { api: { start: 0, allowance: 500, name: "API", weekSeconds: 604800 } } };
  const ended = rollover(previous, undefined, () => 100, 1000);
  assert.deepEqual(ended.entries.map(e => [e.kind, e.credits, e.at, e.reason]), [["expiry", -400, 1000, "API: allowance ended with the plan"]]);
  assert.deepEqual(rollover(previous, undefined, () => 500, 1000).entries, []);
  assert.ok(ledgerKey(5, "a") < ledgerKey(10, "a"));
  assert.ok(ledgerKey(10, "a") !== ledgerKey(10, "b"));
  const totals = [
    { kind: "allowance", credits: 500, source: "system" },
    { kind: "usage", credits: -20, source: "api" },
    { kind: "expiry", credits: -480, source: "system" },
    { kind: "purchase", credits: 100, source: "billing", amountMinor: 999, currency: "usd" },
    { kind: "grant", credits: 50, source: "admin", amountMinor: 5000, currency: "cop" },
  ].reduce((t, e) => applyTotals(t, e), undefined);
  assert.deepEqual(totals, { creditsIn: 650, creditsOut: 20, expired: 480, paidMinor: { usd: 999 }, grantedValueMinor: { cop: 5000 } });
});

test("admin routes expose overview, statement, record and sandbox to owners only", async () => {
  const { service } = await fixture();
  await service.change(user, "starter", "p");
  const routes = service.feature().endpoints;
  const route = (method, path) => routes.find(r => r.method === method && r.path === path);
  for (const [method, path] of [["GET", "/subscriptions/admin/overview"], ["GET", "/subscriptions/admin/accounts/:id/ledger"], ["POST", "/subscriptions/admin/accounts/:id/ledger"], ["POST", "/subscriptions/admin/credits/estimate"]]) {
    assert.equal(route(method, path).access, "owner", path);
    assert.ok(route(method, path).tool.name.startsWith("subscriptions_"));
  }
  const context = (body = {}, query = {}) => ({ actor: { id: "root" }, params: { id: user.id }, request: { body, query, headers: {} } });
  const recorded = await route("POST", "/subscriptions/admin/accounts/:id/ledger").handle(context({ requestId: "adm", productId: "api", credits: 40, kind: "grant", reason: "Support", details: { ticket: "T-1", nested: { x: 1 } } }));
  assert.equal(recorded.credits, 40);
  const ledger = await route("GET", "/subscriptions/admin/accounts/:id/ledger").handle(context());
  const entry = ledger.entries.at(-1);
  assert.deepEqual([entry.source, entry.actorId, entry.details.ticket, entry.details.nested], ["admin", "root", "T-1", "[object Object]"]);
  assert.equal((await route("POST", "/subscriptions/admin/credits/estimate").handle(context({ rateId: "standard", inputTokens: 1000 }))).credits, 1);
  assert.equal((await route("GET", "/subscriptions/admin/overview").handle(context({}, { months: "2" }))).series.length, 2);
  assert.equal((await route("GET", "/subscriptions/admin/overview").handle(context())).series.length, 12);
  const accounts = await service.listUsers({});
  assert.equal(accounts.items[0].creditsAvailable, 140);
});

test("maintenance records weekly expiry for idle accounts and keeps usage across unpaid renewals", async () => {
  const { service, advance } = await fixture();
  await service.change(user, "starter", "plan");
  await service.consume(user.id, "api", 60, "u1");
  advance(WEEK + 1000);
  await service.maintenance();
  let ledger = await service.ledger(user.id);
  assert.deepEqual(ledger.pending, []);
  assert.deepEqual(ledger.entries.map(e => [e.kind, e.credits]).slice(3), [["expiry", -440], ["allowance", 500]]);
  await service.maintenance();
  assert.equal((await service.ledger(user.id)).entries.length, 5, "maintenance is idempotent");
  // Unpaid 30-day renewal resets counters; the closing window keeps its real usage.
  advance(22 * 86400000);
  await service.consume(user.id, "api", 30, "u2");
  advance(3 * WEEK);
  await service.maintenance();
  ledger = await service.ledger(user.id);
  // Week of 09-29 (30 used) ends at the 10-01 renewal; windows 10-01 and 10-08 passed unused.
  const last = ledger.entries.filter(e => e.kind === "expiry").at(-1);
  assert.deepEqual([last.credits, new Date(last.at).toISOString(), last.details], [-1470, "2026-10-01T00:00:00.000Z", { unused: 470, skippedWeeks: 2 }]);
  assert.equal(ledger.entries.at(-1).at, Date.UTC(2026, 9, 15), "new allowance on the counters' window start");
});
