import test from "node:test";
import assert from "node:assert/strict";
import provider, { provider as named } from "@gsalgadotoledo/rt-app-deploy-heroku";
import { ProviderRegistry, validateDeploySettings } from "@gsalgadotoledo/rt-app-deploy";
import { fakeFetch, testContext } from "@gsalgadotoledo/rt-app-deploy/testing";

const API = "https://api.heroku.com";
const GITHUB = "https://api.github.com/repos/acme/shop/tarball";
const KEY = "hrku-secret-key-123";
const GH_TOKEN = "github_pat_secret_456";
const TARBALL = "https://codeload.github.com/acme/shop/legacy.tar.gz/refs/heads/stage?token=TEMPTOKEN999";
const APP = { id: "app-uuid-1", name: "shop-stage-api", web_url: "https://shop-stage-api-abc.herokuapp.com/" };

function context(fetch, overrides = {}) {
  return testContext({ role: "api", fetch, credentials: { HEROKU_API_KEY: KEY }, variables: { DATABASE_URL: "postgres://u:p@h/db", JWT_SECRET: "jwt-value" }, ...overrides });
}

/** Records the RequestInit `redirect` option, which fakeFetch does not keep. */
function withRedirects(fetch) {
  const redirects = [];
  return { redirects, fetch: (url, init = {}) => (redirects.push([String(url), init.redirect]), fetch(url, init)) };
}

const tarball = { [`GET ${GITHUB}`]: { status: 302, body: "", headers: { location: TARBALL } } };

test("metadata: api role only, credentials and regions", () => {
  assert.equal(named, provider);
  assert.equal(provider.id, "heroku");
  assert.deepEqual(provider.roles, ["api"]);
  assert.deepEqual(provider.credentials.map((c) => [c.key, Boolean(c.optional)]), [["HEROKU_API_KEY", false], ["HEROKU_TEAM", true], ["GITHUB_TOKEN", true]]);
  assert.deepEqual(provider.settings[0].options, ["us", "eu"]);
  const registry = new ProviderRegistry().register(provider);
  assert.doesNotThrow(() => validateDeploySettings({ environments: { prod: { api: { provider: "heroku", settings: { region: "eu" } } } } }, registry));
  assert.throws(() => validateDeploySettings({ environments: { prod: { ssr: { provider: "heroku" } } } }, registry), /does not support the ssr role/);
});

test("plan on a missing app: one GET with Heroku headers, create + deploy", async () => {
  const { fetch, calls } = fakeFetch({ [`GET ${API}/apps/shop-stage-api`]: { status: 404, body: { id: "not_found" } } });
  const plan = await provider.plan(context(fetch));
  assert.deepEqual(plan.actions.map((a) => a.action), ["create", "deploy"]);
  assert.deepEqual(plan.state, {});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].headers.accept, "application/vnd.heroku+json; version=3");
  assert.equal(calls[0].headers.authorization, `Bearer ${KEY}`);
});

test("plan on an existing app: update + deploy with the app id in state, GET only", async () => {
  const { fetch, calls } = fakeFetch({ [`GET ${API}/apps/shop-stage-api`]: { body: APP } });
  const plan = await provider.plan(context(fetch, { credentials: { HEROKU_API_KEY: KEY, HEROKU_TEAM: "acme" } }));
  assert.deepEqual(plan.actions.map((a) => a.action), ["update", "deploy"]);
  assert.deepEqual(plan.state, { appId: "app-uuid-1" });
  assert.ok(calls.every((c) => c.method === "GET"));
});

test("apply creates a personal app, sets config vars and builds from the GitHub tarball", async () => {
  const fake = fakeFetch({
    ...tarball,
    [`GET ${API}/apps/shop-stage-api`]: { status: 404, body: {} },
    [`POST ${API}/apps`]: { status: 201, body: APP },
    [`PATCH ${API}/apps/app-uuid-1/config-vars`]: (call) => ({ body: call.body }),
    [`POST ${API}/apps/app-uuid-1/builds`]: { status: 201, body: { id: "build-1", status: "pending" } },
  });
  const { fetch, redirects } = withRedirects(fake.fetch);
  const ctx = context(fetch, { settings: { region: "eu" }, source: { repository: "acme/shop", branch: "stage", directory: ".", runtime: "node" } });
  const result = await provider.apply(ctx, await provider.plan(ctx));
  assert.deepEqual(result, {
    provider: "heroku",
    role: "api",
    url: APP.web_url,
    resources: [{ kind: "app", id: "app-uuid-1", name: "shop-stage-api" }, { kind: "build", id: "build-1", name: "shop-stage-api stage" }],
  });
  const writes = fake.calls.filter((c) => c.method !== "GET");
  assert.deepEqual(writes.map((c) => `${c.method} ${c.url}`), [`POST ${API}/apps`, `PATCH ${API}/apps/app-uuid-1/config-vars`, `POST ${API}/apps/app-uuid-1/builds`]);
  assert.deepEqual(writes[0].body, { name: "shop-stage-api", region: "eu" });
  assert.deepEqual(writes[1].body, { DATABASE_URL: "postgres://u:p@h/db", JWT_SECRET: "jwt-value" });
  assert.deepEqual(writes[2].body, { source_blob: { url: TARBALL, version: "stage" } });
  assert.ok(writes.every((c) => c.headers.authorization === `Bearer ${KEY}` && c.headers.accept.startsWith("application/vnd.heroku+json")));
  const github = fake.calls.find((c) => c.url.startsWith(GITHUB));
  assert.equal(github.url, `${GITHUB}/stage`);
  assert.equal(github.headers.authorization, undefined, "public repositories need no token");
  assert.deepEqual(redirects.find(([url]) => url.startsWith(GITHUB)), [`${GITHUB}/stage`, "manual"]);
});

