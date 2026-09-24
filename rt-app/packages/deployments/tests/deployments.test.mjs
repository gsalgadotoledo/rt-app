import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderRegistry } from "@gsalgadotoledo/rt-app-deploy";
import {
  awsProvider,
  loadRegistry,
  sourceFor,
  runtimeVariables,
  saveDeploySettings,
  readDeploySettings,
  saveCredential,
  readCredentials,
  credentialStatus,
  githubRepository,
  syncGithub,
  connectGithub,
  planDeployment,
  applyDeployment,
  deploymentStatus,
  PROVIDER_PACKAGES,
} from "@gsalgadotoledo/rt-app-deployments";
import { deployCommand, githubCommand, withCiSecrets, DEPLOY_USAGE, GITHUB_USAGE } from "@gsalgadotoledo/rt-app-deployments/cli";

function fakeProvider(id, roles, { fail } = {}) {
  const calls = [];
  return {
    calls,
    id,
    name: id,
    roles,
    website: "https://" + id,
    credentials: [{ key: id.toUpperCase() + "_KEY", label: "Key" }],
    settings: [{ key: "region", label: "Region", type: "string", default: "us" }],
    async plan(c) {
      calls.push(["plan", c.role, c.source, { ...c.variables }, c.settings]);
      return { provider: id, role: c.role, environment: c.environment, actions: [{ action: "create", resource: c.app + "-" + c.role, detail: "new" }] };
    },
    async apply(c) {
      if (fail) throw new Error(fail);
      calls.push(["apply", c.role]);
      return { provider: id, role: c.role, url: "https://" + c.role + "." + id, resources: [{ kind: "service", id: "s1", name: c.role }], outputs: c.role === "database" ? { DATABASE_URL: "postgres://db" } : {} };
    },
    async status(c) {
      if (c.role === "ssr") throw new Error("status endpoint down");
      return { state: "live", url: "https://" + c.role };
    },
  };
}

