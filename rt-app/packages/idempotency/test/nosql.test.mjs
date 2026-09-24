import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "@gsalgadotoledo/rt-app-dynamodb";
import { createIdempotency, NoSQLIdempotencyStore } from "../dist/index.js";

test("separate executors share durable replay, conflict and pending claims", async () => {
  const store = new MemoryStore(),
    a = createIdempotency(store),
    b = createIdempotency(store);
  const request = {
    scope: "tenant/orders/v1",
    key: "order1",
    input: { amount: 10 },
  };
  let calls = 0,
    release;
  const gate = new Promise((resolve) => (release = resolve));
  const first = a.execute(request, async () => {
    calls++;
    await gate;
    return { id: "paid" };
  });
  while (!calls) await new Promise((resolve) => setTimeout(resolve, 1));
  await assert.rejects(
    b.execute(request, async () => null),
    { code: "PENDING" },
  );
  release();
  assert.deepEqual(await first, { id: "paid" });
  assert.deepEqual(
    await b.execute(request, async () => {
      calls++;
      return null;
    }),
    { id: "paid" },
  );
  assert.equal(calls, 1);
  await assert.rejects(
    b.execute({ ...request, input: { amount: 11 } }, async () => null),
    { code: "CONFLICT" },
  );
  await assert.rejects(
    a.execute({ ...request, key: "failed" }, async () => {
      throw Error("lost acknowledgement");
    }),
    { code: "UNCERTAIN" },
  );
  await assert.rejects(
    b.execute({ ...request, key: "failed" }, async () => null),
    { code: "UNCERTAIN" },
  );
});

test("only owner can complete, and uncertain never overwrites completion", async () => {
  const adapter = new NoSQLIdempotencyStore(new MemoryStore());
  const claim = { scope: "s", key: "k", fingerprint: "f", owner: "a" };
  await adapter.claim(claim);
  await assert.rejects(adapter.complete({ ...claim, owner: "b" }, null));
  await adapter.complete(claim, { ok: true });
  await adapter.markUncertain(claim);
  assert.deepEqual(await adapter.claim(claim), {
    state: "completed",
    result: { ok: true },
  });
  await assert.rejects(adapter.complete({ ...claim, key: "missing" }, null));
  await assert.rejects(
    adapter.complete({ ...claim, fingerprint: "bad" }, null),
  );
  const broken = new NoSQLIdempotencyStore({
    transact: async () => {
      throw Error("offline");
    },
  });
  await assert.rejects(broken.claim(claim), /offline/);
});

test('a vanished conflicting row fails closed', async () => {
  const { Conflict } = await import('@gsalgadotoledo/rt-app-contracts');
  const adapter = new NoSQLIdempotencyStore({transact: async () => {throw new Conflict();}, get: async () => undefined});
  await assert.rejects(adapter.claim({scope:'s',key:'k',owner:'o',fingerprint:'f'}), Conflict);
});
