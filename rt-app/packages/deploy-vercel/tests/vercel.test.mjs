import test from "node:test";
import assert from "node:assert/strict";
import provider, { provider as named, envTarget, mapReadyState, VERCEL_REGIONS } from "@gsalgadotoledo/rt-app-deploy-vercel";
import { ProviderRegistry, ProviderError } from "@gsalgadotoledo/rt-app-deploy";
import { fakeFetch, testContext } from "@gsalgadotoledo/rt-app-deploy/testing";

const API = "https://api.vercel.com";
const TOKEN = "vc_token_secret_123";

function context(fetch, overrides = {}) {
  return testContext({
    role: "ssr",
    fetch,
    credentials: { VERCEL_TOKEN: TOKEN },
    source: { repository: "acme/shop", branch: "stage", directory: "apps/ssr" },
    variables: { DATABASE_URL: "postgres://u:dbpass_secret@h/db", JWT_SECRET: "jwt_secret_value" },
    ...overrides,
  });
}

function routes(existing, extra = {}) {
  return {
    [`GET ${API}/v9/projects/`]: existing ? { body: { id: "prj_1", name: "shop-stage-ssr" } } : { status: 404, body: { error: { code: "not_found" } } },
    [`POST ${API}/v11/projects`]: { body: { id: "prj_new", name: "shop-stage-ssr" } },
    [`PATCH ${API}/v9/projects/`]: { body: { id: "prj_1" } },
    [`POST ${API}/v10/projects/`]: { status: 201, body: { created: [], failed: [] } },
    [`POST ${API}/v13/deployments`]: { body: { id: "dpl_1", url: "shop-abc.vercel.app", readyState: "QUEUED" } },
    ...extra,
  };
}

test("provider metadata is registrable and declares credentials and real regions", () => {
  assert.equal(named, provider);
  new ProviderRegistry().register(provider);
  assert.equal(provider.id, "vercel");
  assert.deepEqual(provider.roles, ["ssr", "frontend"]);
  assert.deepEqual(provider.credentials.map((c) => [c.key, !!c.optional]), [["VERCEL_TOKEN", false], ["VERCEL_TEAM_ID", true]]);
  const region = provider.settings.find((s) => s.key === "functionRegion");
  assert.equal(region.default, "iad1");
  assert.ok(region.options.includes("fra1") && region.options.length === VERCEL_REGIONS.length);
});

test("plan for a missing project: GET only, create + variables + deploy", async () => {
  const { fetch, calls } = fakeFetch(routes(false));
  const plan = await provider.plan(context(fetch));
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [`GET ${API}/v9/projects/shop-stage-ssr`]);
  assert.equal(calls[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(plan.actions.map((a) => a.action), ["create", "update", "deploy"]);
  assert.match(plan.actions[1].detail, /2 encrypted variable\(s\) for preview \(branch stage\)/);
  assert.deepEqual(plan.state, {});
  assert.equal(JSON.stringify(plan).includes("dbpass_secret"), false);
});

test("plan for an existing project carries its id; no variables → no env action; teamId is appended", async () => {
  const { fetch, calls } = fakeFetch(routes(true));
  const plan = await provider.plan(context(fetch, { variables: {}, credentials: { VERCEL_TOKEN: TOKEN, VERCEL_TEAM_ID: "team_9" } }));
  assert.equal(calls[0].url, `${API}/v9/projects/shop-stage-ssr?teamId=team_9`);
  assert.ok(calls.every((c) => c.method === "GET"));
  assert.deepEqual(plan.actions.map((a) => a.action), ["update", "deploy"]);
  assert.deepEqual(plan.state, { projectId: "prj_1" });
});

test("apply creates an SSR project, sets encrypted preview variables for the branch and deploys", async () => {
  const { fetch, calls } = fakeFetch(routes(false));
  const logs = [];
  const result = await provider.apply(context(fetch, { settings: { functionRegion: "fra1" }, log: (m) => logs.push(m) }), { actions: [] });
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [
    `GET ${API}/v9/projects/shop-stage-ssr`,
    `POST ${API}/v11/projects`,
    `POST ${API}/v10/projects/prj_new/env?upsert=true`,
    `POST ${API}/v13/deployments?skipAutoDetectionConfirmation=1`,
  ]);
  const [, create, env, deploy] = calls;
  assert.deepEqual(create.body, {
    name: "shop-stage-ssr",
    framework: "nextjs",
    rootDirectory: "apps/ssr",
    serverlessFunctionRegion: "fra1",
    gitRepository: { type: "github", repo: "acme/shop" },
  });
  assert.deepEqual(env.body, [
    { key: "DATABASE_URL", value: "postgres://u:dbpass_secret@h/db", type: "encrypted", target: ["preview"], gitBranch: "stage" },
    { key: "JWT_SECRET", value: "jwt_secret_value", type: "encrypted", target: ["preview"], gitBranch: "stage" },
  ]);
  assert.deepEqual(deploy.body, {
    name: "shop-stage-ssr",
    project: "prj_new",
    gitSource: { type: "github", org: "acme", repo: "shop", ref: "stage" },
  });
  assert.ok(calls.every((c) => c.headers.authorization === `Bearer ${TOKEN}`));
  assert.equal(result.url, "https://shop-abc.vercel.app");
  assert.deepEqual(result.resources, [
    { kind: "project", id: "prj_new", name: "shop-stage-ssr" },
    { kind: "deployment", id: "dpl_1", name: "shop-stage-ssr" },
  ]);
  assert.equal(logs.join("\n").includes("secret"), false, "variable values are never logged");
});

