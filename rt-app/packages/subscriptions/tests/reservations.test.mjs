import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "@gsalgadotoledo/rt-app-dynamodb";
import { HttpError } from "@gsalgadotoledo/rt-app-contracts";
import {
  Subscriptions,
  RESERVATION_TTL_MS,
  reservationKey,
  reservationReason,
  reservationTtl,
  sameUsage,
  settleUsage,
  thresholdOf,
  windowUsage,
} from "../dist/index.js";

const alice = { id: "alice", email: "alice@example.test", role: "user" };
const START = Date.parse("2026-01-01T00:00:00.000Z");

/** A service over a memory store whose transactions can fail before or after committing. */
function fixture() {
  const store = new MemoryStore();
  const failures = [];
  let writes = 0;
  const transact = store.transact.bind(store);
  store.transact = async (items) => {
    writes++;
    const mode = failures.shift();
    if (mode === "before") throw new HttpError(503, "Injected store failure");
    await transact(items);
    if (mode === "after") throw new HttpError(503, "Injected store failure");
  };
  let now = START;
  const service = new Subscriptions(store, undefined, undefined, () => now);
  return {
    store,
    service,
    fail: (...modes) => failures.push(...modes),
    writes: () => writes,
    at: (iso) => (now = Date.parse(iso)),
    advance: (ms) => (now += ms),
  };
}

/** Statement invariants: the ledger sum is the balance, holds match, nothing is negative. */
async function check(store, userId = "alice") {
  const entries = [];
  let cursor;
  do {
    const page = await store.list("SUB_LEDGER#" + userId, cursor);
    entries.push(...page.items.map((r) => r.data));
    cursor = page.cursor;
  } while (cursor);
  const account = (await store.get("SUB_ACCOUNTS", userId))?.data ?? {};
  const windows = account.ledgerWindows;
  const counters = windows?.key.startsWith("admin:") ? account.adminGrant?.counters : account.counters;
  const sum = (values) => values.reduce((n, v) => n + v, 0);
  const allowance = sum(
    Object.entries(windows?.products ?? {}).map(
      ([id, w]) => w.allowance - (counters?.[id]?.weekStart === w.start ? counters[id].week : 0),
    ),
  );
  const additional = sum(Object.values(account.creditBalance ?? {}));
  assert.equal(sum(entries.map((e) => e.credits)), allowance + additional, "ledger sum == balance");
  assert.equal(
    sum(entries.map((e) => e.held ?? 0)),
    sum((account.reservations ?? []).map((h) => h.credits)),
    "held entries == holds on the account",
  );
  for (const e of entries) if (e.available !== undefined) assert.ok(e.available >= 0, "available never negative");
  for (const v of Object.values(account.creditBalance ?? {})) assert.ok(v >= 0, "balance never negative");
  return { entries, account };
}

test("helpers validate keys, TTLs, reasons and usage and compute thresholds", () => {
  assert.equal(reservationKey("turn-1:0.a_b"), "turn-1:0.a_b");
  for (const bad of ["", "bad key", "x".repeat(129), 5, undefined])
    assert.throws(() => reservationKey(bad), /Invalid reservation key/);
  assert.equal(reservationTtl(undefined), RESERVATION_TTL_MS);
  assert.equal(reservationTtl(null), RESERVATION_TTL_MS);
  assert.equal(reservationTtl(1000), 1000);
  for (const bad of [999, 86400001, 1000.5, "1000"]) assert.throws(() => reservationTtl(bad), /Invalid reservation TTL/);
  assert.equal(reservationReason(undefined), undefined);
  assert.equal(reservationReason(" Chat "), "Chat");
  assert.throws(() => reservationReason("  "), /short reason/);
  assert.throws(() => reservationReason("r".repeat(301)), /short reason/);
  assert.deepEqual([0, 79, 80, 94, 95, 99, 100, 250].map(thresholdOf), [0, 0, 80, 80, 95, 95, 100, 100]);
  assert.deepEqual(windowUsage("day", 60, 25, 100, 9), { kind: "day", used: 60, reserved: 25, limit: 100, remaining: 15, percent: 85, threshold: 80, resetAt: 9 });
  assert.deepEqual(windowUsage("week", 0, 0, 0, 1), { kind: "week", used: 0, reserved: 0, limit: 0, remaining: 0, percent: 100, threshold: 100, resetAt: 1 });
  assert.deepEqual(settleUsage({ credits: 0 }), { credits: 0 });
  assert.deepEqual(settleUsage({ inputTokens: 5 }), { inputTokens: 5, outputTokens: 0 });
  for (const bad of [undefined, {}, { outputTokens: 1 }, "x"]) assert.throws(() => settleUsage(bad), /Give credits or token usage/);
  for (const bad of [{ credits: -1 }, { credits: 1.5 }, { inputTokens: 1, outputTokens: -1 }, { inputTokens: 1e11 }])
    assert.throws(() => settleUsage(bad), /Invalid numeric setting/);
  assert.equal(sameUsage({ credits: 1 }, { credits: 1 }), true);
  assert.equal(sameUsage({ inputTokens: 1, outputTokens: 2 }, { inputTokens: 1, outputTokens: 3 }), false);
  assert.equal(sameUsage({ credits: 1 }, { inputTokens: 1, outputTokens: 0 }), false);
});

