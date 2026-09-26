import test from "node:test";
import assert from "node:assert/strict";
import { createLambdaHandler } from "../dist/index.js";
test("Lambda preserves original webhook bytes, normalizes signature and routes maintenance internally", async () => {
  let seen,
    maintenance = 0;
  const handler = createLambdaHandler(() => ({
    handle: async (request) => {
      seen = request;
      return { status: 200, body: { ok: true } };
    },
    subscriptions: { maintenance: async () => ({ processed: ++maintenance }) },
    // Like the real application: the webhook endpoint declares a 256 KiB body limit.
    bodyLimit: (method, path) => (path === "/subscriptions/webhook" ? 262144 : 16384),
  }));
  const raw = '{ "message" : "café", "padding":"' + "x".repeat(20000) + '"}';
  const response = await handler({
    rawPath: "/subscriptions/webhook",
    requestContext: { http: { method: "POST", sourceIp: "test" } },
    headers: { "Stripe-Signature": "signature" },
    body: Buffer.from(raw).toString("base64"),
    isBase64Encoded: true,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(seen.rawBody, raw);
  assert.equal(seen.headers["stripe-signature"], "signature");
  assert.deepEqual(await handler({ source: "rt-app.subscriptions" }), {
    processed: 1,
  });
});

test("Lambda rejects bodies above the endpoint limit before calling the application", async () => {
  let called = false;
  const handler = createLambdaHandler(() => ({ handle: async () => { called = true; return { status: 200, body: {} }; }, bodyLimit: () => 10 }));
  const response = await handler({ rawPath: "/items", requestContext: { http: { method: "POST", sourceIp: "t" } }, headers: {}, body: '{"too":"large"}' });
  assert.equal(response.statusCode, 413);
  assert.equal(called, false);
});
