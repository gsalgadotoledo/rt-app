import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "@gsalgadotoledo/rt-app-dynamodb";
import { LocalMailbox } from "@gsalgadotoledo/rt-app-auth";
import { createApplication } from "@gsalgadotoledo/rt-app-framework";

const secret = "test-secret-".repeat(5);
const token = "rtsk_agent.envsecret-envsecret-envsecret-0123";

function setup(options = {}) {
  const app = createApplication({
    store: new MemoryStore(),
    mailer: new LocalMailbox(),
    secret,
    serviceKeys: [{ id: "agent", secret: "envsecret-envsecret-envsecret-0123", scopes: ["subscriptions.meter"] }],
    ...options,
  });
  const call = (method, path, body = {}, authorization) =>
    app.handle({ method, path, body, query: {}, headers: authorization ? { authorization } : {}, ip: "test" });
  return { app, call };
}

test("a service key meters accounts but never reaches the admin or user endpoints", async () => {
  const { app, call } = setup();
  await app.migrate();
  const bearer = "Bearer " + token;
  assert.deepEqual((await call("GET", "/service/subscriptions/accounts/u1/usage", {}, bearer)).body.userId, "u1");
  assert.equal((await call("GET", "/service/subscriptions/accounts/u1/usage")).status, 401);
  assert.deepEqual((await call("GET", "/service/keys/self", {}, bearer)).body, { error: "Service key not allowed for this resource" });
  // The same header is not an admin root session nor a user session.
  assert.equal((await call("GET", "/admin/app/subscriptions/admin/accounts/u1/usage", {}, bearer)).status, 401);
  assert.equal((await call("GET", "/admin/app/service-keys", {}, bearer)).status, 401);
  assert.equal((await call("GET", "/users/me", {}, bearer)).status, 401);
  assert.equal((await call("GET", "/service-keys", {}, bearer)).status, 404);
  // Scopes come from the service endpoints, sorted.
  assert.deepEqual(app.serviceKeys.scopes(), ["service-keys.self", "subscriptions.meter"]);
});

test("the admin manages keys under /admin/app and the application refuses bad configurations", async () => {
  const { call } = setup({ localAdminAccess: true });
  const created = await call("POST", "/admin/app/service-keys", { id: "managed", description: "Managed", scopes: ["service-keys.self"] });
  assert.equal(created.status, 200);
  const self = await call("GET", "/service/keys/self", {}, "Bearer " + created.body.token);
  assert.deepEqual(self.body, { id: "managed", description: "Managed", scopes: ["service-keys.self"], rateLimit: 600 });
  assert.equal((await call("GET", "/admin/modules")).body.some((m) => m.module === "service-keys"), true);
  assert.throws(() => setup({ serviceKeys: [{ id: "bad" }] }), { message: "Invalid service key configuration" });
  const misplaced = { id: "x", endpoints: [{ method: "GET", path: "/service/x", resource: "x", access: "owner", handle: async () => 1 }] };
  assert.throws(() => setup({ features: [misplaced] }), /Service endpoints must use \/service\/ paths/);
  const outside = { id: "y", endpoints: [{ method: "GET", path: "/y", resource: "y", access: "service", handle: async () => 1 }] };
  assert.throws(() => setup({ features: [outside] }), /Service endpoints must use \/service\/ paths/);
});

test("without explicit keys the application reads RT_APP_SERVICE_KEYS", async (t) => {
  const previous = process.env.RT_APP_SERVICE_KEYS;
  t.after(() => {
    if (previous === undefined) delete process.env.RT_APP_SERVICE_KEYS;
    else process.env.RT_APP_SERVICE_KEYS = previous;
  });
  process.env.RT_APP_SERVICE_KEYS = JSON.stringify([{ id: "agent", secret: "envsecret-envsecret-envsecret-0123", scopes: ["subscriptions.meter"] }]);
  const { call } = setup({ serviceKeys: undefined });
  assert.equal((await call("GET", "/service/subscriptions/accounts/u1/usage", {}, "Bearer " + token)).status, 200);
});
