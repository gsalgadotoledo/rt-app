import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import flyDefault, { provider, createFlyProvider, encodeSecrets, flyToml, machineState, spawnRunner, FLY_REGIONS } from "@gsalgadotoledo/rt-app-deploy-flyio";
import { ProviderRegistry, ProviderError } from "@gsalgadotoledo/rt-app-deploy";
import { fakeFetch, testContext } from "@gsalgadotoledo/rt-app-deploy/testing";

const API = "https://api.machines.dev/v1";
const TOKEN = "fo1_fly_token_abcdef";
const SECRET = "jwt-super-secret-value";

const root = mkdtempSync(join(tmpdir(), "rt-app-fly-test-"));
mkdirSync(join(root, "apps/server"), { recursive: true });
writeFileSync(join(root, "apps/server/Dockerfile"), "FROM node:22\n");
mkdirSync(join(root, "apps/nodocker"), { recursive: true });
test.after(() => rmSync(root, { recursive: true, force: true }));

/** Fake flyctl: records every call and a snapshot of the generated fly.toml during deploy. */
function flyctl(results = {}) {
  const calls = [];
  const run = async (command, args, options) => {
    const call = { command, args, cwd: options.cwd, env: options.env, input: options.input };
    const config = args.indexOf("--config");
    if (config > -1) call.toml = readFileSync(args[config + 1], "utf8");
    calls.push(call);
    const result = results[args[0]];
    if (typeof result === "function") return result(call);
    return result ?? { code: 0, stdout: "ok", stderr: "" };
  };
  return { run, calls };
}

function flyApi(extra = {}) {
  const apps = new Map(Object.entries(extra.apps ?? {}));
  return fakeFetch({
    [`GET ${API}/apps/`]: (call) => {
      const [, name, rest] = /\/apps\/([^/]+)(\/machines)?$/.exec(call.url);
      if (!apps.has(name)) return { status: 404, body: { error: "not found" } };
      if (rest) return { body: extra.machines ?? [] };
      return { body: { id: apps.get(name), name, status: "deployed", organization: { slug: "personal" } } };
    },
    [`POST ${API}/apps`]: (call) => {
      if (extra.createStatus) return { status: extra.createStatus, body: { error: `taken ${TOKEN}` } };
      apps.set(call.body.app_name, "app-id-1");
      return { status: 201, body: { id: "app-id-1", created_at: 1 } };
    },
  });
}

function context(api, overrides = {}) {
  return testContext({
    role: "api",
    fetch: api.fetch,
    credentials: { FLY_API_TOKEN: TOKEN },
    variables: { JWT_SECRET: SECRET, DATABASE_URL: "postgres://u:p4ssw0rd@db/x" },
    ...overrides,
  });
}

test("provider metadata registers and exposes the factory", () => {
  assert.equal(flyDefault, provider);
  const [entry] = new ProviderRegistry().register(provider).catalog();
  assert.equal(entry.id, "flyio");
  assert.deepEqual(entry.roles, ["api"]);
  assert.deepEqual(entry.credentials.map((c) => c.key), ["FLY_API_TOKEN"]);
  assert.equal(entry.settings.find((s) => s.key === "region").options, FLY_REGIONS);
  assert.equal(FLY_REGIONS.includes("iad") && FLY_REGIONS.includes("fra"), true);
  assert.equal(typeof createFlyProvider, "function");
});

