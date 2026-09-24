import test from "node:test";
import assert from "node:assert/strict";
import railwayDefault, { provider, QUERIES, mapDeploymentStatus, railwayNames } from "@gsalgadotoledo/rt-app-deploy-railway";
import { ProviderRegistry, ProviderError } from "@gsalgadotoledo/rt-app-deploy";
import { fakeFetch, testContext } from "@gsalgadotoledo/rt-app-deploy/testing";

const ENDPOINT = "https://backboard.railway.com/graphql/v2";
const TOKEN = "rw_token_abcdef123456";
const MUTATIONS = new Set([
  "projectCreate",
  "environmentCreate",
  "serviceCreate",
  "serviceInstanceUpdate",
  "volumeCreate",
  "variableCollectionUpsert",
  "serviceDomainCreate",
  "serviceInstanceDeployV2",
]);

/** In-memory Railway: answers the documented operations and records {op, variables}. */
function railway(initial = {}) {
  const state = {
    projects: [],
    services: [],
    environments: [],
    domains: [],
    variables: {},
    deployments: {},
    errors: {},
    ...initial,
  };
  const ops = [];
  let seq = 0;
  const id = (prefix) => `${prefix}-${++seq}`;
  const edges = (list) => ({ edges: list.map((node) => ({ node })) });

  const resolvers = {
    projects: (v) => ({ projects: edges(state.projects.filter((p) => !v.workspaceId || p.workspaceId === v.workspaceId)) }),
    workspaceProjects: (v) => resolvers.projects(v),
    project: (v) => ({
      project: {
        ...state.projects.find((p) => p.id === v.id),
        services: edges(state.services.filter((s) => s.projectId === v.id).map(({ id, name }) => ({ id, name }))),
        environments: edges(state.environments.filter((e) => e.projectId === v.id).map(({ id, name }) => ({ id, name }))),
      },
    }),
    serviceInstance: (v) => ({
      serviceInstance: { id: "si-" + v.serviceId, rootDirectory: null, latestDeployment: state.deployments[v.serviceId] ?? null },
    }),
    domains: (v) => ({ domains: { serviceDomains: state.domains.filter((d) => d.serviceId === v.serviceId) } }),
    variables: (v) => ({ variables: state.variables[v.serviceId] ?? {} }),
    projectCreate: ({ input }) => {
      const project = { id: id("prj"), name: input.name, workspaceId: input.workspaceId };
      state.projects.push(project);
      state.environments.push({ id: id("env"), name: input.defaultEnvironmentName ?? "production", projectId: project.id });
      return { projectCreate: { id: project.id, name: project.name } };
    },
    environmentCreate: ({ input }) => {
      const environment = { id: id("env"), name: input.name, projectId: input.projectId };
      state.environments.push(environment);
      return { environmentCreate: { id: environment.id, name: environment.name } };
    },
    serviceCreate: ({ input }) => {
      const service = { id: id("svc"), name: input.name, projectId: input.projectId };
      state.services.push(service);
      return { serviceCreate: { id: service.id, name: service.name } };
    },
    serviceInstanceUpdate: () => ({ serviceInstanceUpdate: true }),
    volumeCreate: () => ({ volumeCreate: { id: id("vol"), name: "pg-volume" } }),
    variableCollectionUpsert: ({ input }) => {
      const rendered = { ...input.variables };
      if (rendered.DATABASE_URL?.includes("${{"))
        rendered.DATABASE_URL = `postgresql://postgres:${rendered.POSTGRES_PASSWORD}@svc.railway.internal:5432/railway`;
      state.variables[input.serviceId] = { ...state.variables[input.serviceId], ...rendered };
      return { variableCollectionUpsert: true };
    },
    serviceDomainCreate: ({ input }) => {
      const domain = { id: id("dom"), domain: `shop-${input.serviceId}.up.railway.app`, serviceId: input.serviceId };
      state.domains.push(domain);
      return { serviceDomainCreate: { id: domain.id, domain: domain.domain } };
    },
    serviceInstanceDeployV2: (v) => {
      state.deployments[v.serviceId] = { id: "dep-1", status: "BUILDING" };
      return { serviceInstanceDeployV2: "dep-1" };
    },
  };

  const { fetch, calls } = fakeFetch({
    [`POST ${ENDPOINT}`]: (call) => {
      const op = /^(?:query|mutation)\s+(\w+)/.exec(call.body.query)[1];
      const known = Object.entries(QUERIES).find(([, q]) => q === call.body.query)?.[0];
      assert.equal(known, op, "operation text must be one of the documented QUERIES");
      ops.push({ op, variables: call.body.variables });
      if (state.errors[op]) return state.errors[op];
      return { body: { data: resolvers[op](call.body.variables) } };
    },
  });
  return { state, ops, fetch, calls, writes: () => ops.filter((o) => MUTATIONS.has(o.op)) };
}

