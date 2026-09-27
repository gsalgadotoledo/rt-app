// Subject: subscriptions (the Subscriptions service of @gsalgadotoledo/rt-app-subscriptions).
// A facade over a MemoryStore, an optional LocalBilling, a fake CatalogPublisher and a settable
// clock, so every language exposes the same surface (see docs/polyglot/subscriptions.md).
//
// init: {now?, rows?, billing?: "local", catalog?: true}
//   now      ISO 8601 instant of the shared clock (default 2026-01-01T00:00:00.000Z)
//   rows     rows seeding the store (e.g. USERS rows for grants and the account list)
//   billing  "local" wires LocalBilling(store, clock); anything else: no payment provider
//   catalog  true wires a fake CatalogPublisher (see `catalog` below); otherwise none
import { LocalBilling, Subscriptions } from "@gsalgadotoledo/rt-app-subscriptions";
import { HttpError } from "@gsalgadotoledo/rt-app-contracts";
import { memoryStore } from "./storage.mjs";

const given = (value) => (value === null ? undefined : value);

/** Canonical JSON (object keys sorted by UTF-16 code units), used to order audit rows. */
const canonical = (value) =>
  Array.isArray(value)
    ? "[" + value.map(canonical).join(",") + "]"
    : value && typeof value === "object"
      ? "{" + Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}"
      : JSON.stringify(value ?? null);

/** Endpoint routing like the framework: literal routes first, then `:param` routes. */
function route(endpoints, method, path) {
  const sorted = [...endpoints].sort((a, b) => Number(a.path.includes(":")) - Number(b.path.includes(":")));
  for (const endpoint of sorted) {
    if (endpoint.method !== method) continue;
    const names = [];
    const pattern = endpoint.path.split("/").map((part) => (part.startsWith(":") ? (names.push(part.slice(1)), "([^/]+)") : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("/");
    const match = new RegExp("^" + pattern + "/?$").exec(path);
    if (match) return { endpoint, params: Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(match[i + 1])])) };
  }
  throw new HttpError(404, "Endpoint not found");
}

