import test from "node:test";
import assert from "node:assert/strict";
import provider, { provider as named, mapOperations, NEON_REGIONS } from "@gsalgadotoledo/rt-app-deploy-neon";
import { ProviderRegistry, ProviderError, validateDeploySettings } from "@gsalgadotoledo/rt-app-deploy";
import { fakeFetch, testContext } from "@gsalgadotoledo/rt-app-deploy/testing";

const API = "https://console.neon.tech/api/v2";
const KEY = "napi_key_secret_123";
const POOLED = "postgresql://neondb_owner:npg_pass@ep-x-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require";

function context(fetch, overrides = {}) {
  return testContext({ role: "database", fetch, credentials: { NEON_API_KEY: KEY }, ...overrides });
}

function routes({ existing = false, extra = {} } = {}) {
  let created = false;
  return {
    [`GET ${API}/projects?`]: () => ({
      body: {
        projects: [
          { id: "other-1", name: "shop-stage-database-old" },
          ...(existing || created ? [{ id: "proj-1", name: "shop-stage-database", region_id: "aws-us-east-2", pg_version: 17 }] : []),
        ],
      },
    }),
    [`POST ${API}/projects`]: () => {
      created = true;
      return { status: 201, body: { project: { id: "proj-1", name: "shop-stage-database" }, branch: { id: "br-main" }, databases: [{ name: "neondb", owner_name: "neondb_owner", branch_id: "br-main" }] } };
    },
    [`GET ${API}/projects/proj-1/branches`]: { body: { branches: [{ id: "br-dev", default: false }, { id: "br-main", default: true }] } },
    [`GET ${API}/projects/proj-1/branches/br-main/databases`]: { body: { databases: [{ name: "neondb", owner_name: "neondb_owner" }] } },
    [`GET ${API}/projects/proj-1/connection_uri`]: { body: { uri: POOLED } },
    ...extra,
  };
}

test("provider metadata is registrable with real regions and Postgres versions", () => {
  assert.equal(named, provider);
  const registry = new ProviderRegistry().register(provider);
  assert.deepEqual(provider.roles, ["database"]);
  assert.deepEqual(provider.credentials.map((c) => [c.key, !!c.optional]), [["NEON_API_KEY", false], ["NEON_ORG_ID", true]]);
  assert.ok(NEON_REGIONS.includes("aws-eu-central-1"));
  const valid = validateDeploySettings({ environments: { prod: { database: { provider: "neon", settings: { region: "aws-eu-central-1", pgVersion: 16, pooled: false } } } } }, registry);
  assert.equal(valid.environments.prod.database.settings.pgVersion, 16);
  assert.throws(() => validateDeploySettings({ environments: { prod: { database: { provider: "neon", settings: { pgVersion: 12 } } } } }, registry), /Invalid value/);
});

test("plan for a missing project uses GET only and plans a create", async () => {
  const { fetch, calls } = fakeFetch(routes());
  const plan = await provider.plan(context(fetch, { settings: { region: "aws-eu-central-1", pgVersion: 16 } }));
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [`GET ${API}/projects?search=shop-stage-database&limit=400`]);
  assert.equal(calls[0].headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(plan.actions, [{ action: "create", resource: "shop-stage-database", detail: "Create Neon project in aws-eu-central-1 (Postgres 16)" }]);
  assert.deepEqual(plan.state, {});
});

test("plan for an existing project is a noop carrying its id; org id filters the search", async () => {
  const { fetch, calls } = fakeFetch(routes({ existing: true }));
  const plan = await provider.plan(context(fetch, { credentials: { NEON_API_KEY: KEY, NEON_ORG_ID: "org-acme-1" } }));
  assert.equal(calls[0].url, `${API}/projects?search=shop-stage-database&limit=400&org_id=org-acme-1`);
  assert.ok(calls.every((c) => c.method === "GET"));
  assert.equal(plan.actions[0].action, "noop");
  assert.match(plan.actions[0].detail, /aws-us-east-2, Postgres 17/);
  assert.deepEqual(plan.state, { projectId: "proj-1" });
});

test("apply creates the project and returns the pooled DATABASE_URL without logging it", async () => {
  const { fetch, calls } = fakeFetch(routes());
  const logs = [];
  const result = await provider.apply(
    context(fetch, { settings: { region: "aws-eu-central-1", pgVersion: 16 }, credentials: { NEON_API_KEY: KEY, NEON_ORG_ID: "org-acme-1" }, log: (m) => logs.push(m) }),
    { actions: [] },
  );
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [
    `GET ${API}/projects?search=shop-stage-database&limit=400&org_id=org-acme-1`,
    `POST ${API}/projects`,
    `GET ${API}/projects/proj-1/connection_uri?database_name=neondb&role_name=neondb_owner&pooled=true&branch_id=br-main`,
  ]);
  assert.deepEqual(calls[1].body, { project: { name: "shop-stage-database", region_id: "aws-eu-central-1", pg_version: 16, org_id: "org-acme-1" } });
  assert.deepEqual(result.outputs, { DATABASE_URL: POOLED });
  assert.deepEqual(result.resources, [
    { kind: "project", id: "proj-1", name: "shop-stage-database" },
    { kind: "database", id: "neondb", name: "neondb" },
  ]);
  assert.equal(logs.some((l) => l.includes("npg_pass")), false);
  assert.match(logs.join("\n"), /pooled connection string ready/);
});