function context(fake, overrides = {}) {
  return testContext({
    role: "api",
    fetch: fake.fetch,
    credentials: { RAILWAY_API_TOKEN: TOKEN },
    variables: { JWT_SECRET: "jwt-super-secret-value", NODE_ENV: "production" },
    ...overrides,
  });
}

test("provider metadata registers and declares credentials, settings and roles", () => {
  assert.equal(railwayDefault, provider);
  const registry = new ProviderRegistry().register(provider);
  const [entry] = registry.catalog();
  assert.equal(entry.id, "railway");
  assert.deepEqual(entry.roles, ["api", "ssr", "database"]);
  assert.deepEqual(entry.credentials.map((c) => [c.key, !!c.optional]), [["RAILWAY_API_TOKEN", false], ["RAILWAY_WORKSPACE_ID", true]]);
  assert.deepEqual(provider.settings.find((s) => s.key === "region").options, ["us-west2", "us-east4-eqdc4a", "europe-west4-drams3a", "asia-southeast1-eqsg3a"]);
  assert.deepEqual(railwayNames(testContext({ role: "ssr", app: "My Shop" })), { project: "my-shop-stage", environment: "stage", service: "my-shop-stage-ssr" });
});

test("plan on an empty account creates everything and performs no writes", async () => {
  const fake = railway();
  const plan = await provider.plan(context(fake));
  assert.deepEqual(fake.writes(), []);
  assert.deepEqual(fake.ops.map((o) => o.op), ["projects"]);
  assert.deepEqual(plan.actions.map((a) => [a.action, a.resource]), [
    ["create", "project shop-stage"],
    ["create", "service shop-stage-api"],
    ["update", "variables"],
    ["create", "domain"],
    ["deploy", "service shop-stage-api"],
  ]);
  assert.equal(plan.actions[2].detail, "JWT_SECRET, NODE_ENV", "plans list variable names, never values");
  assert.equal(JSON.stringify(plan).includes("jwt-super-secret-value"), false);
  assert.deepEqual(plan.state, {});
  assert.equal(fake.calls[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(fake.calls[0].headers["content-type"], "application/json");
});

test("apply creates project, service, variables, domain and deployment with exact inputs", async () => {
  const fake = railway();
  const logs = [];
  const ctx = context(fake, {
    settings: { region: "europe-west4-drams3a", healthcheckPath: "/health", port: 8080 },
    source: { repository: "acme/shop", branch: "stage", directory: "apps/server", buildCommand: "npm run build", startCommand: "npm start" },
    log: (m) => logs.push(m),
  });
  const result = await provider.apply(ctx, await provider.plan(ctx));
  const writes = fake.writes();
  assert.deepEqual(writes, [
    { op: "projectCreate", variables: { input: { name: "shop-stage", defaultEnvironmentName: "stage" } } },
    { op: "serviceCreate", variables: { input: { projectId: "prj-1", name: "shop-stage-api", source: { repo: "acme/shop" }, branch: "stage" } } },
    {
      op: "serviceInstanceUpdate",
      variables: {
        serviceId: "svc-3",
        environmentId: "env-2",
        input: { rootDirectory: "apps/server", buildCommand: "npm run build", startCommand: "npm start", healthcheckPath: "/health", region: "europe-west4-drams3a" },
      },
    },
    {
      op: "variableCollectionUpsert",
      variables: { input: { projectId: "prj-1", environmentId: "env-2", serviceId: "svc-3", variables: { JWT_SECRET: "jwt-super-secret-value", NODE_ENV: "production" }, skipDeploys: true } },
    },
    { op: "serviceDomainCreate", variables: { input: { serviceId: "svc-3", environmentId: "env-2", targetPort: 8080 } } },
    { op: "serviceInstanceDeployV2", variables: { serviceId: "svc-3", environmentId: "env-2" } },
  ]);
  assert.deepEqual(result, {
    provider: "railway",
    role: "api",
    url: "https://shop-svc-3.up.railway.app",
    resources: [
      { kind: "project", id: "prj-1", name: "shop-stage" },
      { kind: "environment", id: "env-2", name: "stage" },
      { kind: "service", id: "svc-3", name: "shop-stage-api" },
      { kind: "domain", id: "dom-4", name: "shop-svc-3.up.railway.app" },
      { kind: "deployment", id: "dep-1", name: "shop-stage-api" },
    ],
  });
  assert.equal(logs.join("\n").includes("jwt-super-secret-value"), false, "logs never contain values");
  assert.match(logs.join("\n"), /set 2 variables \(JWT_SECRET, NODE_ENV\)/);
});

test("re-running apply is idempotent: finds by name, updates settings and variables, keeps the domain", async () => {
  const fake = railway();
  const ctx = context(fake);
  await provider.apply(ctx, await provider.plan(ctx));
  fake.ops.length = 0;

  const plan = await provider.plan(ctx);
  assert.deepEqual(plan.actions.map((a) => [a.action, a.resource]), [
    ["update", "service shop-stage-api"],
    ["update", "variables"],
    ["deploy", "service shop-stage-api"],
  ]);
  assert.deepEqual(plan.state, { projectId: "prj-1", environmentId: "env-2", serviceId: "svc-3", deploymentStatus: "BUILDING", domain: "shop-svc-3.up.railway.app" });
  fake.ops.length = 0;

  const result = await provider.apply(ctx, plan);
  assert.deepEqual(fake.writes().map((w) => w.op), ["serviceInstanceUpdate", "variableCollectionUpsert", "serviceInstanceDeployV2"]);
  assert.equal(result.url, "https://shop-svc-3.up.railway.app");
  assert.equal(fake.state.projects.length, 1);
  assert.equal(fake.state.services.length, 1);
  assert.equal(fake.state.domains.length, 1);
});

test("apply without plan state discovers; a missing environment is created in the existing project", async () => {
  const fake = railway({
    projects: [{ id: "prj-9", name: "shop-stage", workspaceId: "ws-1" }],
    environments: [{ id: "env-p", name: "production", projectId: "prj-9" }],
  });
  const ctx = context(fake, { role: "ssr", variables: {}, credentials: { RAILWAY_API_TOKEN: TOKEN, RAILWAY_WORKSPACE_ID: "ws-1" } });
  const plan = await provider.plan(ctx);
  assert.deepEqual(plan.actions[0], { action: "create", resource: "environment stage", detail: "in project shop-stage" });
  assert.equal(plan.actions.some((a) => a.resource === "variables"), false, "no variables → no upsert");
  assert.deepEqual(fake.ops[0], { op: "workspaceProjects", variables: { workspaceId: "ws-1" } });

  const result = await provider.apply(ctx, { provider: "other", role: "ssr", environment: "stage", actions: [] });
  const writes = fake.writes();
  assert.deepEqual(writes[0], { op: "environmentCreate", variables: { input: { projectId: "prj-9", name: "stage" } } });
  assert.deepEqual(writes.map((w) => w.op), ["environmentCreate", "serviceCreate", "serviceInstanceUpdate", "serviceDomainCreate", "serviceInstanceDeployV2"]);
  assert.deepEqual(writes[2].variables.input, { rootDirectory: "apps/server" });
  assert.deepEqual(writes[3].variables.input, { serviceId: "svc-2", environmentId: "env-1" });
  assert.equal(result.role, "ssr");
});

test("projects are created in the configured workspace", async () => {
  const fake = railway();
  const ctx = context(fake, { credentials: { RAILWAY_API_TOKEN: TOKEN, RAILWAY_WORKSPACE_ID: "ws-7" } });
  await provider.apply(ctx, await provider.plan(ctx));
  assert.deepEqual(fake.writes()[0].variables.input, { name: "shop-stage", defaultEnvironmentName: "stage", workspaceId: "ws-7" });
});

test("database: Postgres image, volume, generated credentials, deploy and DATABASE_URL output", async () => {
  const fake = railway();
  const logs = [];
  const ctx = context(fake, { role: "database", settings: { postgresVersion: "16", region: "us-west2" }, log: (m) => logs.push(m) });
  const plan = await provider.plan(ctx);
  assert.deepEqual(plan.actions.map((a) => [a.action, a.resource]), [
    ["create", "project shop-stage"],
    ["create", "service shop-stage-database"],
    ["deploy", "service shop-stage-database"],
  ]);
  assert.match(plan.actions[1].detail, /postgres-ssl:16 with a volume at \/var\/lib\/postgresql\/data/);

  const result = await provider.apply(ctx, plan);
  const writes = fake.writes();
  assert.deepEqual(writes.map((w) => w.op), ["projectCreate", "serviceCreate", "volumeCreate", "variableCollectionUpsert", "serviceInstanceUpdate", "serviceInstanceDeployV2"]);
  assert.deepEqual(writes[1].variables.input, { projectId: "prj-1", name: "shop-stage-database", source: { image: "ghcr.io/railwayapp-templates/postgres-ssl:16" } });
  assert.deepEqual(writes[2].variables.input, { projectId: "prj-1", environmentId: "env-2", serviceId: "svc-3", mountPath: "/var/lib/postgresql/data" });
  const vars = writes[3].variables.input.variables;
  assert.match(vars.POSTGRES_PASSWORD, /^[0-9a-f]{48}$/);
  assert.equal(vars.PGDATA, "/var/lib/postgresql/data/pgdata");
  assert.equal(vars.DATABASE_URL, "postgresql://${{PGUSER}}:${{POSTGRES_PASSWORD}}@${{RAILWAY_PRIVATE_DOMAIN}}:5432/${{PGDATABASE}}");
  assert.equal(writes[3].variables.input.skipDeploys, true);
  assert.deepEqual(writes[4].variables.input, { region: "us-west2" }, "app settings (root directory) are not sent for the database");
  assert.equal(JSON.stringify(writes).includes("jwt-super-secret-value"), false, "app variables are not copied to the database");
  assert.deepEqual(fake.ops.at(-1), { op: "variables", variables: { projectId: "prj-1", environmentId: "env-2", serviceId: "svc-3" } });
  assert.deepEqual(result.outputs, { DATABASE_URL: `postgresql://postgres:${vars.POSTGRES_PASSWORD}@svc.railway.internal:5432/railway` });
  assert.deepEqual(result.resources.map((r) => r.kind), ["project", "environment", "service", "volume", "deployment"]);
  assert.equal(result.url, undefined);
  assert.equal(logs.join("\n").includes(vars.POSTGRES_PASSWORD), false);
});

test("database re-run never rotates credentials and returns the public URL when enabled", async () => {
  const fake = railway();
  const ctx = context(fake, { role: "database" });
  const first = await provider.apply(ctx, await provider.plan(ctx));
  fake.ops.length = 0;
  fake.state.variables["svc-3"].DATABASE_PUBLIC_URL = "postgresql://postgres:x@shuttle.proxy.rlwy.net:15140/railway";

  const plan = await provider.plan(ctx);
  assert.deepEqual(plan.actions, [{ action: "noop", resource: "service shop-stage-database", detail: "Postgres already provisioned" }]);
  const second = await provider.apply(ctx, plan);
  assert.deepEqual(fake.writes(), []);
  assert.equal(second.outputs.DATABASE_URL, first.outputs.DATABASE_URL);
  assert.equal(second.outputs.DATABASE_PUBLIC_URL, "postgresql://postgres:x@shuttle.proxy.rlwy.net:15140/railway");
  assert.deepEqual(second.resources.map((r) => r.kind), ["project", "environment", "service"]);
});

test("database without DATABASE_URL fails clearly", async () => {
  const fake = railway({
    projects: [{ id: "p", name: "shop-stage" }],
    environments: [{ id: "e", name: "stage", projectId: "p" }],
    services: [{ id: "s", name: "shop-stage-database", projectId: "p" }],
  });
  const ctx = context(fake, { role: "database" });
  await assert.rejects(provider.apply(ctx, await provider.plan(ctx)), (e) => e instanceof ProviderError && /has no DATABASE_URL/.test(e.message));
});

test("GraphQL errors (HTTP 200) and HTTP 400 become redacted ProviderErrors", async () => {
  const fake = railway();
  fake.state.errors.projectCreate = {
    body: { data: null, errors: [{ message: `Not Authorized for ${TOKEN} jwt-super-secret-value`, extensions: { code: "INTERNAL_SERVER_ERROR" } }] },
  };
  const ctx = context(fake);
  await assert.rejects(provider.apply(ctx, await provider.plan(ctx)), (e) => {
    assert.ok(e instanceof ProviderError);
    assert.equal(e.status, 200);
    assert.match(e.message, /^Railway: projectCreate failed: INTERNAL_SERVER_ERROR Not Authorized for \[redacted\] \[redacted\]$/);
    return true;
  });

  const bad = railway();
  bad.state.errors.projects = { status: 400, body: { errors: [{ message: `bad ${TOKEN}`, extensions: { code: "BAD_USER_INPUT" } }] } };
  await assert.rejects(provider.plan(context(bad)), (e) => e instanceof ProviderError && e.status === 400 && !e.message.includes(TOKEN));

  const plain = railway();
  plain.state.errors.projects = { body: { errors: [{}] } };
  await assert.rejects(provider.plan(context(plain)), /projects failed: $/);

  const empty = railway();
  empty.state.errors.projects = { body: {} };
  await assert.rejects(provider.plan(context(empty)), /projects returned no data/);
});

test("generated database password is redacted from later errors", async () => {
  const fake = railway();
  let password;
  fake.state.errors.serviceInstanceDeployV2 = undefined;
  const original = fake.fetch;
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.variables?.input?.variables?.POSTGRES_PASSWORD) password = body.variables.input.variables.POSTGRES_PASSWORD;
    if (body.query.startsWith("mutation serviceInstanceDeployV2"))
      return new Response(JSON.stringify({ errors: [{ message: "boom " + password }] }), { status: 200 });
    return original(url, init);
  };
  await assert.rejects(provider.apply(context(fake, { role: "database", fetch }), { provider: "x", role: "database", environment: "stage", actions: [] }), (e) => {
    assert.ok(password && !e.message.includes(password));
    assert.match(e.message, /boom \[redacted\]/);
    return true;
  });
});