test("reserve holds the maximum; settle charges the real usage and releases the rest", async () => {
  const { service, store } = fixture();
  await service.change(alice, "starter", "plan");
  const reserved = await service.reserve("alice", "api", {
    key: "turn-1:0",
    estimate: { rateId: "standard", inputTokens: 12000, maxOutputTokens: 8000 },
  });
  assert.deepEqual(reserved, { key: "turn-1:0", productId: "api", credits: 36, status: "active", at: START, expiresAt: START + RESERVATION_TTL_MS, available: 64, replayed: false });
  await assert.rejects(service.consume("alice", "api", 65, "u1"), /limit reached/);
  await service.consume("alice", "api", 64, "u1");
  const settled = await service.settle("alice", "turn-1:0", { inputTokens: 12000, outputTokens: 2000 });
  assert.equal(settled.used, 18);
  assert.equal(settled.credits, 18);
  assert.equal(settled.available, 18);
  assert.equal(settled.valueMinor, 18);
  assert.deepEqual(await service.settle("alice", "turn-1:0", { inputTokens: 12000, outputTokens: 2000 }), { ...settled, replayed: true });
  await assert.rejects(service.settle("alice", "turn-1:0", { credits: 18 }), /already settled with different usage/);
  await assert.rejects(service.release("alice", "turn-1:0"), /Reservation already settled/);
  assert.equal((await service.reserve("alice", "api", { key: "turn-1:0", credits: 36 })).status, "settled");
  await assert.rejects(service.reserve("alice", "api", { key: "turn-1:0", credits: 35 }), (e) => e.status === 409);
  const { entries } = await check(store);
  assert.deepEqual(entries.map((e) => e.kind), ["allowance", "plan", "reservation", "usage", "settlement"]);
  assert.deepEqual(entries.at(-1).details, { rateId: "standard", inputTokens: 12000, outputTokens: 2000, reserved: 36, used: 18, uncovered: 0 });
});

test("validation runs in order and failures write nothing", async () => {
  const { service, store } = fixture();
  const cases = [
    [{ key: "bad key", credits: 1 }, "api", 400, "Invalid reservation key"],
    [{ key: "k", credits: 1 }, "bad id", 400, "Invalid identifier"],
    [{ key: "k" }, "api", 400, "Give credits or an estimate"],
    [{ key: "k", credits: 1, estimate: {} }, "api", 400, "Give credits or an estimate"],
    [{ key: "k", estimate: [] }, "api", 400, "Give credits or an estimate"],
    [{ key: "k", credits: 0 }, "api", 400, "Invalid numeric setting"],
    [{ key: "k", estimate: { rateId: "nope", inputTokens: 1 } }, "api", 404, "Credit rate not found"],
    [{ key: "k", credits: 1, ttlMs: 5 }, "api", 400, "Invalid reservation TTL"],
    [{ key: "k", credits: 1, reason: " " }, "api", 400, "A short reason is required"],
    [{ key: "k", credits: 1 }, "api", 402, "Subscription is inactive or expired"],
  ];
  for (const [input, product, status, message] of cases)
    await assert.rejects(service.reserve("alice", product, input), (e) => e.status === status && e.message === message);
  await service.change(alice, "starter", "plan");
  await assert.rejects(service.reserve("alice", "gpu", { key: "k", credits: 1 }), (e) => e.status === 403);
  await assert.rejects(service.reserve("alice", "api", { key: "k", credits: 101 }), (e) => e.status === 429 && e.message === "Not enough credits: 1 missing. Add credits or wait for the reset.");
  await assert.rejects(service.settle("alice", "k", { credits: 1 }), (e) => e.status === 404);
  await assert.rejects(service.release("alice", "k"), (e) => e.status === 404);
  await assert.rejects(service.preflight("alice", "api", {}), /Give credits or an estimate/);
  assert.equal((await store.list("SUB_RESERVATION#alice")).items.length, 0);
});