test("apply creates a team app for a monorepo folder with the private-repo token", async () => {
  const { fetch, calls } = fakeFetch({
    ...tarball,
    [`GET ${API}/apps/shop-stage-api`]: { status: 404, body: {} },
    [`POST ${API}/teams/apps`]: { status: 201, body: APP },
    [`PATCH ${API}/apps/app-uuid-1/config-vars`]: { body: {} },
    [`POST ${API}/apps/app-uuid-1/builds`]: { status: 201, body: { id: "build-2", status: "pending" } },
  });
  const ctx = context(fetch, {
    credentials: { HEROKU_API_KEY: KEY, HEROKU_TEAM: "acme", GITHUB_TOKEN: GH_TOKEN },
    source: { repository: "acme/shop", branch: "feature/x", directory: "./apps/server/", runtime: "python" },
  });
  await provider.apply(ctx, { provider: "heroku", actions: [], state: {} });
  assert.deepEqual(calls.find((c) => c.url === `${API}/teams/apps`).body, { name: "shop-stage-api", region: "us", team: "acme" });
  assert.equal(calls.find((c) => c.url.includes("config-vars")).body.APP_BASE, "apps/server");
  assert.deepEqual(calls.find((c) => c.url.endsWith("/builds")).body.buildpacks, [{ url: "https://github.com/lstoll/heroku-buildpack-monorepo" }, { url: "heroku/python" }]);
  const github = calls.find((c) => c.url.startsWith(GITHUB));
  assert.equal(github.url, `${GITHUB}/feature/x`);
  assert.equal(github.headers.authorization, `Bearer ${GH_TOKEN}`);
});

test("apply update path is idempotent: no create, config vars and a new build on every run", async () => {
  const { fetch, calls } = fakeFetch({
    ...tarball,
    [`GET ${API}/apps/shop-stage-api`]: { body: APP },
    [`GET ${API}/apps/app-uuid-1`]: { body: APP },
    [`PATCH ${API}/apps/app-uuid-1/config-vars`]: { body: {} },
    [`POST ${API}/apps/app-uuid-1/builds`]: { status: 201, body: { id: "build-3", status: "pending" } },
  });
  const ctx = context(fetch, { source: { repository: "acme/shop", branch: "stage", directory: "apps/server" } });
  for (let run = 0; run < 2; run++) await provider.apply(ctx, await provider.plan(ctx));
  const writes = calls.filter((c) => c.method !== "GET");
  assert.deepEqual(writes.map((c) => c.method + " " + c.url.replace(API, "")), [
    "PATCH /apps/app-uuid-1/config-vars", "POST /apps/app-uuid-1/builds",
    "PATCH /apps/app-uuid-1/config-vars", "POST /apps/app-uuid-1/builds",
  ]);
  assert.deepEqual(writes[1].body.buildpacks[1], { url: "heroku/nodejs" });
  assert.ok(calls.some((c) => c.url === `${API}/apps/app-uuid-1`), "apply reads the planned app by id");
});

test("apply without plan state looks the app up by name", async () => {
  const { fetch, calls } = fakeFetch({
    ...tarball,
    [`GET ${API}/apps/shop-stage-api`]: { body: { ...APP, web_url: null } },
    [`PATCH ${API}/apps/app-uuid-1/config-vars`]: { body: {} },
    [`POST ${API}/apps/app-uuid-1/builds`]: { status: 201, body: { id: "b", status: "pending" } },
  });
  const result = await provider.apply(context(fetch), { state: undefined });
  assert.equal(result.url, undefined);
  assert.equal(calls.some((c) => c.method === "POST" && c.url.endsWith("/apps")), false);
});

