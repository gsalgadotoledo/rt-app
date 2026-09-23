import {passwordVerifier} from "@gsalgadotoledo/rt-app-myadmin/backend";
import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "@gsalgadotoledo/rt-app-dynamodb";
import { Infra, SimulatedInfraDriver } from "@gsalgadotoledo/rt-app-infra";
import { createApplication, seedDemo } from "@gsalgadotoledo/rt-app-framework";
import { LocalMailbox } from "@gsalgadotoledo/rt-app-auth";
const owner = { id: "owner", role: "owner" },
  user = { id: "user", role: "user" };
function setup(driver = new SimulatedInfraDriver()) {
  const store = new MemoryStore();
  return { store, infra: new Infra(store, driver) };
}
test("content settings, common manifests and authentication settings enforce ACL and versioning", async () => {
  const app = createApplication({
    adminPasswordVerifier:await passwordVerifier("Module-settings-2026!"),
    store: new MemoryStore(),
    mailer: new LocalMailbox(),
    secret: "test-secret".repeat(5),
  });
  await app.migrate();
  await seedDemo(app, "Module-settings-2026!");
  const call = (method, path, body = {}, token = "") =>
    app.handle({
      method,
      path,
      body,
      query: {},
      headers: token ? { authorization: `Bearer ${token}` } : {},
      ip: "local",
    });
  const ownerSession = (
    await call("POST", "/admin/identity/auth/login", {
      password: "Module-settings-2026!",
    })
  ).body;
  const ana = (
    await call("POST", "/auth/login", {
      email: "ana@example.test",
      password: "Module-settings-2026!",
    })
  ).body;
  assert.equal(
    (await call("GET", "/admin/app/infra/settings", {}, ana.token)).status,
    401,
  );
  assert.equal((await call("GET", "/admin/modules", {}, ana.token)).status, 401);
  assert.equal((await call("GET", "/aws/inventory")).status, 404);
  assert.equal((await call("GET", "/admin/app/aws/inventory")).status, 401);
  assert.equal((await call("GET", "/admin/app/aws/costs", {}, ana.token)).status, 401);
  const manifests = (
    await call("GET", "/admin/modules", {}, ownerSession.token)
  ).body;
  assert.ok(manifests.find((m) => m.id === "content").settings);
  assert.equal(manifests.find((m) => m.id === "users").group, "authentication");
  assert.equal(
    (
      await call(
        "PUT",
        "/admin/app/content/settings",
        {
          version: 0,
          values: { title: "Nuevo título", content: "Descripción editable" },
        },
        ana.token,
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await call(
        "PUT",
        "/admin/app/content/settings",
        {
          version: 0,
          values: { title: "Nuevo título", content: "Descripción editable" },
        },
        ownerSession.token,
      )
    ).status,
    200,
  );
  assert.deepEqual((await call("GET", "/")).body, {
    title: "Nuevo título",
    content: "Descripción editable",
  });
  assert.equal(
    (
      await call(
        "PUT",
        "/admin/app/content/settings",
        { version: 0, values: { title: "stale", content: "stale" } },
        ownerSession.token,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await call(
        "PUT",
        "/admin/app/auth/settings",
        { version: 0, values: { passwordLogin: false, emailCodeLogin: false } },
        ownerSession.token,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await call(
        "PUT",
        "/admin/app/auth/settings",
        { version: 0, values: { passwordLogin: true, emailCodeLogin: false } },
        ownerSession.token,
      )
    ).status,
    200,
  );
  assert.equal(
    (await call("POST", "/auth/code", { email: "ana@example.test" })).status,
    403,
  );
  assert.equal((await call("GET", "/auth/methods")).body.emailCodeLogin, false);
});
