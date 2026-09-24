import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderRegistry } from "@gsalgadotoledo/rt-app-deploy";
import { awsProvider, readCredentials } from "@gsalgadotoledo/rt-app-deployments";
import { handleDeployRequest } from "@gsalgadotoledo/rt-app-deployments/server";

const render = {
  id: "render", name: "Render", roles: ["api"], website: "https://render.com",
  credentials: [{ key: "RENDER_API_KEY", label: "API key" }],
  plan: async (c) => ({ provider: "render", role: c.role, environment: c.environment, actions: [{ action: "create", resource: "svc", detail: "new" }] }),
  apply: async (c) => ({ provider: "render", role: c.role, url: "https://api.onrender.com", resources: [{ kind: "service", id: "srv-1", name: "svc" }], outputs: { SECRET_OUT: "hidden-value" } }),
  status: async () => ({ state: "live", url: "https://api.onrender.com" }),
};

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "rt-deploy-server-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "rt-app.settings.json"), JSON.stringify({ version: 1, project: { name: "shop" } }));
  const run = (command, args) => (command === "git" ? { status: 0, stdout: "git@github.com:acme/shop.git", stderr: "" } : { status: 0, stdout: "", stderr: "" });
  const options = { root, run, registry: new ProviderRegistry().register(awsProvider).register(render), passwordVerifier: async (p) => "verifier:" + p.length };
  const call = (method, path, body = {}, query = {}) => handleDeployRequest({ method, path, body, query }, options);
  return { root, call, options };
}

test("overview, settings, credentials and generated secrets without exposing values", async (t) => {
  const { root, call } = await setup(t);
  let r = await call("GET", "/__dev/deploy");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.providers.map((p) => p.id), ["aws", "render"]);
  assert.equal(r.body.repository, "acme/shop");
  assert.deepEqual(r.body.environments.map((e) => e.branch), ["develop", "stage", "main"]);
  r = await call("PUT", "/__dev/deploy", { deploy: { environments: { stage: { api: { provider: "render" } } } } });
  assert.deepEqual(r.body.deploy.environments.stage.api, { provider: "render" });
  assert.equal((await call("PUT", "/__dev/deploy", { deploy: { environments: { stage: { api: { provider: "nope" } } } } })).status, 400);
  assert.equal((await call("PUT", "/__dev/deploy/credentials", { environment: "stage", key: "RENDER_API_KEY", value: "rnd_live_secret" })).status, 200);
  assert.equal((await call("POST", "/__dev/deploy/generate", { environment: "stage", key: "JWT_SECRET" })).status, 200);
  assert.equal((await call("POST", "/__dev/deploy/generate", { environment: "stage", key: "ADMIN_PASSWORD_VERIFIER", password: "Admin-password-2026" })).status, 200);
  assert.match((await call("POST", "/__dev/deploy/generate", { environment: "stage", key: "ADMIN_PASSWORD_VERIFIER", password: "short" })).body.error, /12 to 128/);
  assert.match((await call("POST", "/__dev/deploy/generate", { environment: "stage", key: "SMTP_URL" })).body.error, /Only JWT_SECRET/);
  assert.equal((await call("PUT", "/__dev/deploy/credentials", { environment: "qa", key: "X", value: "y" })).status, 400);
  const stored = (await readCredentials(root)).stage;
  assert.equal(stored.JWT_SECRET.length, 96);
  assert.equal(stored.ADMIN_PASSWORD_VERIFIER, "verifier:19");
  r = await call("GET", "/__dev/deploy");
  const text = JSON.stringify(r.body);
  assert.equal(text.includes("rnd_live_secret") || text.includes(stored.JWT_SECRET), false, "no values in responses");
  assert.deepEqual(r.body.credentials.stage[0].credentials[0].present, true);
  assert.deepEqual(r.body.runtime.stage.filter((s) => s.present).map((s) => s.key), ["JWT_SECRET", "ADMIN_PASSWORD_VERIFIER"]);
});

test("plan, apply, status and GitHub sync; outputs never leave the server", async (t) => {
  const { call } = await setup(t);
  await call("PUT", "/__dev/deploy", { deploy: { environments: { stage: { api: { provider: "render" } } } } });
  assert.match((await call("POST", "/__dev/deploy/plan", { environment: "stage" })).body.error, /Missing credentials: render:RENDER_API_KEY/);
  await call("PUT", "/__dev/deploy/credentials", { environment: "stage", key: "RENDER_API_KEY", value: "rnd_live_secret" });
  assert.equal((await call("POST", "/__dev/deploy/plan", { environment: "stage" })).body.plans[0].actions[0].action, "create");
  const applied = await call("POST", "/__dev/deploy/apply", { environment: "stage" });
  assert.deepEqual(applied.body.results, [{ provider: "render", role: "api", url: "https://api.onrender.com", resources: [{ kind: "service", id: "srv-1", name: "svc" }] }]);
  assert.equal(JSON.stringify(applied.body).includes("hidden-value"), false);
  assert.equal((await call("GET", "/__dev/deploy/status", {}, { environment: "stage" })).body.statuses[0].state, "live");
  assert.equal((await call("GET", "/__dev/deploy/status", {}, { environment: "nope" })).status, 400);
  const synced = await call("POST", "/__dev/deploy/github", { environment: "stage" });
  assert.deepEqual(synced.body, { repository: "acme/shop", secrets: { stage: ["RENDER_API_KEY"] } });
  assert.equal((await call("POST", "/__dev/deploy/github", {})).status, 200);
  assert.equal((await call("DELETE", "/__dev/deploy")).status, 404);
});

test("admin password generation needs the hashing function", async (t) => {
  const { root, options } = await setup(t);
  const r = await handleDeployRequest({ method: "POST", path: "/__dev/deploy/generate", body: { environment: "prod", key: "ADMIN_PASSWORD_VERIFIER", password: "Admin-password-2026" }, query: {} }, { ...options, passwordVerifier: undefined });
  assert.deepEqual([r.status, r.body.error], [400, "Password hashing is not available"]);
  assert.deepEqual(await readCredentials(root), {});
});
