import test from "node:test";
import assert from "node:assert/strict";
import provider, { provider as named } from "@gsalgadotoledo/rt-app-deploy-render";
import { ProviderRegistry, validateDeploySettings } from "@gsalgadotoledo/rt-app-deploy";
import { fakeFetch, testContext } from "@gsalgadotoledo/rt-app-deploy/testing";

const API = "https://api.render.com/v1";
const KEY = "rnd_secret_key_123";
const credentials = { RENDER_API_KEY: KEY };

function context(role, fetch, overrides = {}) {
  return testContext({ role, fetch, credentials, variables: { DATABASE_URL: "postgres://u:p@h/db", JWT_SECRET: "jwt-value" }, ...overrides });
}

function service(id, name, type = "web_service", extra = {}) {
  return { id, name, type, suspended: "not_suspended", serviceDetails: { url: `https://${name}.onrender.com` }, ...extra };
}

test("metadata: roles, credentials, settings and registry compatibility", () => {
  assert.equal(named, provider);
  assert.equal(provider.id, "render");
  assert.deepEqual(provider.roles, ["api", "ssr", "frontend"]);
  assert.deepEqual(provider.credentials.map((c) => [c.key, Boolean(c.optional)]), [["RENDER_API_KEY", false], ["RENDER_OWNER_ID", true]]);
  const region = provider.settings.find((s) => s.key === "region");
  assert.equal(region.default, "oregon");
  assert.ok(region.options.includes("frankfurt"));
  assert.match(provider.notes, /sleep/);
  const registry = new ProviderRegistry().register(provider);
  assert.doesNotThrow(() => validateDeploySettings({ environments: { prod: { api: { provider: "render", settings: { region: "virginia", plan: "free" } } } } }, registry));
  assert.throws(() => validateDeploySettings({ environments: { prod: { database: { provider: "render" } } } }, registry), /does not support/);
});

test("plan on a missing service: GET only, create + deploy actions, no state", async () => {
  const { fetch, calls } = fakeFetch({ [`GET ${API}/services`]: { body: [] } });
  const plan = await provider.plan(context("api", fetch));
  assert.deepEqual(plan.actions.map((a) => a.action), ["create", "deploy"]);
  assert.equal(plan.actions[0].resource, "shop-stage-api");
  assert.deepEqual(plan.state, {});
  assert.equal(calls.length, 1);
  assert.ok(calls.every((c) => c.method === "GET"));
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/v1/services");
  assert.equal(url.searchParams.get("name"), "shop-stage-api");
  assert.equal(url.searchParams.get("type"), "web_service");
  assert.equal(url.searchParams.get("ownerId"), null);
  assert.equal(calls[0].headers.authorization, `Bearer ${KEY}`);
});

test("plan on an existing service: update + deploy, id in state, owner filter applied", async () => {
  const { fetch, calls } = fakeFetch({
    [`GET ${API}/services`]: { body: [{ cursor: "c", service: service("srv-other", "shop-stage-api-old") }, { cursor: "d", service: service("srv-1", "shop-stage-api") }] },
  });
  const plan = await provider.plan(context("api", fetch, { credentials: { ...credentials, RENDER_OWNER_ID: "tea-1" } }));
  assert.deepEqual(plan.actions.map((a) => a.action), ["update", "deploy"]);
  assert.deepEqual(plan.state, { serviceId: "srv-1" });
  assert.equal(new URL(calls[0].url).searchParams.get("ownerId"), "tea-1");
  assert.ok(calls.every((c) => c.method === "GET"));
});

