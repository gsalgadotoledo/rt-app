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