test("release is idempotent and blocks a later settlement", async () => {
  const { service, store } = fixture();
  await service.change(alice, "starter", "plan");
  await service.reserve("alice", "api", { key: "r1", credits: 30, reason: "Batch" });
  const released = await service.release("alice", "r1");
  assert.deepEqual(released, { key: "r1", productId: "api", credits: 30, status: "released", releasedAt: START, replayed: false });
  assert.deepEqual(await service.release("alice", "r1"), { ...released, replayed: true });
  await assert.rejects(service.settle("alice", "r1", { credits: 1 }), /Reservation was released/);
  await service.reserve("alice", "api", { key: "r2", credits: 5 });
  await assert.rejects(service.settle("alice", "r2", { inputTokens: 5 }), /Settle this reservation with credits/);
  const zero = await service.settle("alice", "r2", { credits: 0 });
  assert.equal(zero.credits, 0);
  const { entries } = await check(store);
  assert.equal(Object.is(entries.at(-1).credits, -0), false, "no negative zero");
  assert.equal(entries.find((e) => e.kind === "release").reason, "Released · Batch");
});

test("holds take the allowance first but never push a charge onto additional credits", async () => {
  const { service, store } = fixture();
  await service.change(alice, "starter", "plan");
  await service.reserve("alice", "api", { key: "k1", credits: 60 });
  await service.recordCredits("alice", { requestId: "pi", productId: "api", credits: 20, reason: "Top-up" });
  await service.reserve("alice", "api", { key: "k2", credits: 50 });
  const preview = await service.estimate({ rateId: "standard", inputTokens: 5000, userId: "alice" });
  assert.deepEqual(preview.account, { userId: "alice", productId: "api", allowanceLeft: 100, additionalCredits: 20, available: 10, fromAllowance: 5, fromBalance: 0, allowed: true, availableAfter: 5 });
  assert.equal((await service.consume("alice", "api", 10, "u1")).fromAllowance, 10);
  assert.equal((await service.settle("alice", "k1", { credits: 60 })).fromAllowance, 60);
  const k2 = await service.settle("alice", "k2", { credits: 45 });
  assert.deepEqual([k2.fromAllowance, k2.fromBalance], [30, 15]);
  const me = await service.me("alice");
  assert.equal(me.usage[0].used, 100);
  assert.equal(me.creditBalance.api, 5);
  await check(store);
});

test("usage beyond the reservation is charged; what cannot be covered is reported, never negative", async () => {
  const { service, store } = fixture();
  await service.change(alice, "starter", "plan");
  await service.recordCredits("alice", { requestId: "pi", productId: "api", credits: 10, reason: "Top-up" });
  await service.reserve("alice", "api", { key: "o1", credits: 20 });
  await service.consume("alice", "api", 80, "u1");
  const settled = await service.settle("alice", "o1", { credits: 40 });
  assert.deepEqual([settled.fromAllowance, settled.fromBalance, settled.uncovered, settled.available], [20, 10, 10, 0]);
  await check(store);
});

