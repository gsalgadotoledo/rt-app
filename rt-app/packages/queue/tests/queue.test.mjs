import { test } from "node:test";
import assert from "node:assert/strict";
import { Queue, MemoryQueue, validateMessage } from "../dist/index.js";
const message = () => ({
  id: "job1",
  type: "email",
  payload: { text: "test" },
  createdAt: new Date().toISOString(),
});
test("bounded claims, lease expiry, delayed retry and poison messages", async () => {
  let now = 0;
  const adapter = new MemoryQueue(2, 10, () => now),
    queue = new Queue(adapter);
  assert.equal(
    await queue.send("email", { a: 1 }, { id: "id", traceId: "trace" }),
    "id",
  );
  await queue.send("email", {});
  await assert.rejects(queue.send("email", {}), /capacity/);
  const [first] = await adapter.receive(1);
  assert.equal(first.attempts, 1);
  await first.extend(20);
  now = 10001;
  const [second] = await adapter.receive(2);
  await second.ack();
  await assert.rejects(second.ack(), /Stale/);
  now = 20001;
  const [reclaimed] = await adapter.receive(1);
  await assert.rejects(first.ack(), /Stale/);
  assert.equal(reclaimed.attempts, 2);
  await reclaimed.retry(2);
  assert.equal((await adapter.receive(1)).length, 0);
  now += 2001;
  await queue.workOnce(
    async () => {
      throw Error("poison");
    },
    { maxAttempts: 3 },
  );
  assert.equal(adapter.deadLetters().length, 1);
});
test("worker retries then acknowledges, applies concurrency and drains", async () => {
  const a = new MemoryQueue(),
    q = new Queue(a);
  await q.send("x", {});
  let calls = 0;
  await q.workOnce(
    async () => {
      calls++;
      throw Error("retry");
    },
    { baseDelaySeconds: 0, maxDelaySeconds: 0 },
  );
  await q.workOnce(async () => {
    calls++;
  });
  assert.equal(calls, 2);
  let release;
  const gate = new Promise((r) => (release = r));
  await q.send("x", {});
  const work = q.workOnce(async () => gate);
  await assert.rejects(
    q.workOnce(async () => {}),
    /already/,
  );
  release();
  await work;
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 5);
  await q.run(async () => {}, { idleMs: 1 }, abort.signal);
  const stop = new AbortController();
  await q.send("x", {});
  await q.run(async () => stop.abort(), {}, stop.signal);
  await assert.rejects(q.workOnce(async () => {}, {}, AbortSignal.abort()));
});
test("validation, broker failures and failed acknowledgements stay visible", async () => {
  for (const bad of [
    null,
    { ...message(), id: "" },
    { ...message(), createdAt: "no" },
    { ...message(), traceId: 5 },
    { ...message(), payload: "x".repeat(240001) },
  ])
    assert.throws(() => validateMessage(bad));
  assert.throws(() => new MemoryQueue(0));
  const a = new MemoryQueue(1),
    q = new Queue(a);
  await assert.rejects(a.receive(0));
  await assert.rejects(a.receive(1, AbortSignal.abort()));
  for (const opts of [
    { concurrency: 11 },
    { maxAttempts: 0 },
    { baseDelaySeconds: 10, maxDelaySeconds: 1 },
  ])
    await assert.rejects(q.workOnce(async () => {}, opts));
  await assert.rejects(
    q.run(async () => {}, { idleMs: 0 }, new AbortController().signal),
  );
  await a.publish(message());
  const [d] = await a.receive(1);
  await assert.rejects(d.retry(-1));
  await d.deadLetter();
  await a.publish(message());
  await assert.rejects(
    q.workOnce(
      async () => {
        throw Error();
      },
      { maxAttempts: 1 },
    ),
    AggregateError,
  );
  const broken = new Queue({
    capabilities: { delayedRetry: false },
    publish: async () => {},
    receive: async () => [
      {
        attempts: 1,
        ack: async () => {
          throw Error("ack");
        },
        retry: async (delay) => {
          assert.equal(delay, 0);
        },
      },
    ],
  });
  await broken.workOnce(async () => {
    throw Error();
  });
  await assert.rejects(
    broken.workOnce(async () => {}),
    AggregateError,
  );
  await assert.rejects(
    broken.run(async () => {}, {}, new AbortController().signal),
  );
});