async function project(t, deploy) {
  const root = await mkdtemp(join(tmpdir(), "rt-deploy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "rt-app.settings.json"), JSON.stringify({ version: 1, project: { name: "shop" }, runtime: { local: { mode: "json" } }, ...(deploy ? { deploy } : {}) }));
  return root;
}

// Fake git/gh: records every call; secrets must arrive through stdin only.
function runner({ origin = "git@github.com:acme/shop.git", authed = true, failOn } = {}) {
  const calls = [];
  const run = (command, args, options = {}) => {
    calls.push({ command, args, input: options.input });
    const key = command + " " + args.join(" ");
    if (failOn && key.includes(failOn)) return { status: 1, stdout: "", stderr: "boom" };
    if (key === "git remote get-url origin") return origin ? { status: 0, stdout: origin + "\n", stderr: "" } : { status: 2, stdout: "", stderr: "no remote" };
    if (key === "gh auth status") return { status: authed ? 0 : 1, stdout: "", stderr: "" };
    if (command === "gh" && args[0] === "repo") origin = "https://github.com/acme/new-shop.git";
    return { status: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

test("registry loads AWS plus every importable provider package; broken packages are not hidden", async () => {
  const neon = fakeProvider("neon", ["database"]);
  const registry = await loadRegistry(async (name) => {
    if (name.endsWith("-neon")) return { provider: neon };
    if (name.endsWith("-render")) return {};
    const error = new Error("not installed");
    error.code = "ERR_MODULE_NOT_FOUND";
    throw error;
  });
  assert.deepEqual(registry.list().map((p) => p.id), ["aws", "neon"]);
  await assert.rejects(loadRegistry(async () => { throw new Error("syntax error in provider"); }), /syntax error/);
  assert.equal(PROVIDER_PACKAGES.length, 8);
});

test("AWS is plannable but deployed by Terraform", async () => {
  const context = { app: "shop", environment: "prod", role: "api" };
  assert.equal((await awsProvider.plan(context)).actions[0].action, "noop");
  await assert.rejects(awsProvider.apply(context), /Terraform pipeline/);
  assert.equal((await awsProvider.status(context)).state, "unknown");
});

test("sources follow the starter layout and runtime variables come from the environment", () => {
  assert.deepEqual(sourceFor("api", "acme/shop", "main"), {
    repository: "acme/shop", branch: "main", directory: ".", runtime: "node",
    buildCommand: "npm ci --include=dev && npm run build",
    startCommand: "node apps/server/dist/migrate.js up && node apps/server/dist/index.js",
  });
  assert.equal(sourceFor("ssr", undefined, "stage").directory, "apps/ssr");
  assert.deepEqual([sourceFor("frontend", "a/b", "x").runtime, sourceFor("frontend", "a/b", "x").outputDirectory], ["static", "dist"]);
  assert.equal(sourceFor("database", "a/b", "x").directory, ".");
  assert.deepEqual(runtimeVariables("stage", { JWT_SECRET: "j", SMTP_URL: "smtps://x", UNRELATED: "no" }), {
    RT_APP_TARGET: "portable", RT_APP_ENVIRONMENT: "stage", NODE_ENV: "production", JWT_SECRET: "j", SMTP_URL: "smtps://x",
  });
});

test("deploy settings are validated and saved without touching other settings", async (t) => {
  const root = await project(t);
  const registry = new ProviderRegistry().register(fakeProvider("render", ["api"]));
  await saveDeploySettings(root, registry, { environments: { stage: { api: { provider: "render", settings: { region: "eu" } } } } });
  const saved = JSON.parse(await readFile(join(root, "rt-app.settings.json"), "utf8"));
  assert.equal(saved.runtime.local.mode, "json");
  assert.deepEqual((await readDeploySettings(root, registry)).deploy.environments.stage.api, { provider: "render", settings: { region: "eu" } });
  await assert.rejects(saveDeploySettings(root, registry, { environments: { stage: { database: { provider: "render" } } } }), /does not support/);
});

test("credentials live in a 0600 local file and are reported as present or missing, never by value", async (t) => {
  const root = await project(t, { environments: { stage: { api: { provider: "render" } } } });
  const registry = new ProviderRegistry().register(fakeProvider("render", ["api"]));
  assert.deepEqual(await readCredentials(root), {});
  await saveCredential(root, "stage", "RENDER_KEY", "rnd_secret");
  await saveCredential(root, "stage", "OTHER_KEY", "x");
  await saveCredential(root, "stage", "OTHER_KEY", "");
  assert.deepEqual(await readCredentials(root), { stage: { RENDER_KEY: "rnd_secret" } });
  assert.equal((await stat(join(root, ".rt-app/credentials.json"))).mode & 0o777, 0o600);
  const { deploy } = await readDeploySettings(root, registry);
  const status = await credentialStatus(root, registry, deploy);
  assert.deepEqual(status.stage, [{ provider: "render", credentials: [{ key: "RENDER_KEY", label: "Key", present: true }], missing: [] }]);
  assert.deepEqual(status.prod, []);
  assert.equal(JSON.stringify(status).includes("rnd_secret"), false);
  await assert.rejects(saveCredential(root, "qa", "K", "v"), /Unknown environment/);
  await assert.rejects(saveCredential(root, "stage", "lower", "v"), /Invalid credential name/);
  await assert.rejects(saveCredential(root, "stage", "KEY_X", "v".repeat(10001)), /Invalid credential value/);
});

test("GitHub: repository detection, environments and secrets through stdin", async (t) => {
  const root = await project(t);
  await saveCredential(root, "stage", "RENDER_KEY", "rnd_secret");
  assert.equal(githubRepository(root, runner().run), "acme/shop");
  assert.equal(githubRepository(root, runner({ origin: "https://github.com/acme/shop" }).run), "acme/shop");
  assert.equal(githubRepository(root, runner({ origin: "https://gitlab.com/acme/shop.git" }).run), undefined);
  assert.equal(githubRepository(root, runner({ origin: null }).run), undefined);
  const { run, calls } = runner();
  const result = await syncGithub(root, { run, environments: ["stage"], secrets: { JWT_SECRET: "jwt_secret_value", SMTP_URL: undefined } });
  assert.deepEqual(result, { repository: "acme/shop", secrets: { stage: ["JWT_SECRET", "RENDER_KEY"] } });
  assert.ok(calls.some((c) => c.args.join(" ") === "api --method PUT repos/acme/shop/environments/stage --silent"));
  const secretCalls = calls.filter((c) => c.args[0] === "secret");
  assert.deepEqual(secretCalls.map((c) => c.input), ["jwt_secret_value", "rnd_secret"]);
  assert.equal(calls.some((c) => c.args.some((a) => a.includes("secret_value") || a.includes("rnd_secret"))), false, "no secret in argv");
  await assert.rejects(syncGithub(root, { run: runner({ origin: null }).run }), /No GitHub origin/);
  await assert.rejects(syncGithub(root, { run: runner({ authed: false }).run }), /gh auth login/);
  await assert.rejects(syncGithub(root, { run: runner({ failOn: "environments/develop" }).run }), /Could not create environment develop/);
  await assert.rejects(syncGithub(root, { run: runner({ failOn: "secret set RENDER_KEY" }).run, environments: ["stage"] }), /Could not set RENDER_KEY/);
  assert.deepEqual((await syncGithub(root, { run: runner().run })).secrets, { develop: [], stage: ["RENDER_KEY"], prod: [] });
});

test("GitHub connect reuses an origin or creates the repository", (t) => {
  assert.deepEqual(connectGithub("/x", { run: runner().run }), { repository: "acme/shop", created: false });
  const fresh = runner({ origin: null });
  assert.deepEqual(connectGithub("/x", { run: fresh.run, visibility: "public", name: "acme/new-shop" }), { repository: "acme/new-shop", created: true });
  assert.deepEqual(fresh.calls.find((c) => c.args[0] === "repo").args, ["repo", "create", "acme/new-shop", "--public", "--source", ".", "--push"]);
  assert.throws(() => connectGithub("/x", { run: runner({ origin: null, authed: false }).run }), /gh auth login/);
  assert.throws(() => connectGithub("/x", { run: runner({ origin: null, failOn: "repo create" }).run }), /gh repo create failed/);
  assert.deepEqual(connectGithub("/x", { run: runner({ origin: null }).run }).created, true);
});

test("plan, apply and status: provider roles only, database first, AWS left to Terraform", async (t) => {
  const neon = fakeProvider("neon", ["database"]);
  const render = fakeProvider("render", ["api", "ssr"]);
  const registry = new ProviderRegistry().register(awsProvider).register(neon).register(render);
  const root = await project(t, { environments: { stage: { api: { provider: "render" }, ssr: { provider: "render" }, database: { provider: "neon" }, frontend: { provider: "aws" } } } });
  await saveCredential(root, "stage", "NEON_KEY", "n");
  const base = { root, environment: "stage", registry, env: { RENDER_KEY: "r", JWT_SECRET: "j" }, run: runner().run };
  const plans = await planDeployment(base);
  assert.deepEqual(plans.map((p) => [p.role, p.provider]), [["database", "neon"], ["api", "render"], ["ssr", "render"]]);
  const [, , source, variables, settings] = render.calls[0];
  assert.deepEqual([source.repository, source.branch, variables.JWT_SECRET, variables.RT_APP_TARGET, settings.region], ["acme/shop", "stage", "j", "portable", "us"]);
  const { results } = await applyDeployment({ ...base, roles: ["database", "api", "frontend"] });
  assert.deepEqual(results.map((r) => r.role), ["database", "api"]);
  assert.equal(render.calls.find((c) => c[0] === "plan" && c[3].DATABASE_URL)[3].DATABASE_URL, "postgres://db");
  const statuses = await deploymentStatus(base);
  assert.deepEqual(statuses.map((s) => [s.role, s.state]), [["api", "live"], ["ssr", "unknown"], ["frontend", "unknown"], ["database", "live"]]);
  assert.match(statuses[1].detail, /status endpoint down/);
  const missing = await deploymentStatus({ ...base, env: {} });
  assert.match(missing.find((s) => s.role === "api").detail, /Missing RENDER_KEY/);
  assert.deepEqual(await planDeployment({ ...base, environment: "prod" }), []);
  assert.deepEqual(await applyDeployment({ ...base, environment: "prod" }), { results: [], outputs: {} });
});

test("rta deploy: providers, credentials, plan, apply, status and usage errors", async (t) => {
  const render = fakeProvider("render", ["api"]);
  const registry = new ProviderRegistry().register(awsProvider).register(render);
  const root = await project(t, { environments: { stage: { api: { provider: "render" } } } });
  const lines = [];
  const io = { root, registry, env: {}, run: runner().run, out: (l) => lines.push(l), stdin: async () => "rnd_from_stdin\n" };
  await deployCommand(["providers"], io);
  assert.match(lines.at(-1), /^render\s+api\s+RENDER_KEY/);
  await deployCommand(["providers", "--json"], io);
  assert.equal(JSON.parse(lines.at(-1))[1].id, "render");
  await deployCommand(["credentials", "--env", "stage"], io);
  assert.equal(lines.at(-1), "render: RENDER_KEY ✗");
  await deployCommand(["credentials", "set", "--env", "stage", "RENDER_KEY"], io);
  assert.match(lines.at(-1), /Saved RENDER_KEY for stage/);
  assert.equal(lines.at(-1).includes("rnd_from_stdin"), false);
  await deployCommand(["credentials", "--env", "stage", "--json"], io);
  assert.equal(JSON.parse(lines.at(-1))[0].credentials[0].present, true);
  await deployCommand(["credentials", "--env", "prod"], io);
  assert.equal(lines.at(-1), "No providers configured for prod.");
  await deployCommand(["plan", "--env", "stage"], io);
  assert.match(lines.at(-1), /^api\s+render\s+create\s+shop-api — new$/);
  await deployCommand(["plan", "--env", "prod"], io);
  assert.match(lines.at(-1), /Nothing to plan for prod/);
  await deployCommand(["plan", "--env", "stage", "--json", "--role", "api"], io);
  assert.equal(JSON.parse(lines.at(-1))[0].provider, "render");
  await deployCommand(["apply", "--env", "stage"], io);
  assert.match(lines.at(-1), /^api\s+render\s+https:\/\/api.render$/);
  await deployCommand(["apply", "--env", "stage", "--json"], io);
  assert.equal(JSON.parse(lines.at(-1))[0].url, "https://api.render");
  await deployCommand(["apply", "--env", "develop"], io);
  assert.match(lines.at(-1), /Nothing to apply for develop/);
  await deployCommand(["status", "--env", "stage"], io);
  assert.match(lines.at(-1), /^api\s+render\s+live\s+https:\/\/api$/);
  await deployCommand(["status", "--env", "stage", "--json"], io);
  assert.equal(JSON.parse(lines.at(-1))[0].state, "live");
  for (const argv of [["plan"], ["plan", "--env", "qa"], ["plan", "--env", "stage", "--role", "email"], ["launch", "--env", "stage"], ["plan", "--force"], ["credentials", "set", "--env", "stage"]])
    await assert.rejects(deployCommand(argv, io), { message: DEPLOY_USAGE }, argv.join(" "));
  await assert.rejects(deployCommand(["credentials", "set", "--env", "stage", "KEY_Y"], { ...io, stdin: async () => "  " }), /Pipe the value through stdin/);
  await assert.rejects(deployCommand(["credentials", "set", "--env", "stage", "KEY_Y"], { ...io, stdin: undefined }), /Pipe the value/);
});

test("rta github: connect, sync and usage errors", async (t) => {
  const root = await project(t);
  const lines = [];
  const io = { root, env: { JWT_SECRET: "j" }, run: runner().run, out: (l) => lines.push(l) };
  await githubCommand(["connect"], io);
  assert.equal(lines.at(-1), "Already connected to acme/shop");
  await githubCommand(["connect", "--public", "--name", "acme/new-shop"], { ...io, run: runner({ origin: null }).run });
  assert.equal(lines.at(-1), "Created and pushed acme/new-shop");
  await githubCommand(["sync", "--env", "stage"], io);
  assert.deepEqual(lines.slice(-2), ["GitHub acme/shop:", "  stage: JWT_SECRET"]);
  await githubCommand(["sync", "--env", "prod"], { ...io, env: {} });
  assert.equal(lines.at(-1), "  prod: environment ready, no secrets yet");
  await githubCommand(["sync", "--json"], io);
  assert.equal(JSON.parse(lines.at(-1)).repository, "acme/shop");
  await assert.rejects(githubCommand(["publish"], io), { message: GITHUB_USAGE });
  await assert.rejects(githubCommand(["sync", "--env", "qa"], io), { message: GITHUB_USAGE });
});

test("CI secrets JSON becomes environment variables; explicit variables win", () => {
  assert.deepEqual(withCiSecrets({ A: "1" }), { A: "1" });
  const env = withCiSecrets({ RT_APP_SECRETS_JSON: JSON.stringify({ RENDER_KEY: "r", A: "from-json", github_token: "gh", NUM: 5 }), A: "explicit" });
  assert.deepEqual(env, { RENDER_KEY: "r", A: "explicit", RT_APP_SECRETS_JSON: undefined });
  assert.throws(() => withCiSecrets({ RT_APP_SECRETS_JSON: "{" }), /not valid JSON/);
});
