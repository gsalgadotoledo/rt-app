import test from "node:test";
import assert from "node:assert/strict";
import provider, { provider as named, createSupabaseProvider, mapProjectStatus, SUPABASE_REGIONS } from "@gsalgadotoledo/rt-app-deploy-supabase";
import { ProviderRegistry, ProviderError } from "@gsalgadotoledo/rt-app-deploy";
import { fakeFetch, testContext } from "@gsalgadotoledo/rt-app-deploy/testing";

const API = "https://api.supabase.com";
const TOKEN = "sbp_token_secret_123";
const PASSWORD = "p@ss/w0rd secret";
const ENCODED = encodeURIComponent(PASSWORD);
const CREDENTIALS = { SUPABASE_ACCESS_TOKEN: TOKEN, SUPABASE_ORG_ID: "acme-org", SUPABASE_DB_PASSWORD: PASSWORD };
const POOLER = [
  { database_type: "READ_REPLICA", db_user: "postgres.replica", db_host: "replica.pooler.supabase.com", db_port: 6543, db_name: "postgres", pool_mode: "transaction" },
  { database_type: "PRIMARY", db_user: "postgres.abcref", db_host: "aws-0-us-east-1.pooler.supabase.com", db_port: 5432, db_name: "postgres", pool_mode: "session" },
  { database_type: "PRIMARY", db_user: "postgres.abcref", db_host: "aws-0-us-east-1.pooler.supabase.com", db_port: 6543, db_name: "postgres", pool_mode: "transaction" },
];

function context(fetch, overrides = {}) {
  return testContext({ role: "database", fetch, credentials: CREDENTIALS, ...overrides });
}

function fakeSleep() {
  const sleeps = [];
  return { sleeps, sleep: async (ms) => void sleeps.push(ms) };
}

/** Fake API: listed projects, then a status sequence for GET /v1/projects/{ref}. */
function routes({ listed = [], statuses = ["ACTIVE_HEALTHY"], created = "COMING_UP", pooler = POOLER, extra = {} } = {}) {
  let polls = 0;
  const other = { ref: "zzz", name: "shop-stage-database", organization_slug: "other-org", status: "ACTIVE_HEALTHY" };
  const removed = { ref: "old", name: "shop-stage-database", organization_slug: "acme-org", status: "REMOVED" };
  return {
    [`GET ${API}/v1/projects`]: { body: [other, removed, ...listed] },
    [`POST ${API}/v1/projects`]: { status: 201, body: { ref: "abcref", name: "shop-stage-database", organization_slug: "acme-org", status: created } },
    [`GET ${API}/v1/projects/abcref`]: () => ({ body: { ref: "abcref", status: statuses[Math.min(polls++, statuses.length - 1)] } }),
    [`GET ${API}/v1/projects/abcref/config/database/pooler`]: pooler === null ? { status: 404, body: {} } : { body: pooler },
    ...extra,
  };
}

const existing = (status = "ACTIVE_HEALTHY", org = { organization_slug: "acme-org" }) => ({ ref: "abcref", name: "shop-stage-database", region: "eu-west-1", status, ...org });

test("provider metadata is registrable; credentials are required; regions are real", () => {
  assert.equal(named, provider);
  new ProviderRegistry().register(provider);
  assert.deepEqual(provider.roles, ["database"]);
  assert.deepEqual(provider.credentials.map((c) => [c.key, !!c.optional]), [["SUPABASE_ACCESS_TOKEN", false], ["SUPABASE_ORG_ID", false], ["SUPABASE_DB_PASSWORD", false]]);
  assert.ok(SUPABASE_REGIONS.includes("eu-central-1"));
  assert.deepEqual(provider.settings.map((s) => [s.key, s.default]), [["region", "us-east-1"], ["connection", "pooler"], ["waitTimeoutSeconds", 600], ["pollIntervalSeconds", 10]]);
});