test("expired holds stop counting at once; maintenance and the next reservation release them", async () => {
  const { service, store, advance } = fixture();
  await service.change(alice, "starter", "plan");
  await service.reserve("alice", "api", { key: "e1", credits: 80, ttlMs: 60_000 });
  await service.reserve("alice", "api", { key: "e2", credits: 10, ttlMs: 60_000 });
  advance(60_000);
  assert.equal((await service.usageSummary("alice")).products[0].reserved, 0);
  assert.equal((await service.reserve("alice", "api", { key: "e1", credits: 80 })).status, "expired");
  await service.consume("alice", "api", 95, "u1");
  assert.equal((await store.get("SUB_ACCOUNTS", "alice")).data.reservations.length, 2);
  assert.deepEqual(await service.maintenance(), { processed: 1, partial: false });
  assert.equal((await store.get("SUB_ACCOUNTS", "alice")).data.reservations.length, 0);
  assert.equal((await store.get("SUB_RESERVATION#alice", "e1")).data.status, "expired");
  assert.deepEqual(await service.release("alice", "e2"), { key: "e2", productId: "api", credits: 10, status: "expired", releasedAt: START + 60_000, replayed: true });
  // A hold that expires before its own release is recorded as expired by that release.
  await service.reserve("alice", "api", { key: "e3", credits: 5, ttlMs: 1000 });
  advance(1000);
  assert.equal((await service.release("alice", "e3")).status, "expired");
  const { entries } = await check(store);
  assert.deepEqual(entries.filter((e) => e.kind === "release").map((e) => e.reason), [
    "Reservation expired · API credits usage",
    "Reservation expired · API credits usage",
    "Reservation expired · API credits usage",
  ]);
});

test("a crash mid-step is settled on resume with the real usage, even after the TTL", async () => {
  const { service, store, advance } = fixture();
  await service.change(alice, "starter", "plan");
  await service.reserve("alice", "api", { key: "turn-9:2", estimate: { rateId: "advanced", inputTokens: 2000, maxOutputTokens: 1000 } });
  advance(20 * 60_000);
  const settled = await service.settle("alice", "turn-9:2", { inputTokens: 2000, outputTokens: 400 });
  assert.deepEqual([settled.used, settled.credits, settled.expired], [16, 16, true]);
  const { entries } = await check(store);
  assert.deepEqual(entries.map((e) => e.kind), ["allowance", "plan", "reservation", "release", "settlement"]);
  assert.equal(entries.at(-1).held, 0);
});

