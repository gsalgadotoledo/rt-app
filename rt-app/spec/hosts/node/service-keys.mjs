// Subject: serviceKeys (ServiceKeys of @gsalgadotoledo/rt-app-auth): scoped credentials for
// backends. A facade over a MemoryStore, a settable clock and a deterministic random source, so
// every language exposes the same surface (see docs/polyglot/service-keys.md).
//
// init: {now?, secret, keys?, scopes, rows?}
//   now     ISO 8601 instant of the clock (default 2026-01-01T00:00:00.000Z)
//   secret  application secret (keys the RATE rows of the per-key limit)
//   keys    configured keys (the parsed RT_APP_SERVICE_KEYS value); validated when the instance is made
//   scopes  scopes a key may hold
//   rows    rows seeding the store
// Random bytes are deterministic: call n (1, 2, …) returns `bytes` bytes of value n % 256 as
// base64url, so generated ids and tokens are the same in every language.
import { ServiceKeys, parseServiceKeys, serviceKeyHash } from "@gsalgadotoledo/rt-app-auth";
import { memoryStore } from "./storage.mjs";

async function serviceKeys(init) {
  let now = Date.parse(init.now ?? "2026-01-01T00:00:00.000Z");
  if (Number.isNaN(now)) throw new Error("init.now must be an ISO 8601 date");
  const store = await memoryStore(init.rows ?? []);
  let calls = 0;
  const random = (bytes) => Buffer.alloc(bytes, ++calls % 256).toString("base64url");
  const keys = new ServiceKeys(store, init.secret, { keys: init.keys ?? undefined, scopes: init.scopes ?? [], now: () => now, random });
  keys.validate();
  const feature = keys.feature();
  const all = async (pk) => {
    const rows = [];
    let cursor;
    do {
      const page = await store.list(pk, cursor);
      rows.push(...page.items);
      cursor = page.cursor;
    } while (cursor);
    return rows;
  };
  return {
    parse: (config, scopes) => parseServiceKeys(config ?? undefined, scopes ?? []).map((k) => ({ id: k.id, secretHash: k.secretHash, scopes: k.scopes, description: k.description, rateLimit: k.rateLimit })),
    list: () => keys.list(),
    create: (input, actorId) => keys.create(input, actorId),
    rotate: (id, actorId) => keys.rotate(id, actorId),
    revoke: (id, actorId) => keys.revoke(id, actorId),
    actor: (authorization) => keys.actor(authorization ?? undefined),
    check: (endpoint, actor) => {
      keys.check(endpoint, actor ?? undefined);
      return null;
    },
    // authorize(authorization, endpoint): actor(), then check(): what the framework does per request.
    authorize: async (authorization, endpoint) => {
      const actor = await keys.actor(authorization ?? undefined);
      keys.check(endpoint, actor);
      return actor;
    },
    hash: (token) => serviceKeyHash(token),
    endpoints: () => feature.endpoints.map((e) => ({ method: e.method, path: e.path, access: e.access, resource: e.resource, tool: e.tool?.name })),
    admin: () => feature.admin,
    self: (actor) => feature.endpoints.find((e) => e.path === "/service/keys/self").handle({ request: { body: {}, query: {}, headers: {} }, params: {}, actor }),
    audit: async (id) => (await all("SERVICE_KEY_AUDIT#" + id)).map((r) => ({ sk: r.sk, ...r.data })),
    row: (pk, sk) => store.get(pk, sk),
    setNow: (iso) => {
      const value = Date.parse(iso);
      if (typeof iso !== "string" || Number.isNaN(value)) throw new Error("setNow needs an ISO 8601 date");
      now = value;
      return null;
    },
  };
}

export const subjects = { serviceKeys };