test("plan reads the app only and lists secret names, never values", async () => {
  const api = flyApi();
  const fake = flyctl();
  const fly = createFlyProvider({ run: fake.run, root });
  const plan = await fly.plan(context(api));
  assert.deepEqual(api.calls.map((c) => `${c.method} ${c.url}`), [`GET ${API}/apps/shop-stage-api`]);
  assert.equal(api.calls[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(fake.calls.length, 0, "plan runs no flyctl command");
  assert.deepEqual(plan, {
    provider: "flyio",
    role: "api",
    environment: "stage",
    actions: [
      { action: "create", resource: "app shop-stage-api", detail: "in org personal" },
      { action: "update", resource: "secrets", detail: "DATABASE_URL, JWT_SECRET" },
      { action: "deploy", resource: "app shop-stage-api", detail: "flyctl deploy apps/server (Dockerfile, iad)" },
    ],
    state: { app: "shop-stage-api", exists: false },
  });
  assert.equal(JSON.stringify(plan).includes(SECRET), false);
});

test("apply creates the app, imports secrets over stdin and deploys with a generated fly.toml", async () => {
  const api = flyApi();
  const fake = flyctl();
  const logs = [];
  const fly = createFlyProvider({ run: fake.run, root, env: { PATH: "/usr/bin", HOME: "/home/ci" } });
  const ctx = context(api, { settings: { org: "acme", region: "fra", ha: false }, log: (m) => logs.push(m) });
  const result = await fly.apply(ctx, await fly.plan(ctx));

  const post = api.calls.find((c) => c.method === "POST");
  assert.equal(post.url, `${API}/apps`);
  assert.deepEqual(post.body, { app_name: "shop-stage-api", org_slug: "acme" });

  assert.deepEqual(fake.calls.map((c) => [c.command, ...c.args.slice(0, 2)]), [
    ["flyctl", "version"],
    ["flyctl", "secrets", "import"],
    ["flyctl", "deploy", join(root, "apps/server")],
  ]);
  const [version, secrets, deploy] = fake.calls;
  assert.equal(version.input, undefined);
  assert.deepEqual(secrets.args, ["secrets", "import", "--app", "shop-stage-api", "--stage"]);
  assert.equal(secrets.input, `JWT_SECRET="""${SECRET}"""\nDATABASE_URL="""postgres://u:p4ssw0rd@db/x"""\n`);
  const config = deploy.args[deploy.args.indexOf("--config") + 1];
  assert.deepEqual(deploy.args, [
    "deploy",
    join(root, "apps/server"),
    "--app",
    "shop-stage-api",
    "--config",
    config,
    "--remote-only",
    "--yes",
    "--dockerfile",
    join(root, "apps/server/Dockerfile"),
    "--ha=false",
  ]);
  assert.equal(existsSync(config), false, "temporary fly.toml is removed");
  assert.equal(
    deploy.toml,
    [
      'app = "shop-stage-api"',
      'primary_region = "fra"',
      "",
      "[env]",
      '  PORT = "8080"',
      "",
      "[http_service]",
      "  internal_port = 8080",
      "  force_https = true",
      '  auto_stop_machines = "stop"',
      "  auto_start_machines = true",
      "  min_machines_running = 0",
      "",
    ].join("\n"),
  );
  for (const call of fake.calls) {
    assert.equal(call.env.FLY_API_TOKEN, TOKEN, "token travels in the environment");
    assert.equal(call.env.NO_COLOR, "1");
    assert.equal(call.env.PATH, "/usr/bin");
    assert.equal(call.cwd, join(root, "apps/server"));
    const argv = call.args.join(" ");
    for (const secret of [TOKEN, SECRET, "p4ssw0rd"]) assert.equal(argv.includes(secret), false, "no secret in argv");
  }
  assert.deepEqual(result, { provider: "flyio", role: "api", url: "https://shop-stage-api.fly.dev", resources: [{ kind: "app", id: "app-id-1", name: "shop-stage-api" }] });
  const logText = logs.join("\n");
  assert.equal(logText.includes(SECRET) || logText.includes(TOKEN), false);
  assert.match(logText, /staged 2 secrets \(DATABASE_URL, JWT_SECRET\)/);
});

test("re-running apply on an existing app does not create it again", async () => {
  const api = flyApi({ apps: { "shop-stage-api": "existing-id" } });
  const fake = flyctl();
  const fly = createFlyProvider({ run: fake.run, root });
  const ctx = context(api, { variables: {} });
  const plan = await fly.plan(ctx);
  assert.deepEqual(plan.actions.map((a) => a.action), ["deploy"]);
  assert.deepEqual(plan.state, { app: "shop-stage-api", exists: true });
  const result = await fly.apply(ctx, plan);
  assert.equal(api.calls.some((c) => c.method === "POST"), false);
  assert.deepEqual(fake.calls.map((c) => c.args[0]), ["version", "deploy"], "no secrets import without variables");
  assert.equal(fake.calls[1].args.includes("--ha=false"), false);
  assert.equal(result.resources[0].id, "existing-id");

  // Without a usable plan state, apply discovers the app itself.
  api.calls.length = 0;
  await fly.apply(ctx, { provider: "other", role: "api", environment: "stage", actions: [] });
  assert.deepEqual(api.calls.map((c) => c.method), ["GET", "GET"]);
});

test("PORT from variables, custom port, builder without Dockerfile and appName setting", async () => {
  const api = flyApi();
  const fake = flyctl();
  const fly = createFlyProvider({ run: fake.run, root });
  const ctx = context(api, {
    source: { branch: "main", directory: "apps/nodocker" },
    variables: { PORT: "3000" },
    settings: { builder: "paketobuildpacks/builder-jammy-base", appName: "acme-api", autoStop: "off" },
  });
  const plan = await fly.plan(ctx);
  assert.equal(plan.actions.at(-1).detail, "flyctl deploy apps/nodocker (builder paketobuildpacks/builder-jammy-base, iad)");
  await fly.apply(ctx, plan);
  const deploy = fake.calls.find((c) => c.args[0] === "deploy");
  assert.equal(deploy.args.includes("--dockerfile"), false);
  assert.match(deploy.toml, /\[build\]\n {2}builder = "paketobuildpacks\/builder-jammy-base"/);
  assert.match(deploy.toml, /internal_port = 3000/);
  assert.equal(deploy.toml.includes("[env]"), false, "PORT comes from the secret");
  assert.match(deploy.toml, /auto_stop_machines = "off"\n {2}auto_start_machines = false/);
  assert.match(deploy.toml, /^app = "acme-api"/);
  assert.match(flyToml({ app: "a", region: "iad", port: 9000, autoStop: "stop", setPort: false }), /internal_port = 9000/);
});

test("invalid configuration fails before any request or command", async () => {
  const api = flyApi();
  const fake = flyctl();
  const fly = createFlyProvider({ run: fake.run, root });
  const cases = [
    [{ credentials: {} }, /FLY_API_TOKEN is required/],
    [{ role: "ssr" }, /does not support the ssr role/],
    [{ role: "database" }, /does not support the database role/],
    [{ settings: { region: "mars" } }, /Unknown Fly region: mars/],
    [{ settings: { appName: "Bad_Name" } }, /Invalid Fly app name/],
    [{ settings: { port: 70000 } }, /Invalid port/],
    [{ source: { branch: "main", directory: "apps/nodocker" } }, /No Dockerfile in apps\/nodocker/],
  ];
  for (const [overrides, error] of cases) {
    await assert.rejects(fly.plan(context(api, overrides)), error);
    await assert.rejects(fly.apply(context(api, overrides), { provider: "flyio", role: "api", environment: "stage", actions: [] }), error);
  }
  await assert.rejects(fly.status(context(api, { role: "frontend" })), /does not support the frontend role/);
  assert.equal(api.calls.length, 0);
  assert.equal(fake.calls.length, 0);
});

test("missing flyctl fails with the install hint before creating anything", async () => {
  const api = flyApi();
  const enoent = Object.assign(new Error("spawn flyctl ENOENT"), { code: "ENOENT" });
  const fly = createFlyProvider({ run: async () => Promise.reject(enoent), root });
  await assert.rejects(fly.apply(context(api), { provider: "flyio", role: "api", environment: "stage", actions: [] }), (e) => {
    assert.ok(e instanceof ProviderError);
    assert.match(e.message, /flyctl was not found\. Install flyctl: https:\/\/fly\.io\/docs\/flyctl\/install\//);
    return true;
  });
  assert.equal(api.calls.length, 0);

  // Default spawn runner with a binary that does not exist.
  const real = createFlyProvider({ flyctl: "rt-app-missing-flyctl-binary", root });
  await assert.rejects(real.apply(context(api), { provider: "flyio", role: "api", environment: "stage", actions: [] }), /Install flyctl/);

  const other = createFlyProvider({ run: async () => Promise.reject(new Error(`EACCES ${TOKEN}`)), root });
  await assert.rejects(other.apply(context(api), { provider: "flyio", role: "api", environment: "stage", actions: [] }), (e) => {
    assert.match(e.message, /flyctl version failed: EACCES \[redacted\]/);
    return true;
  });
});

test("failed flyctl commands surface redacted output and the temp config is cleaned up", async () => {
  const api = flyApi({ apps: { "shop-stage-api": "id" } });
  let config;
  const fake = flyctl({
    deploy: (call) => {
      config = call.args[call.args.indexOf("--config") + 1];
      return { code: 1, stdout: "", stderr: `Error: build failed with ${SECRET} and ${TOKEN}` };
    },
  });
  const fly = createFlyProvider({ run: fake.run, root });
  await assert.rejects(fly.apply(context(api), await fly.plan(context(api))), (e) => {
    assert.ok(e instanceof ProviderError);
    assert.equal(e.status, 1);
    assert.equal(e.message, `Fly.io: flyctl deploy ${join(root, "apps/server")} exited with 1: Error: build failed with [redacted] and [redacted]`);
    return true;
  });
  assert.equal(existsSync(config), false);

  const secretsFail = flyctl({ secrets: { code: 2, stdout: `could not set ${SECRET}`, stderr: "" } });
  const fly2 = createFlyProvider({ run: secretsFail.run, root });
  await assert.rejects(fly2.apply(context(api), await fly2.plan(context(api))), /flyctl secrets import exited with 2: could not set \[redacted\]/);
  assert.equal(secretsFail.calls.some((c) => c.args[0] === "deploy"), false, "no deploy after a failed secrets import");
});

test("a taken app name (422) explains the appName setting; other API errors pass through redacted", async () => {
  const fake = flyctl();
  const fly = createFlyProvider({ run: fake.run, root });
  const taken = flyApi({ createStatus: 422 });
  await assert.rejects(fly.apply(context(taken), await fly.plan(context(taken))), (e) => {
    assert.equal(e.status, 422);
    assert.match(e.message, /App name shop-stage-api is taken on Fly\.io; set the "appName" setting/);
    assert.equal(e.message.includes(TOKEN), false);
    return true;
  });
  const broken = flyApi({ createStatus: 401 });
  await assert.rejects(fly.apply(context(broken), await fly.plan(context(broken))), (e) => e.status === 401 && !e.message.includes(TOKEN));
  assert.equal(fake.calls.some((c) => c.args[0] === "deploy"), false);
});

test("secrets encoding keeps special characters and rejects values flyctl would misread", () => {
  assert.equal(encodeSecrets({ A: "x#1", B: "", C: 'say "hi"', D: "line1\nline2", E: " padded " }), [
    'A="""x#1"""',
    'B=""""""',
    'C="""say "hi""""',
    'D="""line1\nline2"""',
    'E=""" padded """',
    "",
  ].join("\n"));
  for (const [value, name] of [['a"""b', "triple"], ["a\r\nb", "cr"], ['"#x', "comment"], ["x".repeat(60_001), "long"]])
    assert.throws(() => encodeSecrets({ [name.toUpperCase()]: value }), (e) => e instanceof ProviderError && e.message.includes(name.toUpperCase()) && !e.message.includes(value));
  assert.throws(() => encodeSecrets({ "BAD-NAME": "v" }), /Invalid secret name/);
});

test("status maps machine states and reports missing apps", async () => {
  const fly = createFlyProvider({ run: flyctl().run, root });
  assert.deepEqual(await fly.status(context(flyApi())), { state: "missing" });

  const api = flyApi({ apps: { "shop-stage-api": "id" }, machines: [{ state: "started" }, { state: "destroyed" }] });
  assert.deepEqual(await fly.status(context(api)), { state: "live", detail: "Machines: started", url: "https://shop-stage-api.fly.dev" });
  assert.deepEqual(api.calls.map((c) => c.url), [`${API}/apps/shop-stage-api`, `${API}/apps/shop-stage-api/machines`]);
  assert.equal(api.calls.every((c) => c.method === "GET"), true);

  const cases = [
    [[], "unknown"],
    [["destroyed"], "unknown"],
    [["started", "failed"], "live"],
    [["created"], "deploying"],
    [["replacing", "stopped"], "deploying"],
    [["failed", "launch_failed"], "failed"],
    [["stopped", "suspended"], "live"],
    [["failed", "stopped"], "unknown"],
  ];
  for (const [states, state] of cases) assert.equal(machineState(states).state, state, states.join(","));
});

test("spawnRunner passes stdin, env and cwd and reports exit codes", async () => {
  const script = "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stdout.write(s+process.env.RT_X+process.cwd());process.stderr.write('e');process.exit(3)})";
  const result = await spawnRunner(process.execPath, ["-e", script], { cwd: root, env: { ...process.env, RT_X: "!" }, input: "in:" });
  assert.equal(result.code, 3);
  assert.equal(result.stderr, "e");
  assert.match(result.stdout, /^in:!.*rt-app-fly-test-/);
  const empty = await spawnRunner(process.execPath, ["-e", "process.stdin.resume().on('end',()=>process.exit(0))"], { env: process.env });
  assert.deepEqual(empty, { code: 0, stdout: "", stderr: "" });
});