test("two turns of the same user reserving at once: exactly one fits", async () => {
  const { service, store } = fixture();
  await service.change(alice, "starter", "plan");
  await service.consume("alice", "api", 40, "u0");
  const results = await Promise.allSettled([
    service.reserve("alice", "api", { key: "a", credits: 60 }),
    service.reserve("alice", "api", { key: "b", credits: 60 }),
    service.consume("alice", "api", 60, "u1"),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.ok(results.filter((r) => r.status === "rejected").every((r) => r.reason.status === 429));
  const settles = await Promise.all([1, 2, 3].map(() => service.settle("alice", "a", { credits: 10 }).catch((e) => e)));
  const settledOnce = settles.filter((r) => r.replayed === false).length;
  assert.ok(settledOnce <= 1);
  const { entries } = await check(store);
  assert.ok(entries.filter((e) => e.kind === "settlement").length <= 1);
});

test("at most 25 reservations are active", async () => {
  const { service } = fixture();
  await service.change(alice, "max", "plan");
  for (let i = 0; i < 25; i++) await service.reserve("alice", "api", { key: "s" + i, credits: 1 });
  await assert.rejects(service.reserve("alice", "api", { key: "s25", credits: 1 }), /Too many active reservations/);
  await service.release("alice", "s0");
  await service.reserve("alice", "api", { key: "s25", credits: 1 });
});

test("pre-flight reports fits, missing credits, blocked accounts and a top-up offer", async () => {
  const { service, at } = fixture();
  assert.deepEqual(await service.preflight("alice", "api", { credits: 10 }), {
    productId: "api", credits: 10, fits: false, reason: "inactive", available: 0, missing: 10,
    allowanceLeft: 0, additionalCredits: 0, reserved: 0, windows: [], topUp: null,
  });
  await service.change(alice, "starter", "plan");
  assert.equal((await service.preflight("alice", "gpu", { credits: 1 })).reason, "product");
  await service.consume("alice", "api", 70, "u1");
  await service.reserve("alice", "api", { key: "t", credits: 10 });
  let summary = await service.usageSummary("alice");
  assert.deepEqual(summary.alerts, [{ productId: "api", window: "day", percent: 80, threshold: 80 }]);
  await service.consume("alice", "api", 15, "u2");
  summary = await service.usageSummary("alice");
  assert.equal(summary.products[0].threshold, 95);
  const short = await service.preflight("alice", "api", { credits: 10 });
  assert.deepEqual([short.fits, short.reason, short.missing, short.topUp], [false, "credits", 5, { credits: 5, packs: 1, amountMinor: 1000, valueMinor: 5, currency: "usd" }]);
  const fits = await service.preflight("alice", "api", { estimate: { rateId: "standard", inputTokens: 1000, maxOutputTokens: 1000 } });
  assert.deepEqual([fits.credits, fits.fits, fits.reason, fits.topUp], [4, true, null, null]);
  await service.recordCredits("alice", { requestId: "pi", productId: "api", credits: 7, reason: "Top-up" });
  summary = await service.usageSummary("alice");
  assert.equal(summary.active, true);
  assert.deepEqual(summary.pack, { credits: 1000, amountMinor: 1000, currency: "usd" });
  at("2026-03-01T00:00:00.000Z");
  const other = await service.usageSummary("bob");
  assert.deepEqual([other.active, other.products], [false, []]);
});

test("payments required: pre-flight says so; reserved usage is still settled", async () => {
  const store = new MemoryStore();
  const { LocalBilling, defaults } = await import("../dist/index.js");
  const service = new Subscriptions(store, new LocalBilling(store, () => START), undefined, () => START);
  await service.change(alice, "starter", "plan");
  await service.reserve("alice", "api", { key: "p1", credits: 10 });
  await service.saveSettings({ version: 0, values: { ...defaults, paymentRequired: true } }, "root");
  assert.equal((await service.preflight("alice", "api", { credits: 1 })).reason, "payment");
  await assert.rejects(service.reserve("alice", "api", { key: "p2", credits: 1 }), /A paid subscription is required/);
  assert.equal((await service.settle("alice", "p1", { credits: 4 })).credits, 4);
  assert.equal((await service.usageSummary("alice")).active, false);
  await check(store);
});

test("maintenance releases holds of administrator-assigned plans", async () => {
  const { service, store, advance } = fixture();
  await store.transact([{ row: { pk: "USERS", sk: "bob", version: 1, data: { id: "bob", email: "bob@example.test" } }, expected: null }]);
  await service.grant("bob", { requestId: "g", kind: "plan", planId: "pro", reason: "Pilot", currency: "usd", valueMinor: 0 }, "root");
  await service.reserve("bob", "api", { key: "b", credits: 900, ttlMs: 1000 });
  advance(1000);
  await service.maintenance();
  const { account } = await check(store, "bob");
  assert.deepEqual(account.reservations, []);
});

test("injected failures at every write point never charge twice or lose a hold", async () => {
  // One scenario; each run fails one transaction before or after it commits, then retries
  // the failed operation with the same key. The final statement must equal the clean run.
  const scenario = [
    (s) => s.change(alice, "starter", "plan"),
    (s) => s.recordCredits("alice", { requestId: "pi", productId: "api", credits: 30, reason: "Top-up" }),
    (s) => s.reserve("alice", "api", { key: "a", credits: 50 }),
    (s) => s.reserve("alice", "api", { key: "b", estimate: { rateId: "standard", inputTokens: 10000, maxOutputTokens: 5000 } }),
    (s) => s.consume("alice", "api", 20, "u1"),
    (s) => s.settle("alice", "a", { credits: 45 }),
    (s) => s.release("alice", "b"),
    (s) => s.reserve("alice", "api", { key: "c", credits: 30, ttlMs: 1000 }),
  ];
  async function run(failAt, mode) {
    const f = fixture();
    for (const step of scenario) {
      if (failAt !== undefined && f.writes() === failAt) f.fail(mode);
      try {
        await step(f.service);
      } catch (error) {
        assert.equal(error.message, "Injected store failure");
        await step(f.service);
      }
    }
    f.advance(1000);
    await f.service.settle("alice", "c", { credits: 12 });
    const { entries, account } = await check(f.store);
    return { entries: entries.map(({ kind, credits, held, requestId }) => [kind, credits, held, requestId]), balance: account.creditBalance, counters: account.counters };
  }
  const clean = await run();
  for (let point = 0; point < 12; point++)
    for (const mode of ["before", "after"]) assert.deepEqual(await run(point, mode), clean, `failure ${mode} write ${point}`);
});

test("property: random sequences keep the ledger sum equal to the balance and never negative", async () => {
  let seed = 7;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = (n) => Math.floor(random() * n);
  for (let round = 0; round < 12; round++) {
    const { service, store, advance } = fixture();
    await service.change(alice, round % 2 ? "starter" : "pro", "plan");
    const keys = [];
    for (let step = 0; step < 40; step++) {
      const action = pick(8);
      const key = "k" + round + "-" + step;
      const quiet = (promise) => promise.catch((e) => assert.ok([402, 409, 429].includes(e.status), e.message));
      if (action === 0) await quiet(service.reserve("alice", "api", { key, credits: 1 + pick(120), ttlMs: 1000 + pick(4) * 3_600_000 }).then(() => keys.push(key)));
      else if (action === 1 && keys.length) await quiet(service.settle("alice", keys[pick(keys.length)], { credits: pick(150) }));
      else if (action === 2 && keys.length) await quiet(service.release("alice", keys[pick(keys.length)]));
      else if (action === 3) await quiet(service.consume("alice", "api", 1 + pick(60), key));
      else if (action === 4) await service.recordCredits("alice", { requestId: key, productId: "api", credits: 1 + pick(80), reason: "Top-up" });
      else if (action === 5) advance(pick(3) * 3_600_000 + pick(2) * 86_400_000);
      else if (action === 6) await service.maintenance();
      else await quiet(service.reserve("alice", "api", { key, estimate: { rateId: "advanced", inputTokens: pick(9000), maxOutputTokens: pick(4000) } }).then(() => keys.push(key)));
      await check(store);
    }
  }
});

test("personal endpoints reach only the user's own reservations; owner endpoints act for the backend", async () => {
  const { service } = fixture();
  await service.change(alice, "starter", "plan");
  const endpoints = service.feature().endpoints;
  const call = (method, path, body, actor, params = {}) =>
    endpoints.find((e) => e.method === method && e.path === path).handle({ request: { body: body ?? {}, query: {}, headers: {} }, params, actor });
  const root = { id: "rt-app-root", role: "owner" };
  const mine = await call("POST", "/subscriptions/credits/reservations", { key: "u:1", productId: "api", credits: 10, extra: 1 }, alice);
  assert.equal(mine.status, "active");
  await call("POST", "/subscriptions/admin/accounts/:id/reservations", { key: "s:1", productId: "api", credits: 5 }, root, { id: "alice" });
  await assert.rejects(call("POST", "/subscriptions/credits/reservations/:key/release", {}, alice, { key: "s:1" }), /Reservation not found/);
  await assert.rejects(call("POST", "/subscriptions/credits/reservations/:key/settle", { credits: 1 }, alice, { key: "s:1" }), /Reservation not found/);
  assert.equal((await call("POST", "/subscriptions/credits/reservations/:key/settle", { credits: 4 }, alice, { key: "u:1" })).credits, 4);
  assert.equal((await call("POST", "/subscriptions/admin/accounts/:id/reservations/:key/settle", { credits: 5 }, root, { id: "alice", key: "s:1" })).credits, 5);
  await call("POST", "/subscriptions/credits/reservations", { key: "u:2", productId: "api", credits: 1 }, alice);
  assert.equal((await call("POST", "/subscriptions/credits/reservations/:key/release", {}, alice, { key: "u:2" })).status, "released");
  await call("POST", "/subscriptions/admin/accounts/:id/reservations", { key: "s:2", productId: "api", credits: 1 }, root, { id: "alice" });
  assert.equal((await call("POST", "/subscriptions/admin/accounts/:id/reservations/:key/release", {}, root, { id: "alice", key: "s:2" })).status, "released");
  assert.equal((await call("POST", "/subscriptions/credits/preflight", { productId: "api", credits: 1 }, alice)).fits, true);
  assert.equal((await call("POST", "/subscriptions/admin/accounts/:id/preflight", { productId: "api", credits: 1 }, root, { id: "alice" })).fits, true);
  assert.equal((await call("GET", "/subscriptions/credits/usage", {}, alice)).userId, "alice");
  assert.equal((await call("GET", "/subscriptions/admin/accounts/:id/usage", {}, root, { id: "alice" })).userId, "alice");
  const tools = endpoints.filter((e) => e.tool?.name.startsWith("subscriptions_credits_")).map((e) => e.tool.name);
  assert.deepEqual(tools, ["subscriptions_credits_estimate", "subscriptions_credits_usage", "subscriptions_credits_preflight", "subscriptions_credits_reserve", "subscriptions_credits_settle", "subscriptions_credits_release"]);
});
