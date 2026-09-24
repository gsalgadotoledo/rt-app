import test from "node:test";
import assert from "node:assert/strict";
import {
  ProviderRegistry,
  validateDeploySettings,
  resolveCredentials,
  settingsFor,
  resourceName,
  createApi,
  redact,
  ProviderError,
  planEnvironment,
  applyEnvironment,
  ROLES,
  ROLE_LABELS,
  secretValues,
  variablesFor,
} from "@gsalgadotoledo/rt-app-deploy";
import { fakeFetch, testContext } from "@gsalgadotoledo/rt-app-deploy/testing";

function provider(id, roles, extra = {}) {
  const calls = [];
  return {
    calls,
    id,
    name: id.toUpperCase(),
    roles,
    website: "https://" + id + ".example",
    credentials: [{ key: id.toUpperCase() + "_TOKEN", label: "Token" }, { key: id.toUpperCase() + "_TEAM", label: "Team", optional: true }],
    settings: [
      { key: "region", label: "Region", type: "string", default: "us", options: ["us", "eu"] },
      { key: "size", label: "Size", type: "number" },
    ],
    async plan(context) {
      calls.push(["plan", context.role, { ...context.variables }]);
      return { provider: id, role: context.role, environment: context.environment, actions: [{ action: "create", resource: context.role, detail: "new" }] };
    },
    async apply(context) {
      calls.push(["apply", context.role]);
      return { provider: id, role: context.role, resources: [], ...(context.role === "api" ? { url: "https://api.example" } : {}), outputs: context.role === "database" ? { DATABASE_URL: "postgres://secret" } : {} };
    },
    async status() {
      return { state: "live" };
    },
    ...extra,
  };
}

test("registry validates ids and roles and exposes a public catalog without functions", () => {
  const registry = new ProviderRegistry().register(provider("neon", ["database"]));
  assert.throws(() => registry.register(provider("neon", ["database"])), /Duplicate provider/);
  assert.throws(() => registry.register(provider("Bad Id", ["api"])), /Invalid provider id/);
  assert.throws(() => registry.register(provider("x1", [])), /Invalid roles/);
  assert.throws(() => registry.register(provider("x2", ["email"])), /Invalid roles/);
  assert.throws(() => registry.get("nope"), /Unknown deploy provider/);
  const [entry] = registry.catalog();
  assert.deepEqual(Object.keys(entry).sort(), ["credentials", "id", "name", "notes", "roles", "settings", "website"]);
  assert.equal(JSON.stringify(entry).includes("function"), false);
  assert.equal(ROLES.length, Object.keys(ROLE_LABELS).length);
});

test("deploy settings are validated against providers, roles and setting specs", () => {
  const registry = new ProviderRegistry().register(provider("render", ["api", "ssr"])).register(provider("neon", ["database"]));
  assert.deepEqual(
    validateDeploySettings({ environments: { stage: { api: { provider: "render", settings: { region: "eu", size: 2 } }, database: { provider: "neon" } } } }, registry),
    { environments: { stage: { api: { provider: "render", settings: { region: "eu", size: 2 } }, database: { provider: "neon" } } } },
  );
  assert.deepEqual(validateDeploySettings(undefined, registry), { environments: {} });
  for (const [input, error] of [
    [[], /must be an object/],
    [{ environments: { qa: {} } }, /Unknown environment/],
    [{ environments: { stage: { email: { provider: "render" } } } }, /Unknown role/],
    [{ environments: { stage: { database: { provider: "render" } } } }, /does not support the database role/],
    [{ environments: { stage: { api: { provider: "heroku" } } } }, /Unknown deploy provider/],
    [{ environments: { stage: { api: { provider: "render", settings: { color: "red" } } } } }, /Unknown setting color/],
    [{ environments: { stage: { api: { provider: "render", settings: { region: "mars" } } } } }, /Invalid value/],
    [{ environments: { stage: { api: { provider: "render", settings: { size: "2" } } } } }, /Invalid value/],
  ])
    assert.throws(() => validateDeploySettings(input, registry), error);
});

test("credentials come from the environment; optional ones may be absent", () => {
  const p = provider("render", ["api"]);
  assert.deepEqual(resolveCredentials(p, { RENDER_TOKEN: "t" }), { values: { RENDER_TOKEN: "t" }, missing: [] });
  assert.deepEqual(resolveCredentials(p, { RENDER_TEAM: "x" }), { values: { RENDER_TEAM: "x" }, missing: ["RENDER_TOKEN"] });
  assert.deepEqual(settingsFor(p, { provider: "render" }), { region: "us" });
  assert.deepEqual(settingsFor(p, { provider: "render", settings: { region: "eu" } }), { region: "eu" });
  assert.deepEqual(settingsFor({ ...p, settings: undefined }, { provider: "render" }), {});
});

