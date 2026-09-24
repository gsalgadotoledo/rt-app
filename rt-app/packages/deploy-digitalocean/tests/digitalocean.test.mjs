import test from "node:test";
import assert from "node:assert/strict";
import provider, { provider as named } from "@gsalgadotoledo/rt-app-deploy-digitalocean";
import { ProviderRegistry, validateDeploySettings } from "@gsalgadotoledo/rt-app-deploy";
import { fakeFetch, testContext } from "@gsalgadotoledo/rt-app-deploy/testing";

const API = "https://api.digitalocean.com/v2";
const TOKEN = "dop_v1_secret_token_123";
const VARIABLES = { DATABASE_URL: "postgres://u:p@h/db", JWT_SECRET: "jwt-value" };

function context(role, fetch, overrides = {}) {
  return testContext({ role, fetch, credentials: { DIGITALOCEAN_TOKEN: TOKEN }, variables: VARIABLES, ...overrides });
}

function app(id, name, extra = {}) {
  return { id, spec: { name, region: "fra" }, live_url: `https://${name}-abc.ondigitalocean.app`, ...extra };
}

function secretEnvs(scope) {
  return Object.entries(VARIABLES).map(([key, value]) => ({ key, value, type: "SECRET", scope }));
}

test("metadata: roles, credential, regions and instance sizes", () => {
  assert.equal(named, provider);
  assert.equal(provider.id, "digitalocean");
  assert.deepEqual(provider.roles, ["api", "ssr", "frontend"]);
  assert.deepEqual(provider.credentials.map((c) => c.key), ["DIGITALOCEAN_TOKEN"]);
  const settings = Object.fromEntries(provider.settings.map((s) => [s.key, s]));
  assert.equal(settings.region.default, "nyc");
  assert.ok(settings.region.options.includes("fra"));
  assert.equal(settings.instanceSize.default, "apps-s-1vcpu-0.5gb");
  const registry = new ProviderRegistry().register(provider);
  assert.doesNotThrow(() => validateDeploySettings({ environments: { prod: { ssr: { provider: "digitalocean", settings: { region: "ams", port: 3000 } } } } }, registry));
});

test("plan on a missing app: paginated GETs only, create + deploy", async () => {
  const page1 = Array.from({ length: 200 }, (_, i) => app(`id-${i}`, `other-${i}`));
  const { fetch, calls } = fakeFetch({
    [`GET ${API}/apps?page=1`]: { body: { apps: page1, links: {}, meta: { total: 201 } } },
    [`GET ${API}/apps?page=2`]: { body: { apps: [app("id-x", "unrelated")], links: {}, meta: { total: 201 } } },
  });
  const plan = await provider.plan(context("api", fetch));
  assert.deepEqual(plan.actions.map((a) => a.action), ["create", "deploy"]);
  assert.deepEqual(plan.state, {});
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [`GET ${API}/apps?page=1&per_page=200`, `GET ${API}/apps?page=2&per_page=200`]);
  assert.equal(calls[0].headers.authorization, `Bearer ${TOKEN}`);
});

test("plan on an existing app: update + deploy, app id in state", async () => {
  const { fetch, calls } = fakeFetch({ [`GET ${API}/apps`]: { body: { apps: [app("other", "shop-stage-ssr"), app("app-1", "shop-stage-api")] } } });
  const plan = await provider.plan(context("api", fetch));
  assert.deepEqual(plan.actions.map((a) => a.action), ["update", "deploy"]);
  assert.deepEqual(plan.state, { appId: "app-1" });
  assert.ok(calls.every((c) => c.method === "GET"));
});

