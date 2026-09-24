import test from "node:test";
import assert from "node:assert/strict";
import { Queue, MemoryQueue, FailureTokens } from "../dist/index.js";
const msg = {
  id: "job",
  type: "payment",
  payload: { order: 1 },
  createdAt: new Date().toISOString(),
};
const call = (feature, path, body) =>
  feature.endpoints.find((e) => e.path === path).handle({ request: { body } });

test("local failed message inspection and atomic manual retry preserve IDs and reject duplicate retries", async () => {
  const adapter = new MemoryQueue(1),
    queue = new Queue(adapter);
  await adapter.publish(msg);
  await queue.workOnce(
    async () => {
      throw Error("fail");
    },
    { maxAttempts: 1 },
  );
  const feature = queue.feature();
  assert.equal(feature.admin.ownerOnly, true);
  assert.ok(feature.endpoints.every((e) => e.access === "owner"));
  assert.equal((await call(feature, "/queue/status")).supported, true);
  const { items } = await call(feature, "/queue/failed/inspect", {});
  assert.equal(items[0].id, "job");
  items[0].message.payload.order = 99;
  assert.equal(adapter.deadLetters()[0].payload.order, 1);
  await adapter.publish({ ...msg, id: "other" });
  await assert.rejects(adapter.retryFailure(items[0].token), /capacity/);
  assert.equal(adapter.deadLetters().length, 1);
  await (await adapter.receive(1))[0].ack();
  const replies = await Promise.allSettled([
    call(feature, "/queue/failed/retry", { token: items[0].token }),
    adapter.retryFailure(items[0].token),
  ]);
  assert.equal(replies.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(adapter.deadLetters().length, 0);
  const [delivery] = await adapter.receive(1);
  assert.equal(delivery.message.id, "job");
  assert.equal(delivery.attempts, 1);
  assert.deepEqual(await adapter.inspectFailures(1), []);
  await assert.rejects(
    call(feature, "/queue/failed/inspect", { limit: 11 }),
    (e) => e.status === 400,
  );
  await assert.rejects(adapter.inspectFailures(0), (e) => e.status === 400);
  for (const body of [
    undefined,
    {},
    { token: "" },
    { token: "x".repeat(400001) },
  ])
    await assert.rejects(
      call(feature, "/queue/failed/retry", body),
      (e) => e.status === 400,
    );
  const unsupported = new Queue({
    capabilities: {},
    publish: async () => {},
    receive: async () => [],
  }).feature();
  assert.equal((await call(unsupported, "/queue/status")).supported, false);
  await assert.rejects(
    call(unsupported, "/queue/failed/inspect", {}),
    (e) => e.status === 501,
  );
  await assert.rejects(
    call(unsupported, "/queue/failed/retry", {}),
    (e) => e.status === 501,
  );
  const missing = new Queue({ capabilities: { failedAdmin: true } }).feature();
  await assert.rejects(call(missing, "/queue/failed/inspect", {}));
  await assert.rejects(call(missing, "/queue/failed/retry", {}));
});

test("sealed broker receipts reject tampering, foreign queues, expired and oversized tokens", () => {
  let now = 10;
  const secret = "a".repeat(32),
    tokens = new FailureTokens(secret, "queue", () => now);
  assert.throws(() => new FailureTokens("short", "queue"));
  const token = tokens.seal({ receipt: "private" }, 20);
  assert.doesNotMatch(token, /private/);
  assert.deepEqual(tokens.open(token), { receipt: "private" });
  for (const invalid of [
    "garbage",
    "x".repeat(400001),
    null,
    token.slice(0, -10) + "abcdefghij",
  ])
    assert.throws(
      () => tokens.open(invalid),
      (e) => e.status === 409,
    );
  assert.throws(() =>
    new FailureTokens(secret, "other", () => now).open(token),
  );
  assert.throws(() => tokens.open(tokens.seal({}, NaN)));
  now = 20;
  assert.throws(
    () => tokens.open(token),
    (e) => e.status === 409,
  );
  const clock = new FailureTokens(secret, "queue");
  assert.deepEqual(clock.open(clock.seal({}, Date.now() + 1000)), {});
});