test("apply re-run updates the existing project (no duplicate create) with teamId on every call", async () => {
  const { fetch, calls } = fakeFetch(routes(true));
  const ctx = context(fetch, { credentials: { VERCEL_TOKEN: TOKEN, VERCEL_TEAM_ID: "team_9" } });
  await provider.apply(ctx, { actions: [] });
  await provider.apply(ctx, { actions: [] });
  assert.equal(calls.filter((c) => c.url.startsWith(`${API}/v11/projects`)).length, 0);
  assert.equal(calls.filter((c) => c.method === "PATCH").length, 2);
  assert.ok(calls.every((c) => c.url.includes("teamId=team_9")));
  const patch = calls.find((c) => c.method === "PATCH");
  assert.equal(patch.url, `${API}/v9/projects/prj_1?teamId=team_9`);
  assert.equal(patch.body.framework, "nextjs");
  assert.equal(calls.find((c) => c.url.includes("/env")).url, `${API}/v10/projects/prj_1/env?upsert=true&teamId=team_9`);
});

test("frontend role: static project with output directory and build command; prod targets production", async () => {
  const { fetch, calls } = fakeFetch(routes(false));
  await provider.apply(
    context(fetch, {
      role: "frontend",
      environment: "prod",
      settings: { functionRegion: "fra1", sensitiveVariables: true },
      source: { repository: "acme/shop", branch: "main", directory: "apps/web", buildCommand: "npm run build", outputDirectory: "dist" },
      variables: { PUBLIC_API: "https://api.example" },
    }),
    { actions: [] },
  );
  const create = calls.find((c) => c.url === `${API}/v11/projects`);
  assert.deepEqual(create.body, {
    name: "shop-prod-frontend",
    framework: null,
    rootDirectory: "apps/web",
    buildCommand: "npm run build",
    outputDirectory: "dist",
    gitRepository: { type: "github", repo: "acme/shop" },
  });
  const env = calls.find((c) => c.url.includes("/env"));
  assert.deepEqual(env.body, [{ key: "PUBLIC_API", value: "https://api.example", type: "sensitive", target: ["production"] }]);
  const deploy = calls.find((c) => c.url.includes("/v13/deployments"));
  assert.equal(deploy.body.target, "production");
  assert.equal(deploy.body.gitSource.ref, "main");
});

test("frontend at the repository root without output folder sends nulls; no variables skips env call", async () => {
  const { fetch, calls } = fakeFetch(routes(false, { [`POST ${API}/v13/deployments`]: { body: { uid: "dpl_u", url: null } } }));
  const result = await provider.apply(
    context(fetch, { role: "frontend", variables: {}, source: { repository: "acme/shop", branch: "develop", directory: "." } }),
    { actions: [] },
  );
  const create = calls.find((c) => c.url === `${API}/v11/projects`);
  assert.equal(create.body.rootDirectory, null);
  assert.equal(create.body.outputDirectory, null);
  assert.equal(calls.some((c) => c.url.includes("/env")), false);
  assert.equal(result.url, undefined);
  assert.equal(result.resources[1].id, "dpl_u");
});