test("plan for a missing project: GET only, ignores other orgs and removed projects", async () => {
  const { fetch, calls } = fakeFetch(routes());
  const plan = await provider.plan(context(fetch, { settings: { region: "eu-central-1" } }));
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [`GET ${API}/v1/projects`]);
  assert.equal(calls[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(plan.actions[0].action, "create");
  assert.match(plan.actions[0].detail, /eu-central-1/);
  assert.deepEqual(plan.state, {});
});

test("plan for an existing project is a noop with its ref (legacy organization_id also matches)", async () => {
  const { fetch, calls } = fakeFetch(routes({ listed: [existing("ACTIVE_HEALTHY", { organization_id: "acme-org" })] }));
  const plan = await provider.plan(context(fetch));
  assert.ok(calls.every((c) => c.method === "GET"));
  assert.equal(plan.actions[0].action, "noop");
  assert.match(plan.actions[0].detail, /abcref exists \(eu-west-1, ACTIVE_HEALTHY\)/);
  assert.deepEqual(plan.state, { ref: "abcref" });
});

test("apply creates the project, polls until healthy (fake sleep) and returns the pooler URL", async () => {
  const { sleep, sleeps } = fakeSleep();
  const p = createSupabaseProvider({ sleep });
  const { fetch, calls } = fakeFetch(routes({ statuses: ["COMING_UP", "COMING_UP", "ACTIVE_HEALTHY"] }));
  const logs = [];
  const result = await p.apply(context(fetch, { settings: { region: "eu-central-1", pollIntervalSeconds: 5 }, log: (m) => logs.push(m) }), { actions: [] });
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [
    `GET ${API}/v1/projects`,
    `POST ${API}/v1/projects`,
    `GET ${API}/v1/projects/abcref`,
    `GET ${API}/v1/projects/abcref`,
    `GET ${API}/v1/projects/abcref`,
    `GET ${API}/v1/projects/abcref/config/database/pooler`,
  ]);
  assert.deepEqual(calls[1].body, {
    name: "shop-stage-database",
    organization_slug: "acme-org",
    db_pass: PASSWORD,
    region_selection: { type: "specific", code: "eu-central-1" },
  });
  assert.deepEqual(sleeps, [5000, 5000, 5000]);
  assert.equal(result.outputs.DATABASE_URL, `postgresql://postgres.abcref:${ENCODED}@aws-0-us-east-1.pooler.supabase.com:6543/postgres`);
  assert.deepEqual(result.resources, [{ kind: "project", id: "abcref", name: "shop-stage-database" }]);
  const logged = logs.join("\n");
  assert.equal(logged.includes(PASSWORD) || logged.includes(ENCODED), false, "password never logged");
  assert.match(logged, /pooler \(transaction\) connection string ready/);
});

test("apply re-run on a healthy project is idempotent: no create, no wait", async () => {
  const { sleep, sleeps } = fakeSleep();
  const p = createSupabaseProvider({ sleep });
  const { fetch, calls } = fakeFetch(routes({ listed: [existing()] }));
  const first = await p.apply(context(fetch), { actions: [] });
  const second = await p.apply(context(fetch), { actions: [] });
  assert.equal(calls.filter((c) => c.method !== "GET").length, 0);
  assert.equal(sleeps.length, 0);
  assert.equal(first.outputs.DATABASE_URL, second.outputs.DATABASE_URL);
});

test("DATABASE_URL: direct setting, first primary when no transaction pooler, direct fallback on 404/empty", async () => {
  const direct = `postgresql://postgres:${ENCODED}@db.abcref.supabase.co:5432/postgres`;
  const d = fakeFetch(routes({ listed: [existing()] }));
  assert.equal((await provider.apply(context(d.fetch, { settings: { connection: "direct" } }), { actions: [] })).outputs.DATABASE_URL, direct);
  assert.equal(d.calls.some((c) => c.url.includes("pooler")), false);
  const session = fakeFetch(routes({ listed: [existing()], pooler: [{ db_user: "postgres.abcref", db_host: "h.pooler.supabase.com", db_port: 5432, db_name: "postgres" }] }));
  assert.equal((await provider.apply(context(session.fetch), { actions: [] })).outputs.DATABASE_URL, `postgresql://postgres.abcref:${ENCODED}@h.pooler.supabase.com:5432/postgres`);
  for (const pooler of [null, []]) {
    const logs = [];
    const f = fakeFetch(routes({ listed: [existing()], pooler }));
    assert.equal((await provider.apply(context(f.fetch, { log: (m) => logs.push(m) }), { actions: [] })).outputs.DATABASE_URL, direct);
    assert.match(logs.join(), /direct \(no pooler config\)/);
  }
});