test("apply re-run is idempotent: finds the project, reads defaults, never creates again", async () => {
  const { fetch, calls } = fakeFetch(routes());
  const ctx = context(fetch, { settings: { pooled: false } });
  await provider.apply(ctx, { actions: [] });
  const second = await provider.apply(ctx, { actions: [] });
  assert.equal(calls.filter((c) => c.method === "POST").length, 1);
  assert.deepEqual(calls.slice(3).map((c) => `${c.method} ${c.url}`), [
    `GET ${API}/projects?search=shop-stage-database&limit=400`,
    `GET ${API}/projects/proj-1/branches`,
    `GET ${API}/projects/proj-1/branches/br-main/databases`,
    `GET ${API}/projects/proj-1/connection_uri?database_name=neondb&role_name=neondb_owner&pooled=false&branch_id=br-main`,
  ]);
  assert.equal(second.outputs.DATABASE_URL, POOLED);
});

test("apply uses defaults (region, Postgres 17) and falls back to branch lookup when create omits databases", async () => {
  const { fetch, calls } = fakeFetch(
    routes({
      extra: {
        [`POST ${API}/projects`]: { status: 201, body: { project: { id: "proj-1" } } },
        [`GET ${API}/projects/proj-1/branches`]: { body: { branches: [{ id: "br-main" }] } },
      },
    }),
  );
  await provider.apply(context(fetch), { actions: [] });
  assert.deepEqual(calls[1].body, { project: { name: "shop-stage-database", region_id: "aws-us-east-1", pg_version: 17 } });
  assert.ok(calls.some((c) => c.url === `${API}/projects/proj-1/branches/br-main/databases`));
});

test("apply fails clearly when the project has no branch or no database", async () => {
  const noBranch = fakeFetch(routes({ existing: true, extra: { [`GET ${API}/projects/proj-1/branches`]: { body: {} } } }));
  await assert.rejects(provider.apply(context(noBranch.fetch), { actions: [] }), /has no branch/);
  const noDb = fakeFetch(routes({ existing: true, extra: { [`GET ${API}/projects/proj-1/branches/br-main/databases`]: { body: {} } } }));
  await assert.rejects(provider.apply(context(noDb.fetch), { actions: [] }), /has no database/);
});

test("provider errors are redacted and typed", async () => {
  const { fetch } = fakeFetch(routes({ extra: { [`POST ${API}/projects`]: { status: 422, body: `projects limit exceeded for key ${KEY}` } } }));
  await assert.rejects(provider.apply(context(fetch), { actions: [] }), (e) => {
    assert.ok(e instanceof ProviderError && e.status === 422);
    assert.equal(e.message.includes(KEY), false);
    assert.match(e.message, /Neon: POST \/projects → 422 .*\[redacted\]/);
    return true;
  });
});

test("unsupported role and missing key fail before any request", async () => {
  const { fetch, calls } = fakeFetch(routes());
  for (const fn of ["plan", "apply", "status"])
    await assert.rejects(provider[fn](context(fetch, { role: "api" }), { actions: [] }), /Neon does not support the api role/);
  await assert.rejects(provider.plan(context(fetch, { credentials: {} })), /Missing credential NEON_API_KEY/);
  assert.equal(calls.length, 0);
});

test("status: missing, deploying while operations run, live otherwise", async () => {
  let operations = [{ status: "running" }];
  const { fetch, calls } = fakeFetch({
    ...routes({ existing: true }),
    [`GET ${API}/projects/proj-1/operations`]: () => ({ body: { operations } }),
  });
  assert.equal((await provider.status(context(fetch))).state, "deploying");
  assert.equal(calls.at(-1).url, `${API}/projects/proj-1/operations?limit=10`);
  operations = [{ status: "finished" }];
  assert.deepEqual(await provider.status(context(fetch)), { state: "live", detail: "Project proj-1" });
  const empty = fakeFetch({ [`GET ${API}/projects?`]: { body: {} } });
  assert.deepEqual(await provider.status(context(empty.fetch)), { state: "missing" });
  const noOps = fakeFetch({ ...routes({ existing: true }), [`GET ${API}/projects/proj-1/operations`]: { body: {} } });
  assert.equal((await provider.status(context(noOps.fetch))).state, "live");
  assert.equal(mapOperations([{ status: "scheduling" }]), "deploying");
  assert.equal(mapOperations([{ status: "failed" }, { status: "finished" }]), "live");
});