test("source errors stop apply before any Heroku write, with secrets redacted", async () => {
  const plan = { provider: "heroku", actions: [], state: {} };
  const credentials = { HEROKU_API_KEY: KEY, GITHUB_TOKEN: GH_TOKEN };
  let fake = fakeFetch({ [`GET ${GITHUB}`]: { status: 404, body: "Not Found" } });
  await assert.rejects(provider.apply(context(fake.fetch, { credentials }), plan), (error) => {
    assert.equal(error.status, 404);
    assert.match(error.message, /GITHUB_TOKEN/);
    assert.ok(!error.message.includes(GH_TOKEN) && !error.message.includes(KEY));
    return true;
  });
  fake = fakeFetch({ [`GET ${GITHUB}`]: { status: 302, body: "" } });
  await assert.rejects(provider.apply(context(fake.fetch), plan), /→ 302/);
  const failing = async () => { throw new Error(`socket closed ${GH_TOKEN}`); };
  await assert.rejects(provider.apply(context(failing, { credentials }), plan), (error) => error.status === 0 && error.message.includes("[redacted]") && !error.message.includes(GH_TOKEN));
  await assert.rejects(provider.apply(context(fake.fetch, { source: { branch: "main", directory: "." } }), plan), /owner\/name/);
  await assert.rejects(provider.apply(context(fake.fetch, { source: { repository: "acme/shop", branch: "main", directory: "api", runtime: "static" } }), plan), /unsupported runtime "static"/);
  await assert.rejects(provider.plan(context(fake.fetch, { credentials: {} })), /HEROKU_API_KEY is required/);
});

test("Heroku errors are surfaced with the API key and the tarball token redacted", async () => {
  const { fetch } = fakeFetch({
    ...tarball,
    [`GET ${API}/apps/shop-stage-api`]: { body: APP },
    [`PATCH ${API}/apps/app-uuid-1/config-vars`]: { body: {} },
    [`POST ${API}/apps/app-uuid-1/builds`]: { status: 422, body: { id: "invalid_params", message: `could not fetch ${TARBALL} with ${KEY}` } },
  });
  await assert.rejects(provider.apply(context(fetch), { state: {} }), (error) => {
    assert.equal(error.status, 422);
    assert.match(error.message, /^Heroku: POST \/apps\/app-uuid-1\/builds → 422/);
    assert.ok(!error.message.includes(KEY) && !error.message.includes("TEMPTOKEN999"));
    return true;
  });
});

test("unsupported roles are rejected without requests", async () => {
  const { fetch, calls } = fakeFetch({});
  for (const role of ["ssr", "frontend", "database", "files"]) {
    await assert.rejects(provider.plan(context(fetch, { role })), new RegExp(`Heroku does not support the ${role} role`));
    await assert.rejects(provider.apply(context(fetch, { role }), { state: {} }), /does not support/);
    await assert.rejects(provider.status(context(fetch, { role })), /does not support/);
  }
  assert.equal(calls.length, 0);
});

test("status maps the latest build (sorted by started_at, newest first)", async () => {
  for (const [remote, state] of [["succeeded", "live"], ["pending", "deploying"], ["failed", "failed"], ["expired", "unknown"]]) {
    const { fetch, calls } = fakeFetch({
      [`GET ${API}/apps/shop-stage-api`]: { body: APP },
      [`GET ${API}/apps/app-uuid-1/builds`]: { status: 206, body: [{ id: "b", status: remote }] },
    });
    const result = await provider.status(context(fetch));
    assert.equal(result.state, state, remote);
    assert.equal(result.url, APP.web_url);
    assert.equal(calls[1].headers.range, "started_at ..; order=desc,max=1;");
  }
});

test("status: missing app and app without builds", async () => {
  let { fetch } = fakeFetch({ [`GET ${API}/apps/shop-stage-api`]: { status: 404, body: {} } });
  assert.deepEqual(await provider.status(context(fetch)), { state: "missing" });
  ({ fetch } = fakeFetch({ [`GET ${API}/apps/shop-stage-api`]: { body: { ...APP, web_url: null } }, [`GET ${API}/apps/app-uuid-1/builds`]: { body: [] } }));
  assert.deepEqual(await provider.status(context(fetch)), { state: "unknown", url: undefined, detail: "no builds yet" });
});

test("app names respect Heroku's 30 character limit", async () => {
  const { fetch, calls } = fakeFetch({ [`GET ${API}/apps/`]: { status: 404, body: {} } });
  await provider.plan(context(fetch, { app: "a-very-long-application-name" }));
  const name = calls[0].url.slice(`${API}/apps/`.length);
  assert.ok(name.length <= 30 && /^[a-z][a-z0-9-]{1,28}[a-z0-9]$/.test(name), name);
});