test("apply creates a web service with env vars, commands, region and plan (single workspace)", async () => {
  const { fetch, calls } = fakeFetch({
    [`GET ${API}/services`]: { body: [] },
    [`GET ${API}/owners`]: { body: [{ cursor: "x", owner: { id: "usr-1", name: "me", type: "user" } }] },
    [`POST ${API}/services`]: (call) => ({ status: 201, body: { service: service("srv-new", call.body.name), deployId: "dep-1" } }),
  });
  const ctx = context("api", fetch, { settings: { region: "frankfurt", plan: "free", healthCheckPath: "/health" }, source: { repository: "acme/shop", branch: "main", directory: "apps/server", runtime: "node", buildCommand: "npm ci", startCommand: "node dist/server.js" } });
  const plan = await provider.plan(ctx);
  const result = await provider.apply(ctx, plan);
  assert.deepEqual(result, { provider: "render", role: "api", url: "https://shop-stage-api.onrender.com", resources: [{ kind: "web_service", id: "srv-new", name: "shop-stage-api" }] });
  const create = calls.find((c) => c.method === "POST");
  assert.equal(create.url, `${API}/services`);
  assert.equal(create.headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(create.body, {
    type: "web_service",
    name: "shop-stage-api",
    ownerId: "usr-1",
    repo: "https://github.com/acme/shop",
    branch: "main",
    autoDeploy: "no",
    rootDir: "apps/server",
    envVars: [{ key: "DATABASE_URL", value: "postgres://u:p@h/db" }, { key: "JWT_SECRET", value: "jwt-value" }],
    serviceDetails: { runtime: "node", plan: "free", region: "frankfurt", healthCheckPath: "/health", envSpecificDetails: { buildCommand: "npm ci", startCommand: "node dist/server.js" } },
  });
  assert.equal(calls.filter((c) => c.url.includes("/deploys")).length, 0, "creation already starts the first deploy");
});

test("apply update path is idempotent: PATCH service, PUT env vars, POST deploy on every re-run", async () => {
  const { fetch, calls } = fakeFetch({
    [`GET ${API}/services`]: { body: [{ service: service("srv-1", "shop-stage-ssr") }] },
    [`PATCH ${API}/services/srv-1`]: (call) => ({ body: service("srv-1", "shop-stage-ssr") }),
    [`PUT ${API}/services/srv-1/env-vars`]: (call) => ({ body: call.body.map((envVar) => ({ envVar, cursor: "c" })) }),
    [`POST ${API}/services/srv-1/deploys`]: { status: 201, body: { id: "dep-2", status: "created" } },
  });
  const ctx = context("ssr", fetch, { source: { repository: "acme/shop", branch: "stage", directory: "./apps/ssr/", runtime: "static" } });
  for (let run = 0; run < 2; run++) {
    const plan = await provider.plan(ctx);
    const result = await provider.apply(ctx, plan);
    assert.equal(result.resources[0].id, "srv-1");
  }
  const writes = calls.filter((c) => c.method !== "GET");
  assert.deepEqual(writes.map((c) => `${c.method} ${c.url}`), [
    `PATCH ${API}/services/srv-1`, `PUT ${API}/services/srv-1/env-vars`, `POST ${API}/services/srv-1/deploys`,
    `PATCH ${API}/services/srv-1`, `PUT ${API}/services/srv-1/env-vars`, `POST ${API}/services/srv-1/deploys`,
  ]);
  const patch = writes[0].body;
  assert.equal(patch.rootDir, "apps/ssr");
  assert.equal(patch.serviceDetails.runtime, "node", "ssr always runs on node");
  assert.equal(patch.serviceDetails.region, undefined, "region cannot be changed after creation");
  assert.deepEqual(patch.serviceDetails.envSpecificDetails, { buildCommand: "npm install && npm run build --if-present", startCommand: "npm start" });
  assert.deepEqual(writes[1].body, [{ key: "DATABASE_URL", value: "postgres://u:p@h/db" }, { key: "JWT_SECRET", value: "jwt-value" }]);
  assert.deepEqual(writes[2].body, { clearCache: "do_not_clear" });
});

test("apply uses the plan state and never creates a duplicate", async () => {
  const { fetch, calls } = fakeFetch({
    [`PATCH ${API}/services/srv-9`]: { body: service("srv-9", "shop-stage-api") },
    [`PUT ${API}/services/srv-9/env-vars`]: { body: [] },
    [`POST ${API}/services/srv-9/deploys`]: { status: 202, body: "" },
  });
  const plan = { provider: "render", role: "api", environment: "stage", actions: [], state: { serviceId: "srv-9" } };
  const result = await provider.apply(context("api", fetch, { variables: {} }), plan);
  assert.equal(result.url, "https://shop-stage-api.onrender.com");
  assert.equal(calls.some((c) => c.method === "POST" && c.url === `${API}/services`), false);
});

test("frontend becomes a static site with build command and publish path", async () => {
  const { fetch, calls } = fakeFetch({
    [`GET ${API}/services`]: { body: [] },
    [`POST ${API}/services`]: (call) => ({ status: 201, body: { service: service("srv-web", call.body.name, "static_site") } }),
  });
  const ctx = context("frontend", fetch, { credentials: { ...credentials, RENDER_OWNER_ID: "tea-9" }, source: { repository: "acme/shop", branch: "main", directory: ".", buildCommand: "npm run build:web", outputDirectory: "build" } });
  const plan = await provider.plan(ctx);
  assert.equal(new URL(calls[0].url).searchParams.get("type"), "static_site");
  const result = await provider.apply(ctx, plan);
  assert.equal(result.resources[0].kind, "static_site");
  const body = calls.find((c) => c.method === "POST").body;
  assert.equal(body.type, "static_site");
  assert.equal(body.ownerId, "tea-9");
  assert.equal(body.rootDir, "");
  assert.deepEqual(body.serviceDetails, { buildCommand: "npm run build:web", publishPath: "build" });
  assert.equal(calls.some((c) => c.url.includes("/owners")), false, "owner id from credentials");
});

test("frontend defaults, python and go runtimes", async () => {
  const bodies = [];
  const { fetch } = fakeFetch({
    [`GET ${API}/services`]: { body: [] },
    [`GET ${API}/owners`]: { body: [{ owner: { id: "usr-1" } }] },
    [`POST ${API}/services`]: (call) => (bodies.push(call.body), { status: 201, body: { service: service("s", call.body.name) } }),
  });
  const plan = { provider: "render", actions: [], state: {} };
  await provider.apply(context("frontend", fetch, { source: { repository: "acme/shop", branch: "main", directory: "apps/web" } }), plan);
  await provider.apply(context("api", fetch, { source: { repository: "acme/shop", branch: "main", directory: "api", runtime: "python" } }), plan);
  await provider.apply(context("api", fetch, { source: { repository: "acme/shop", branch: "main", directory: "api", runtime: "go" } }), plan);
  await provider.apply(context("api", fetch, { source: { repository: "acme/shop", branch: "main", directory: "api" } }), plan);
  assert.deepEqual(bodies[0].serviceDetails, { buildCommand: "npm install && npm run build", publishPath: "dist" });
  assert.equal(bodies[1].serviceDetails.runtime, "python");
  assert.equal(bodies[1].serviceDetails.envSpecificDetails.buildCommand, "pip install -r requirements.txt");
  assert.equal(bodies[2].serviceDetails.runtime, "go");
  assert.equal(bodies[3].serviceDetails.runtime, "node");
  assert.equal(bodies[3].serviceDetails.plan, "starter");
  assert.equal(bodies[3].serviceDetails.region, "oregon");
});

test("apply rejects invalid input before any write", async () => {
  const { fetch, calls } = fakeFetch({ [`GET ${API}/services`]: { body: [] }, [`GET ${API}/owners`]: { body: [{ owner: { id: "a" } }, { owner: { id: "b" } }] } });
  const plan = { provider: "render", actions: [], state: {} };
  await assert.rejects(provider.apply(context("api", fetch, { source: { branch: "main", directory: "." } }), plan), /owner\/name/);
  await assert.rejects(provider.apply(context("api", fetch, { source: { repository: "https://github.com/acme/shop", branch: "main", directory: "." } }), plan), /owner\/name/);
  await assert.rejects(provider.apply(context("api", fetch, { source: { repository: "acme/shop", branch: "main", directory: ".", runtime: "static" } }), { ...plan, state: { serviceId: "srv-1" } }), /unsupported runtime "static"/);
  await assert.rejects(provider.apply(context("api", fetch), plan), /can access 2 workspaces; set RENDER_OWNER_ID/);
  assert.ok(calls.every((c) => c.method === "GET"));
  await assert.rejects(provider.plan(context("api", fetch, { credentials: {} })), /RENDER_API_KEY is required/);
});

test("unsupported roles are rejected by plan, apply and status", async () => {
  const { fetch, calls } = fakeFetch({});
  for (const role of ["database", "files"]) {
    await assert.rejects(provider.plan(context(role, fetch)), /Render does not support the .* role/);
    await assert.rejects(provider.apply(context(role, fetch), { state: {} }), /does not support/);
    await assert.rejects(provider.status(context(role, fetch)), /does not support/);
  }
  assert.equal(calls.length, 0);
});

test("status maps every Render deploy status", async () => {
  const cases = {
    live: "live",
    created: "deploying",
    queued: "deploying",
    build_in_progress: "deploying",
    update_in_progress: "deploying",
    pre_deploy_in_progress: "deploying",
    build_failed: "failed",
    update_failed: "failed",
    pre_deploy_failed: "failed",
    canceled: "failed",
    deactivated: "unknown",
  };
  for (const [remote, state] of Object.entries(cases)) {
    const { fetch, calls } = fakeFetch({
      [`GET ${API}/services`]: { body: [{ service: service("srv-1", "shop-stage-api") }] },
      [`GET ${API}/services/srv-1/deploys`]: { body: [{ cursor: "c", deploy: { id: "d", status: remote } }] },
    });
    const result = await provider.status(context("api", fetch));
    assert.equal(result.state, state, remote);
    assert.equal(result.url, "https://shop-stage-api.onrender.com");
    assert.equal(calls[1].url, `${API}/services/srv-1/deploys?limit=1`);
  }
});

test("status: missing, suspended and no deploys", async () => {
  let { fetch } = fakeFetch({ [`GET ${API}/services`]: { body: [] } });
  assert.deepEqual(await provider.status(context("api", fetch)), { state: "missing" });
  ({ fetch } = fakeFetch({ [`GET ${API}/services`]: { body: [{ service: service("srv-1", "shop-stage-api", "web_service", { suspended: "suspended" }) }] } }));
  assert.equal((await provider.status(context("api", fetch))).detail, "service is suspended");
  ({ fetch } = fakeFetch({ [`GET ${API}/services`]: { body: [{ service: service("srv-1", "shop-stage-api") }] }, [`GET ${API}/services/srv-1/deploys`]: { body: [] } }));
  assert.deepEqual(await provider.status(context("api", fetch)), { state: "unknown", url: "https://shop-stage-api.onrender.com", detail: "no deploys yet" });
});

test("provider errors surface with secrets redacted", async () => {
  const { fetch } = fakeFetch({
    [`GET ${API}/services`]: { body: [] },
    [`POST ${API}/services`]: { status: 400, body: { message: `invalid envVars: JWT ${KEY} owner tea-secret-owner` } },
  });
  const ctx = context("api", fetch, { credentials: { ...credentials, RENDER_OWNER_ID: "tea-secret-owner" } });
  await assert.rejects(provider.apply(ctx, await provider.plan(ctx)), (error) => {
    assert.equal(error.status, 400);
    assert.match(error.message, /^Render: POST \/services → 400/);
    assert.ok(!error.message.includes(KEY));
    assert.ok(error.message.includes("[redacted]"));
    return true;
  });
});