test("environment → Vercel target mapping", () => {
  const base = { source: { branch: "feature" } };
  assert.deepEqual(envTarget({ ...base, environment: "prod" }), { target: ["production"] });
  assert.deepEqual(envTarget({ ...base, environment: "stage" }), { target: ["preview"], gitBranch: "feature" });
  assert.deepEqual(envTarget({ ...base, environment: "develop" }), { target: ["preview"], gitBranch: "feature" });
});

test("failed environment variables raise a ProviderError naming keys only", async () => {
  const { fetch } = fakeFetch(
    routes(true, {
      [`POST ${API}/v10/projects/`]: { status: 201, body: { failed: [{ error: { code: "ENV_CONFLICT", envVarKey: "JWT_SECRET" } }, { error: { key: "X" } }, {}] } },
    }),
  );
  await assert.rejects(provider.apply(context(fetch), { actions: [] }), (e) => {
    assert.ok(e instanceof ProviderError);
    assert.match(e.message, /JWT_SECRET:ENV_CONFLICT, X:error, \?:error/);
    assert.equal(e.message.includes("jwt_secret_value"), false);
    return true;
  });
});

test("provider errors are redacted (token and variable values)", async () => {
  const { fetch } = fakeFetch(
    routes(false, { [`POST ${API}/v11/projects`]: { status: 400, body: `bad token ${TOKEN} value postgres://u:dbpass_secret@h/db` } }),
  );
  await assert.rejects(provider.apply(context(fetch), { actions: [] }), (e) => {
    assert.ok(e instanceof ProviderError && e.status === 400);
    assert.equal(e.message.includes(TOKEN), false);
    assert.equal(e.message.includes("dbpass_secret"), false);
    assert.match(e.message, /\[redacted\]/);
    return true;
  });
});

test("invalid input: unsupported role, missing token, repository not owner/name", async () => {
  const { fetch, calls } = fakeFetch(routes(false));
  for (const fn of ["plan", "apply", "status"])
    await assert.rejects(provider[fn](context(fetch, { role: "database" }), { actions: [] }), /does not support the database role/);
  await assert.rejects(provider.plan(context(fetch, { credentials: {} })), /Missing credential VERCEL_TOKEN/);
  for (const repository of [undefined, "shop", "a/b/c"])
    await assert.rejects(provider.apply(context(fetch, { source: { repository, branch: "stage", directory: "." } }), { actions: [] }), /owner\/name/);
  assert.equal(calls.length, 0);
});

test("status: missing project, no deployment, and readyState mapping per environment", async () => {
  let deployments = [];
  const { fetch, calls } = fakeFetch({
    [`GET ${API}/v9/projects/shop-stage-ssr`]: { body: { id: "prj_1" } },
    [`GET ${API}/v9/projects/shop-prod-ssr`]: { status: 404, body: {} },
    [`GET ${API}/v7/deployments`]: () => ({ body: { deployments } }),
  });
  assert.deepEqual(await provider.status(context(fetch, { environment: "prod" })), { state: "missing" });
  assert.equal((await provider.status(context(fetch))).state, "missing");
  assert.equal(calls.at(-1).url, `${API}/v7/deployments?projectId=prj_1&limit=1&branch=stage`);
  deployments = [{ readyState: "READY", url: "shop.vercel.app" }];
  assert.deepEqual(await provider.status(context(fetch)), { state: "live", url: "https://shop.vercel.app", detail: "READY" });
  const prod = fakeFetch({
    [`GET ${API}/v9/projects/shop-prod-ssr`]: { body: { id: "prj_2" } },
    [`GET ${API}/v7/deployments`]: { body: { deployments: [{ readyState: "BUILDING" }] } },
  });
  assert.equal((await provider.status(context(prod.fetch, { environment: "prod" }))).state, "deploying");
  assert.equal(prod.calls[1].url, `${API}/v7/deployments?projectId=prj_2&limit=1&target=production`);
  for (const [state, expected] of [["READY", "live"], ["QUEUED", "deploying"], ["INITIALIZING", "deploying"], ["BUILDING", "deploying"], ["ERROR", "failed"], ["CANCELED", "failed"], ["BLOCKED", "failed"], ["DELETED", "unknown"], [undefined, "unknown"]])
    assert.equal(mapReadyState(state), expected);
});