test("resource names are stable, provider-safe and bounded", () => {
  assert.equal(resourceName("My_Shop", "stage", "api"), "my-shop-stage-api");
  assert.equal(resourceName("a".repeat(50), "prod", "database").length, 40);
  assert.equal(resourceName("shop--x", "stage", "api", 12), "shop-x-stage");
});

test("api client: JSON, 404 as null, retries for reads and rate limits, redacted errors", async () => {
  const sleeps = [];
  let attempts = 0;
  const { fetch, calls } = fakeFetch({
    "GET https://api.example/v1/ok": { body: { ok: true } },
    "GET https://api.example/v1/missing": { status: 404, body: { message: "not found" } },
    "GET https://api.example/v1/flaky": () => (++attempts < 3 ? { status: 503, body: "busy" } : { body: { ok: attempts } }),
    "POST https://api.example/v1/limited": () => ({ status: 429, body: "slow down", headers: { "retry-after": "2" } }),
    "POST https://api.example/v1/fail": { status: 500, body: "token sk_live_123456 invalid" },
    "PUT https://api.example/v1/empty": { status: 204 },
    "PATCH https://api.example/v1/text": { body: "plain" },
    "DELETE https://api.example/v1/gone": { status: 200 },
  });
  const api = createApi({ provider: "Example", baseUrl: "https://api.example/v1/", headers: { authorization: "Bearer sk_live_123456" }, fetch, secrets: ["sk_live_123456"], sleep: async (ms) => sleeps.push(ms) });
  assert.deepEqual(await api.get("/ok"), { ok: true });
  assert.equal(await api.find("/missing"), null);
  await assert.rejects(api.get("/missing"), (e) => e instanceof ProviderError && e.status === 404);
  assert.deepEqual(await api.get("/flaky"), { ok: 3 });
  await assert.rejects(api.post("/limited", { a: 1 }), (e) => e.status === 429);
  assert.deepEqual(sleeps, [500, 1000, 2000, 2000]);
  await assert.rejects(api.post("/fail"), (e) => e.message.includes("[redacted]") && !e.message.includes("sk_live_123456"));
  assert.equal(await api.put("/empty"), undefined);
  assert.equal(await api.patch("/text", {}), "plain");
  assert.equal(await api.delete("/gone"), undefined);
  assert.equal(calls[0].headers.authorization, "Bearer sk_live_123456");
  assert.equal(calls.find((c) => c.method === "POST").headers["content-type"], "application/json");
  assert.equal(calls[0].headers["content-type"], undefined);
  assert.equal(await api.get("https://other.example/abs").catch((e) => e.message.includes("Unexpected request")), true);
});

test("api client: network errors retry reads only and never leak secrets", async () => {
  let n = 0;
  const fetch = async () => {
    n++;
    throw new Error("connect ECONNREFUSED key=abcd1234");
  };
  const api = createApi({ provider: "X", baseUrl: "https://x", headers: {}, fetch, secrets: ["abcd1234"], sleep: async () => {} });
  await assert.rejects(api.get("/a"), (e) => e.status === 0 && e.message.includes("[redacted]"));
  assert.equal(n, 3);
  await assert.rejects(api.post("/b"));
  assert.equal(n, 4, "writes are not retried");
  assert.equal(redact("abc", ["abc"]), "abc", "short values are not treated as secrets");
});

test("orchestration: role order, outputs feed later roles, missing credentials stop before any call", async () => {
  const neon = provider("neon", ["database"]);
  const render = provider("render", ["api", "ssr", "frontend"]);
  const registry = new ProviderRegistry().register(neon).register(render);
  const settings = validateDeploySettings({ environments: { prod: { frontend: { provider: "render" }, api: { provider: "render" }, database: { provider: "neon" } } } }, registry);
  const base = { registry, settings, app: "shop", environment: "prod", source: (role) => ({ branch: "main", directory: "apps/" + role }), variables: { JWT_SECRET: "j" } };
  await assert.rejects(planEnvironment({ ...base, env: { NEON_TOKEN: "n" } }), /Missing credentials: render:RENDER_TOKEN/);
  assert.equal(neon.calls.length, 0);
  const env = { NEON_TOKEN: "n", RENDER_TOKEN: "r" };
  const plans = await planEnvironment({ ...base, env });
  assert.deepEqual(plans.map((p) => p.role), ["database", "api", "frontend"]);
  neon.calls.length = render.calls.length = 0;
  const { results, outputs } = await applyEnvironment({ ...base, env, roles: ["database", "api"] });
  assert.deepEqual(results.map((r) => r.role), ["database", "api"]);
  assert.deepEqual(outputs, { DATABASE_URL: "postgres://secret", RT_APP_API_URL: "https://api.example" });
  assert.deepEqual(render.calls[0], ["plan", "api", { JWT_SECRET: "j", DATABASE_URL: "postgres://secret" }]);
  assert.deepEqual(await applyEnvironment({ ...base, env, environment: "develop" }), { results: [], outputs: {} }, "unconfigured environment deploys nothing");
});