test("apply times out after waitTimeoutSeconds of polling without real sleeping", async () => {
  const { sleep, sleeps } = fakeSleep();
  const p = createSupabaseProvider({ sleep });
  const { fetch } = fakeFetch(routes({ statuses: ["COMING_UP"] }));
  await assert.rejects(
    p.apply(context(fetch, { settings: { waitTimeoutSeconds: 30, pollIntervalSeconds: 10 } }), { actions: [] }),
    /abcref not healthy after 30s \(last status COMING_UP\)/,
  );
  assert.deepEqual(sleeps, [10000, 10000, 10000]);
  const zero = fakeFetch(routes({ statuses: ["COMING_UP"] }));
  await assert.rejects(p.apply(context(zero.fetch, { settings: { pollIntervalSeconds: 0 } }), { actions: [] }), /not healthy after 600s/);
  const invalid = fakeFetch(routes({ statuses: ["COMING_UP"] }));
  await assert.rejects(p.apply(context(invalid.fetch, { settings: { waitTimeoutSeconds: -1, pollIntervalSeconds: 300 } }), { actions: [] }), /after 600s/);
  assert.equal(sleeps.length, 5, "invalid timeout falls back to 600s: two 300s polls");
});

test("apply fails fast on failed or stopped projects", async () => {
  const { sleep, sleeps } = fakeSleep();
  const p = createSupabaseProvider({ sleep });
  const failed = fakeFetch(routes({ statuses: ["INIT_FAILED"] }));
  await assert.rejects(p.apply(context(failed.fetch), { actions: [] }), /abcref is INIT_FAILED/);
  const paused = fakeFetch(routes({ listed: [existing("INACTIVE")] }));
  await assert.rejects(p.apply(context(paused.fetch), { actions: [] }), /is INACTIVE; restore it from the dashboard/);
  assert.deepEqual(sleeps, [10000]);
});

test("the default provider waits with real timers (1 ms interval keeps the test fast)", async () => {
  const { fetch } = fakeFetch(routes({ statuses: ["ACTIVE_HEALTHY"] }));
  const result = await provider.apply(context(fetch, { settings: { pollIntervalSeconds: 0.001 } }), { actions: [] });
  assert.ok(result.outputs.DATABASE_URL.startsWith("postgresql://postgres.abcref:"));
});

test("provider errors redact token and password", async () => {
  const { fetch } = fakeFetch(routes({ extra: { [`POST ${API}/v1/projects`]: { status: 400, body: `invalid db_pass ${PASSWORD} ${ENCODED} for ${TOKEN}` } } }));
  await assert.rejects(provider.apply(context(fetch), { actions: [] }), (e) => {
    assert.ok(e instanceof ProviderError && e.status === 400);
    for (const secret of [PASSWORD, ENCODED, TOKEN]) assert.equal(e.message.includes(secret), false);
    return true;
  });
});

test("unsupported role and missing credentials fail before any request", async () => {
  const { fetch, calls } = fakeFetch(routes());
  for (const fn of ["plan", "apply", "status"])
    await assert.rejects(provider[fn](context(fetch, { role: "ssr" }), { actions: [] }), /Supabase does not support the ssr role/);
  await assert.rejects(provider.plan(context(fetch, { credentials: {} })), /Missing credential SUPABASE_ACCESS_TOKEN/);
  await assert.rejects(provider.apply(context(fetch, { credentials: { ...CREDENTIALS, SUPABASE_DB_PASSWORD: "" } }), { actions: [] }), /Missing credential SUPABASE_DB_PASSWORD/);
  assert.equal(calls.length, 0);
  await assert.rejects(provider.plan(context(fetch, { credentials: { SUPABASE_ACCESS_TOKEN: TOKEN } })), /Missing credential SUPABASE_ORG_ID/);
});

test("status mapping", async () => {
  const missing = fakeFetch({ [`GET ${API}/v1/projects`]: { body: [] } });
  assert.deepEqual(await provider.status(context(missing.fetch)), { state: "missing" });
  const nullBody = fakeFetch({ [`GET ${API}/v1/projects`]: { status: 200 } });
  assert.deepEqual(await provider.status(context(nullBody.fetch)), { state: "missing" });
  const live = fakeFetch(routes({ listed: [existing("COMING_UP")] }));
  assert.deepEqual(await provider.status(context(live.fetch)), { state: "deploying", detail: "COMING_UP" });
  for (const [status, expected] of [
    ["ACTIVE_HEALTHY", "live"],
    ["COMING_UP", "deploying"],
    ["RESTORING", "deploying"],
    ["UPGRADING", "deploying"],
    ["RESTARTING", "deploying"],
    ["RESIZING", "deploying"],
    ["INIT_FAILED", "failed"],
    ["RESTORE_FAILED", "failed"],
    ["PAUSE_FAILED", "failed"],
    ["ACTIVE_UNHEALTHY", "failed"],
    ["INACTIVE", "unknown"],
    ["UNKNOWN", "unknown"],
    [undefined, "unknown"],
  ])
    assert.equal(mapProjectStatus(status), expected, String(status));
});