test("apply creates an app with a GitHub service, secret envs, port, size and ingress", async () => {
  const { fetch, calls } = fakeFetch({
    [`GET ${API}/apps`]: { body: { apps: [] } },
    [`POST ${API}/apps`]: (call) => ({ body: { app: { id: "app-new", spec: call.body.spec, default_ingress: "https://shop-stage-api-xyz.ondigitalocean.app" } } }),
  });
  const ctx = context("api", fetch, {
    settings: { region: "fra", instanceSize: "apps-s-1vcpu-1gb", port: 3000 },
    source: { repository: "acme/shop", branch: "stage", directory: "apps/server", buildCommand: "npm run build", startCommand: "node dist/main.js", runtime: "node" },
  });
  const result = await provider.apply(ctx, await provider.plan(ctx));
  assert.deepEqual(result, { provider: "digitalocean", role: "api", url: "https://shop-stage-api-xyz.ondigitalocean.app", resources: [{ kind: "app", id: "app-new", name: "shop-stage-api" }] });
  const create = calls.find((c) => c.method === "POST");
  assert.equal(create.url, `${API}/apps`);
  assert.equal(create.headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(create.body, {
    spec: {
      name: "shop-stage-api",
      region: "fra",
      services: [
        {
          name: "api",
          github: { repo: "acme/shop", branch: "stage", deploy_on_push: false },
          source_dir: "apps/server",
          build_command: "npm run build",
          envs: secretEnvs("RUN_AND_BUILD_TIME"),
          run_command: "node dist/main.js",
          http_port: 3000,
          instance_size_slug: "apps-s-1vcpu-1gb",
          instance_count: 1,
        },
      ],
      ingress: { rules: [{ component: { name: "api" }, match: { path: { prefix: "/" } } }] },
    },
  });
  assert.equal(calls.some((c) => c.url.includes("/deployments")), false, "creation starts the first deployment");
});

test("frontend becomes a static site with output_dir, SPA fallback and build-time secrets", async () => {
  const { fetch, calls } = fakeFetch({
    [`GET ${API}/apps`]: { body: { apps: [] } },
    [`POST ${API}/apps`]: (call) => ({ body: { app: { id: "app-web", spec: call.body.spec } } }),
  });
  const ctx = context("frontend", fetch, { source: { repository: "acme/shop", branch: "main", directory: ".", buildCommand: "npm run build", outputDirectory: "dist" } });
  const result = await provider.apply(ctx, await provider.plan(ctx));
  assert.equal(result.url, undefined);
  const spec = calls.find((c) => c.method === "POST").body.spec;
  assert.equal(spec.region, "nyc");
  assert.equal(spec.services, undefined);
  assert.deepEqual(spec.static_sites, [
    { name: "frontend", github: { repo: "acme/shop", branch: "main", deploy_on_push: false }, build_command: "npm run build", envs: secretEnvs("BUILD_TIME"), output_dir: "dist", catchall_document: "index.html" },
  ]);
});

test("ssr service defaults: port 8080, smallest size, no optional commands", async () => {
  const { fetch, calls } = fakeFetch({
    [`GET ${API}/apps`]: { body: {} },
    [`POST ${API}/apps`]: (call) => ({ body: { app: { id: "a", spec: call.body.spec } } }),
  });
  await provider.apply(context("ssr", fetch, { variables: {}, source: { repository: "acme/shop", branch: "main", directory: "./" } }), { state: {} });
  await provider.apply(context("frontend", fetch, { variables: {}, source: { repository: "acme/shop", branch: "main", directory: "web" } }), { state: {} });
  const [ssr, web] = calls.filter((c) => c.method === "POST").map((c) => c.body.spec);
  assert.deepEqual(ssr.services[0], { name: "ssr", github: { repo: "acme/shop", branch: "main", deploy_on_push: false }, envs: [], http_port: 8080, instance_size_slug: "apps-s-1vcpu-0.5gb", instance_count: 1 });
  assert.deepEqual(web.static_sites[0], { name: "frontend", github: { repo: "acme/shop", branch: "main", deploy_on_push: false }, source_dir: "web", envs: [], catchall_document: "index.html" });
});

test("apply update path merges the existing spec, is idempotent and forces a deployment only when none is queued", async () => {
  const existingSpec = {
    name: "shop-stage-api",
    region: "fra",
    domains: [{ domain: "api.shop.example", type: "PRIMARY" }],
    services: [{ name: "api", github: { repo: "acme/old", branch: "x" }, envs: [{ key: "OLD", value: "EV[1:abc]", type: "SECRET" }] }, { name: "sidecar", http_port: 9000 }],
    ingress: { rules: [{ component: { name: "api" }, match: { path: { prefix: "/" } } }] },
  };
  let queued = false;
  const { fetch, calls } = fakeFetch({
    [`GET ${API}/apps?`]: { body: { apps: [app("app-1", "shop-stage-api", { spec: existingSpec })] } },
    [`GET ${API}/apps/app-1`]: { body: { app: app("app-1", "shop-stage-api", { spec: existingSpec }) } },
    [`PUT ${API}/apps/app-1`]: (call) => ((queued = !queued), { body: { app: app("app-1", "shop-stage-api", { spec: call.body.spec, ...(queued ? { pending_deployment: { id: "dep-p", phase: "PENDING_BUILD" } } : {}) }) } }),
    [`POST ${API}/apps/app-1/deployments`]: { body: { deployment: { id: "dep-2", phase: "PENDING_BUILD" } } },
  });
  const ctx = context("api", fetch, { settings: { region: "sgp" }, source: { repository: "acme/shop", branch: "stage", directory: "apps/server" } });
  for (let run = 0; run < 2; run++) {
    const result = await provider.apply(ctx, await provider.plan(ctx));
    assert.equal(result.resources[0].id, "app-1");
    assert.equal(result.url, "https://shop-stage-api-abc.ondigitalocean.app");
  }
  const writes = calls.filter((c) => c.method !== "GET");
  assert.deepEqual(writes.map((c) => `${c.method} ${c.url}`), [`PUT ${API}/apps/app-1`, `PUT ${API}/apps/app-1`, `POST ${API}/apps/app-1/deployments`]);
  assert.deepEqual(writes[2].body, { force_build: true });
  const put = writes[0].body;
  assert.equal(put.update_all_source_versions, true);
  assert.equal(put.spec.region, "fra", "region of an existing app is preserved");
  assert.deepEqual(put.spec.domains, existingSpec.domains);
  assert.deepEqual(put.spec.services.map((s) => s.name), ["sidecar", "api"]);
  assert.deepEqual(put.spec.services[1].envs, secretEnvs("RUN_AND_BUILD_TIME"));
  assert.equal(put.spec.ingress.rules.length, 1, "no duplicate ingress rule");
  assert.equal(calls.some((c) => c.method === "POST" && c.url === `${API}/apps`), false);
});

test("apply without plan state finds the app by name and adds the missing ingress rule", async () => {
  const spec = { name: "shop-stage-frontend", region: "nyc", ingress: { rules: [{ component: { name: "legacy" }, match: { path: { prefix: "/old" } } }] } };
  const { fetch, calls } = fakeFetch({
    [`GET ${API}/apps?`]: { body: { apps: [app("app-9", "shop-stage-frontend", { spec })] } },
    [`PUT ${API}/apps/app-9`]: (call) => ({ body: { app: app("app-9", "shop-stage-frontend", { spec: call.body.spec, in_progress_deployment: { id: "d", phase: "BUILDING" } }) } }),
  });
  await provider.apply(context("frontend", fetch), { state: {} });
  const put = calls.find((c) => c.method === "PUT").body;
  assert.deepEqual(put.spec.ingress.rules.map((r) => r.component.name), ["legacy", "frontend"]);
  assert.equal(put.spec.static_sites.length, 1);
  assert.equal(calls.some((c) => c.url.includes("/deployments")), false);
});

test("apply rejects bad input before any request", async () => {
  const { fetch, calls } = fakeFetch({});
  await assert.rejects(provider.apply(context("api", fetch, { source: { branch: "main", directory: "." } }), { state: {} }), /owner\/name/);
  await assert.rejects(provider.apply(context("api", fetch, { source: { repository: "git@github.com:acme/shop.git", branch: "main", directory: "." } }), { state: {} }), /owner\/name/);
  await assert.rejects(provider.plan(context("api", fetch, { credentials: {} })), /DIGITALOCEAN_TOKEN is required/);
  assert.equal(calls.length, 0);
});

test("unsupported roles are rejected without requests", async () => {
  const { fetch, calls } = fakeFetch({});
  for (const role of ["database", "files"]) {
    await assert.rejects(provider.plan(context(role, fetch)), new RegExp(`does not support the ${role} role`));
    await assert.rejects(provider.apply(context(role, fetch), { state: {} }), /does not support/);
    await assert.rejects(provider.status(context(role, fetch)), /does not support/);
  }
  assert.equal(calls.length, 0);
});

test("status maps every deployment phase", async () => {
  const cases = { ACTIVE: "live", PENDING_BUILD: "deploying", BUILDING: "deploying", PENDING_DEPLOY: "deploying", DEPLOYING: "deploying", ERROR: "failed", CANCELED: "failed", SUPERSEDED: "unknown", UNKNOWN: "unknown" };
  for (const [phase, state] of Object.entries(cases)) {
    const { fetch, calls } = fakeFetch({
      [`GET ${API}/apps?`]: { body: { apps: [app("app-1", "shop-stage-api")] } },
      [`GET ${API}/apps/app-1/deployments`]: { body: { deployments: [{ id: "d", phase }] } },
    });
    const result = await provider.status(context("api", fetch));
    assert.equal(result.state, state, phase);
    assert.equal(result.url, "https://shop-stage-api-abc.ondigitalocean.app");
    assert.equal(calls[1].url, `${API}/apps/app-1/deployments?page=1&per_page=1`);
  }
});

test("status: missing app, running deployment on the app and no deployments", async () => {
  let { fetch } = fakeFetch({ [`GET ${API}/apps?`]: { body: { apps: [] } } });
  assert.deepEqual(await provider.status(context("api", fetch)), { state: "missing" });
  ({ fetch } = fakeFetch({ [`GET ${API}/apps?`]: { body: { apps: [app("app-1", "shop-stage-api", { in_progress_deployment: { id: "d", phase: "BUILDING" } })] } } }));
  assert.equal((await provider.status(context("api", fetch))).state, "deploying");
  ({ fetch } = fakeFetch({ [`GET ${API}/apps?`]: { body: { apps: [app("app-1", "shop-stage-api", { live_url: undefined, pending_deployment: { id: "p" } })] } } }));
  assert.deepEqual(await provider.status(context("api", fetch)), { state: "deploying", url: undefined, detail: undefined });
  ({ fetch } = fakeFetch({ [`GET ${API}/apps?`]: { body: { apps: [app("app-1", "shop-stage-api")] } }, [`GET ${API}/apps/app-1/deployments`]: { body: {} } }));
  assert.deepEqual(await provider.status(context("api", fetch)), { state: "unknown", url: "https://shop-stage-api-abc.ondigitalocean.app", detail: "no deployments yet" });
});

test("app lookup pagination is bounded (50 pages of 200)", async () => {
  const full = Array.from({ length: 200 }, (_, i) => app(`id-${i}`, `other-${i}`));
  const { fetch, calls } = fakeFetch({ [`GET ${API}/apps?`]: { body: { apps: full } } });
  assert.deepEqual(await provider.status(context("api", fetch)), { state: "missing" });
  assert.equal(calls.length, 50, "bounded pagination");
});

test("provider errors surface with the token redacted", async () => {
  const { fetch } = fakeFetch({
    [`GET ${API}/apps?`]: { body: { apps: [] } },
    [`POST ${API}/apps`]: { status: 422, body: { id: "unprocessable_entity", message: `GitHub user not authenticated (token ${TOKEN})` } },
  });
  const ctx = context("api", fetch);
  await assert.rejects(provider.apply(ctx, await provider.plan(ctx)), (error) => {
    assert.equal(error.status, 422);
    assert.match(error.message, /^DigitalOcean: POST \/apps → 422/);
    assert.ok(!error.message.includes(TOKEN) && error.message.includes("[redacted]"));
    return true;
  });
});