async function subscriptions(init) {
  let now = Date.parse(init.now ?? "2026-01-01T00:00:00.000Z");
  if (Number.isNaN(now)) throw new Error("init.now must be an ISO 8601 date");
  const clock = () => now;
  const store = await memoryStore(init.rows ?? []);
  // Failure injection (`failWrites`): the next transactions fail with 503 "Injected store
  // failure", "before" committing (nothing written) or "after" (written, the reply is lost).
  const injected = [];
  const transact = store.transact.bind(store);
  store.transact = async (writes) => {
    const mode = injected.shift();
    if (mode === "before") throw new HttpError(503, "Injected store failure");
    await transact(writes);
    if (mode === "after") throw new HttpError(503, "Injected store failure");
  };
  const sent = [];
  // Fake catalog: deterministic ids; `setCatalog("fail")` makes publish fail with 502.
  let catalogMode = "ok";
  const published = [];
  const catalog = {
    async publish(plan, namespace, previous) {
      if (catalogMode === "fail") throw new HttpError(502, "Catalog unavailable");
      published.push({ planId: plan.id, version: plan.version, previousVersion: previous?.version ?? null, namespace: typeof namespace });
      const suffix = plan.id.replace(/-/g, "_") + "_" + String(plan.version ?? "0.0.1").replace(/\./g, "_");
      return { stripePriceId: "price_" + suffix, stripeProductId: "prod_" + suffix };
    },
  };
  const service = new Subscriptions(
    store,
    init.billing === "local" ? new LocalBilling(store, clock) : undefined,
    async (message) => {
      sent.push(message);
    },
    clock,
    init.catalog === true ? () => catalog : undefined,
  );
  const feature = service.feature();
  const facade = {
    // Settings and catalog
    settings: () => service.settings(),
    saveSettings: (input, actorId) => service.saveSettings(input, actorId),
    editPlan: (action, input, actorId) => service.editPlan(action, input, actorId),
    restorePlan: (planId, input, actorId) => service.restorePlan(planId, input, actorId),
    publishPlan: (planId, input, actorId) => service.publishPlan(planId, input ?? {}, actorId),
    linkStripePrices: (links, actorId) => service.linkStripePrices(links, actorId),
    // Accounts
    me: (userId) => service.me(userId),
    preferences: (userId, enabled) => service.preferences(userId, enabled),
    change: (user, planId, key) => service.change(user, planId, key),
    setupPayment: (user, key) => service.setupPayment(user, key),
    setPayment: (user, setupId) => service.setPayment(user, setupId),
    cancel: (user, key) => service.cancel(user, key),
    sync: async (userId) => {
      await service.sync(userId);
      return null;
    },
    billing: (userId) => service.billing(userId),
    grant: (userId, input, actorId) => service.grant(userId, input, actorId),
    reset: (userId, input, actorId) => service.reset(userId, input, actorId),
    listUsers: (query) => service.listUsers(query ?? {}),
    webhook: (raw, signature) => service.webhook(raw, signature),
    // Credits
    consume: (userId, productId, credits, requestId, meta) => service.consume(userId, productId, credits, requestId, given(meta)),
    recordCredits: (userId, input) => service.recordCredits(userId, input),
    estimate: (input) => service.estimate(input),
    consumeUsage: (userId, productId, usage, requestId) => service.consumeUsage(userId, productId, usage, requestId),
    ledger: (userId, cursor) => service.ledger(userId, given(cursor)),
    // Reservations
    reserve: (userId, productId, input, meta) => service.reserve(userId, productId, input, given(meta)),
    settle: (userId, key, usage, meta) => service.settle(userId, key, usage, given(meta)),
    release: (userId, key, meta) => service.release(userId, key, given(meta)),
    preflight: (userId, productId, input) => service.preflight(userId, productId, input),
    usageSummary: (userId) => service.usageSummary(userId),
    // Overview and maintenance
    overview: (months) => service.overview(given(months)),
    maintenance: () => service.maintenance(),
    // Module surface: endpoint list, one endpoint call (handler included), admin entry, migrations
    endpoints: () => feature.endpoints.map((e) => ({ method: e.method, path: e.path, access: e.access, resource: e.resource, tool: e.tool?.name, maxBodyBytes: e.maxBodyBytes })),
    call: (method, path, request, actor) => {
      const { endpoint, params } = route(feature.endpoints, method, path);
      const r = request ?? {};
      return endpoint.handle({ request: { body: r.body ?? {}, query: r.query ?? {}, headers: r.headers ?? {}, rawBody: r.raw ?? "" }, params, actor: given(actor) });
    },
    admin: () => feature.admin,
    migrations: () => feature.migrations.map(({ id, checksum, description }) => ({ id, checksum, description })),
    // Helpers
    setNow: (iso) => {
      const value = Date.parse(iso);
      if (typeof iso !== "string" || Number.isNaN(value)) throw new Error("setNow needs an ISO 8601 date");
      now = value;
      return null;
    },
    setCatalog: (mode) => {
      catalogMode = mode;
      return null;
    },
    // failWrites(count, mode): the next `count` transactions fail ("before" or "after" commit).
    failWrites: (count, mode) => {
      if (!["before", "after"].includes(mode)) throw new Error('failWrites mode is "before" or "after"');
      for (let i = 0; i < count; i++) injected.push(mode);
      return null;
    },
    // race(calls): runs [{call, args}] at once; {fulfilled, rejected: [{status, message}]} (sorted).
    race: async (calls) => {
      const results = await Promise.allSettled(calls.map(({ call, args }) => facade[call](...(args ?? []))));
      const rejected = results
        .filter((r) => r.status === "rejected")
        .map((r) => ({ status: r.reason?.status ?? null, message: String(r.reason?.message ?? r.reason) }))
        .sort((a, b) => (a.message < b.message ? -1 : a.message > b.message ? 1 : 0));
      return { fulfilled: results.length - rejected.length, rejected };
    },
    // batch(calls): the same, one call after the other.
    batch: async (calls) => {
      const rejected = [];
      for (const { call, args } of calls) {
        try {
          await facade[call](...(args ?? []));
        } catch (error) {
          rejected.push({ status: error?.status ?? null, message: String(error?.message ?? error) });
        }
      }
      rejected.sort((a, b) => (a.message < b.message ? -1 : a.message > b.message ? 1 : 0));
      return { fulfilled: calls.length - rejected.length, rejected };
    },
    // ledgerCheck(userId): statement invariants (see docs/polyglot/subscriptions-reservations.md).
    ledgerCheck: async (userId) => {
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
      const credits = sum(entries.map((e) => e.credits));
      const held = sum(entries.map((e) => e.held ?? 0));
      const reserved = sum((account.reservations ?? []).map((h) => h.credits));
      const allowance = sum(
        Object.entries(windows?.products ?? {}).map(([productId, w]) =>
          w.allowance - (counters?.[productId]?.weekStart === w.start ? counters[productId].week : 0),
        ),
      );
      const additional = sum(Object.values(account.creditBalance ?? {}));
      const minAvailable = Math.min(0, ...entries.filter((e) => e.available !== undefined).map((e) => e.available));
      return {
        entries: entries.length,
        credits,
        held,
        reserved,
        allowance,
        additional,
        balanced: credits === allowance + additional && held === reserved,
        negative: minAvailable < 0 || Object.values(account.creditBalance ?? {}).some((v) => v < 0),
      };
    },
    published: () => published,
    sent: () => sent,
    row: (pk, sk) => store.get(pk, sk),
    list: (pk, cursor) => store.list(pk, given(cursor)),
    audit: async () => {
      const rows = [];
      let cursor;
      do {
        const page = await store.list("SUB_AUDIT", cursor);
        rows.push(...page.items.map((r) => r.data));
        cursor = page.cursor;
      } while (cursor);
      return rows.sort((a, b) => (canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0));
    },
  };
  return facade;
}

export const subjects = { subscriptions };
