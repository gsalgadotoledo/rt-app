import test from "node:test";
import assert from "node:assert/strict";
import {
  RTAppIdempotencyModule,
  RTAppIdempotentModule,
} from "../dist/index.js";

test("optional base delegates the request and fails explicitly without an executor", async () => {
  class Payments extends RTAppIdempotentModule {
    charge(request) {
      return this.executeIdempotent(request, async ({ input }) => input);
    }
  }
  const module = new Payments();
  const request = {
    scope: "payments:user:v1",
    key: "order",
    input: { amount: 1 },
  };
  await assert.rejects(module.charge(request), { code: "NOT_CONFIGURED" });
  module.idempotency = {
    execute: async (received, work) => {
      assert.equal(received, request);
      return work({ input: received.input, idempotencyKey: "stable" });
    },
  };
  assert.deepEqual(await module.charge(request), { amount: 1 });
});

test("invalid JSON/key input cannot claim a payment; uncertain acknowledgments cannot rerun it", async () => {
  const module = new RTAppIdempotencyModule();
  assert.throws(() => module.init(), { code: "NOT_CONFIGURED" });
  await assert.rejects(
    module.execute({}, async () => null),
    { code: "NOT_CONFIGURED" },
  );
  let claims = 0;
  module.store = {
    claim: async () => {
      claims++;
      return { state: "acquired" };
    },
    complete: async () => {
      throw Error("ack lost");
    },
    markUncertain: async () => {
      throw Error("offline");
    },
  };
  module.init();
  const request = { scope: "payment", key: "order", input: {} };
  for (const patch of [
    { scope: "" },
    { scope: "x".repeat(513) },
    { key: " " },
    { key: "x".repeat(257) },
  ])
    await assert.rejects(
      module.execute({ ...request, ...patch }, async () => null),
      { code: "INVALID_KEY" },
    );
  const cyclic = {};
  cyclic.self = cyclic;
  const getter = Object.defineProperty({}, "value", {
    enumerable: true,
    get() {
      throw Error("must not execute");
    },
  });
  const hidden = Object.defineProperty({}, "hidden", { value: 1 });
  for (const input of [
    NaN,
    undefined,
    new Date(),
    cyclic,
    getter,
    hidden,
    { [Symbol("x")]: 1 },
    Array(2),
  ]) {
    await assert.rejects(
      module.execute({ ...request, input }, async () => null),
      { code: "INVALID_JSON" },
    );
  }
  assert.equal(claims, 0);
  await assert.rejects(
    module.execute(request, async () => ({ paid: true })),
    { code: "UNCERTAIN" },
  );
  for (const state of ["pending", "uncertain", "conflict"]) {
    module.store.claim = async () => ({ state });
    await assert.rejects(
      module.execute(request, async () => assert.fail("must not charge")),
      { code: state.toUpperCase() },
    );
  }
});