test("orchestration reports partial progress when a later role fails", async () => {
  const neon = provider("neon", ["database"]);
  const render = provider("render", ["api"], { apply: async () => { throw new Error("render: quota exceeded"); } });
  const registry = new ProviderRegistry().register(neon).register(render);
  const settings = { environments: { stage: { database: { provider: "neon" }, api: { provider: "render" } } } };
  await assert.rejects(
    applyEnvironment({ registry, settings, app: "shop", environment: "stage", env: { NEON_TOKEN: "n", RENDER_TOKEN: "r" }, source: () => ({ branch: "stage", directory: "." }) }),
    /quota exceeded \(already applied: database:neon\)/,
  );
  await assert.rejects(
    applyEnvironment({ registry, settings: { environments: { stage: { api: { provider: "render" } } } }, app: "shop", environment: "stage", env: { RENDER_TOKEN: "r" }, source: () => ({ branch: "stage", directory: "." }) }),
    /already applied: nothing/,
  );
});

test("testing kit: default context and strict fake fetch", async () => {
  const context = testContext({ role: "api" });
  assert.equal(context.app, "shop");
  await assert.rejects(context.fetch("https://x"), /No fetch configured/);
  context.log("ignored");
  const { fetch } = fakeFetch({ "GET https://a.example/x": () => undefined });
  assert.equal((await fetch("https://a.example/x")).status, 200);
  await assert.rejects(fetch("https://b.example"), /Unexpected request: GET https:\/\/b.example/);
});

test("secretValues collects credentials and runtime variables for redaction", () => {
  assert.deepEqual(secretValues({ credentials: { A: "token-1234" }, variables: { DATABASE_URL: "postgres://u:p@h/db", SHORT: "no" } }), ["token-1234", "postgres://u:p@h/db"]);
});

test("only the API receives secrets; SSR and static builds get public values", () => {
  const all = { DATABASE_URL: "postgres://x", JWT_SECRET: "j", RT_APP_API_URL: "https://api", RT_APP_ENVIRONMENT: "stage", NODE_ENV: "production", RT_APP_TARGET: "portable" };
  assert.deepEqual(variablesFor("api", all), all);
  assert.deepEqual(variablesFor("database", all), all);
  assert.deepEqual(variablesFor("ssr", all), { RT_APP_API_URL: "https://api", RT_APP_ENVIRONMENT: "stage", NODE_ENV: "production", RT_APP_TARGET: "portable" });
  assert.deepEqual(Object.keys(variablesFor("frontend", all)).sort(), ["NODE_ENV", "RT_APP_API_URL", "RT_APP_ENVIRONMENT", "RT_APP_TARGET"]);
});

test("orchestration never passes database outputs to the frontend", async () => {
  const seen = {};
  const make = (id, roles, outputs = {}, url) => ({
    id, name: id, roles, website: "https://x", credentials: [],
    plan: async (c) => ({ provider: id, role: c.role, environment: c.environment, actions: [] }),
    apply: async (c) => { seen[c.role] = { ...c.variables }; return { provider: id, role: c.role, resources: [], outputs, url }; },
    status: async () => ({ state: "live" }),
  });
  const registry = new ProviderRegistry().register(make("neon", ["database"], { DATABASE_URL: "postgres://secret" })).register(make("render", ["api"], {}, "https://api.example")).register(make("vercel", ["frontend"]));
  await applyEnvironment({ registry, settings: { environments: { stage: { database: { provider: "neon" }, api: { provider: "render" }, frontend: { provider: "vercel" } } } }, app: "shop", environment: "stage", env: {}, variables: { JWT_SECRET: "j", RT_APP_ENVIRONMENT: "stage" }, source: () => ({ branch: "stage", directory: "." }) });
  assert.equal(seen.api.DATABASE_URL, "postgres://secret");
  assert.deepEqual(seen.frontend, { RT_APP_ENVIRONMENT: "stage", RT_APP_API_URL: "https://api.example" });
});
