import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "@gsalgadotoledo/rt-app-dynamodb";
import { LocalMailbox } from "@gsalgadotoledo/rt-app-auth";
import { createApplication, seedDemo } from "@gsalgadotoledo/rt-app-framework";
import { JwtTokens } from "@gsalgadotoledo/rt-app-jwt";
const password = "Demo-password-only-2026!";
async function setup(tasks = true) {
  const store = new MemoryStore(),
    mail = new LocalMailbox(),
    secret = "test-secret-".repeat(5);
  const app = createApplication({ store, mailer: mail, secret, tasks });
  await app.migrate();
  await seedDemo(app, password);
  let ip = 0;
  const call = (method, path, body = {}, token = "", query = {}) =>
    app.handle({
      method,
      path,
      body,
      query,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      ip: `test-${++ip}`,
    });
  const login = async (email) => {
    const r = await call("POST", "/auth/login", { email, password });
    assert.equal(r.status, 200);
    return r.body;
  };
  return { app, store, mail, call, login, secret };
}
test("Lambda adapter reuses composition and handles API Gateway bodies", async () => {
  const { app } = await setup();
  const { createLambdaHandler } = await import("../dist/index.js");
  let starts = 0;
  const handler = createLambdaHandler(() => {
    starts++;
    return app;
  });
  const event = {
    rawPath: "/",
    requestContext: { http: { method: "GET", sourceIp: "local" } },
    headers: {},
  };
  assert.equal((await handler(event)).statusCode, 200);
  assert.equal((await handler(event)).statusCode, 200);
  assert.equal(starts, 1);
  assert.equal((await handler({ ...event, body: "{" })).statusCode, 400);
  const login = await handler({
    ...event,
    rawPath: "/auth/login",
    requestContext: { http: { method: "POST", sourceIp: "local" } },
    isBase64Encoded: true,
    body: Buffer.from(
      JSON.stringify({ email: "ana@example.test", password }),
    ).toString("base64"),
  });
  assert.equal(login.statusCode, 200);
  assert.ok(JSON.parse(login.body).token);
  assert.equal(
    (await handler({ ...event, body: " ".repeat(20000) })).statusCode,
    413,
  );
});
