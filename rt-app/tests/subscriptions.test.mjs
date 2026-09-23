import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "@gsalgadotoledo/rt-app-dynamodb";
import { LocalMailbox } from "@gsalgadotoledo/rt-app-auth";
import { createApplication, seedDemo } from "../dist/index.js";
test("metered endpoint enforces access before work, requires keys, and does not execute a replay", async () => {
  let work = 0;
  const app = createApplication({
    store: new MemoryStore(),
    mailer: new LocalMailbox(),
    secret: "test".repeat(12),
    features: [
      {
        id: "metered-test",
        migrations: [],
        endpoints: [
          {
            method: "POST",
            path: "/metered-test",
            access: "authenticated",
            resource: "metered.run",
            subscription: { product: "api", credits: 10 },
            handle: () => ({ work: ++work }),
          },
        ],
      },
    ],
  });
  await app.migrate();
  await seedDemo(app, "Demo-password-only-2026!");
  let token = "";
  const call = (path, body = {}, key) =>
    app.handle({
      method: "POST",
      path,
      body,
      query: {},
      headers: {
        authorization: token ? "Bearer " + token : undefined,
        "idempotency-key": key,
      },
      ip: "test-meter",
    });
  assert.equal((await call("/metered-test", {}, "one")).status, 401);
  token = (
    await call("/auth/login", {
      email: "ana@example.test",
      password: "Demo-password-only-2026!",
    })
  ).body.token;
  assert.ok(token);
  assert.equal((await call("/metered-test", {}, "one")).status, 402);
  assert.equal(work, 0);
  assert.equal(
    (
      await call("/subscriptions/change", {
        planId: "starter",
        requestId: "plan",
      })
    ).status,
    200,
  );
  assert.equal((await call("/metered-test")).status, 400);
  assert.equal((await call("/metered-test", {}, "one")).status, 200);
  assert.equal((await call("/metered-test", {}, "one")).status, 409);
  assert.equal(work, 1);
  assert.equal(
    (
      await app.handle({
        method: "GET",
        path: "/subscriptions/admin/accounts",
        query: {},
        body: {},
        headers: { authorization: "Bearer " + token },
        ip: "test",
      })
    ).status,
    404,
  );
});