test("missing token, missing repository and unsupported roles fail before any request", async () => {
  const fake = railway();
  await assert.rejects(provider.plan(context(fake, { credentials: {} })), /RAILWAY_API_TOKEN is required/);
  await assert.rejects(provider.plan(context(fake, { source: { branch: "main", directory: "apps/api" } })), /source.repository/);
  await assert.rejects(provider.apply(context(fake, { source: { branch: "main", directory: "apps/api" } }), { provider: "railway", role: "api", environment: "stage", actions: [], state: {} }), /source.repository/);
  for (const role of ["frontend", "files"]) {
    await assert.rejects(provider.plan(context(fake, { role })), /does not support the/);
    await assert.rejects(provider.apply(context(fake, { role }), { provider: "railway", role, environment: "stage", actions: [] }), /does not support/);
    await assert.rejects(provider.status(context(fake, { role })), /does not support/);
  }
  assert.equal(fake.calls.length, 0);
});

test("status: missing, deploying, live, failed and unknown from the latest deployment", async () => {
  const empty = railway();
  assert.deepEqual(await provider.status(context(empty)), { state: "missing" });

  const fake = railway();
  const ctx = context(fake);
  await provider.apply(ctx, await provider.plan(ctx));
  assert.deepEqual(await provider.status(ctx), { state: "deploying", detail: "Latest deployment BUILDING", url: "https://shop-svc-3.up.railway.app" });
  fake.state.deployments["svc-3"] = { id: "dep-1", status: "CRASHED" };
  assert.equal((await provider.status(ctx)).state, "failed");
  delete fake.state.deployments["svc-3"];
  assert.deepEqual(await provider.status(ctx), { state: "unknown", detail: "No deployments yet", url: "https://shop-svc-3.up.railway.app" });

  const db = railway({
    projects: [{ id: "p", name: "shop-stage" }],
    environments: [{ id: "e", name: "stage", projectId: "p" }],
    services: [{ id: "s", name: "shop-stage-database", projectId: "p" }],
    deployments: { s: { id: "d", status: "SUCCESS" } },
  });
  assert.deepEqual(await provider.status(context(db, { role: "database" })), { state: "live", detail: "Latest deployment SUCCESS" });
  assert.equal(db.ops.some((o) => o.op === "domains"), false, "databases have no public domain");
  assert.deepEqual(db.writes(), []);

  const expected = {
    SUCCESS: "live",
    SLEEPING: "live",
    BUILDING: "deploying",
    DEPLOYING: "deploying",
    INITIALIZING: "deploying",
    QUEUED: "deploying",
    WAITING: "deploying",
    FAILED: "failed",
    CRASHED: "failed",
    REMOVED: "unknown",
    SKIPPED: "unknown",
  };
  for (const [status, state] of Object.entries(expected)) assert.equal(mapDeploymentStatus(status), state, status);
  assert.equal(mapDeploymentStatus(undefined), "unknown");
});
