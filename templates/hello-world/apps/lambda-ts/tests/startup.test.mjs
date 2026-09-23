import test from "node:test";
import assert from "node:assert/strict";
import { createLambdaHandler } from "../dist/index.js";
test("Lambda shares initialization across warm requests and retries a failed startup", async () => {
  let starts = 0;
  const handler = createLambdaHandler(async () => {
    starts++;
    if (starts === 1) throw new Error("temporary secret store failure");
    return { handle: async () => ({ status: 200, body: { ok: true } }) };
  });
  const event = {
    requestContext: { http: { method: "GET", sourceIp: "127.0.0.1" } },
    rawPath: "/",
  };
  assert.equal((await handler(event)).statusCode, 503);
  const responses = await Promise.all([
    handler(event),
    handler(event),
    handler(event),
  ]);
  assert.ok(responses.every((r) => r.statusCode === 200));
  assert.equal(starts, 2);
});
