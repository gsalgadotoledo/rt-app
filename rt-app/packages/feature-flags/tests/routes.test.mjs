import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "@gsalgadotoledo/rt-app-dynamodb";
import { FeatureFlags } from "../dist/index.js";

test("admin routes record the actor, deduplicate targeting and validate revision and public requests", async () => {
  const flags = new FeatureFlags(new MemoryStore());
  const [list, save, evaluate] = flags.feature().endpoints;
  const definition = {
    description: "Checkout",
    enabled: true,
    public: true,
    rollout: 0,
    subjects: ["vip", "vip"],
  };
  const result = await save.handle({
    params: { key: "checkout" },
    actor: { id: "root" },
    request: { body: { ...definition, version: null } },
  });
  assert.equal(result.updatedBy, "root");
  assert.deepEqual(result.subjects, ["vip"]);
  assert.equal((await list.handle({ request: { query: {} } })).items.length, 1);
  assert.equal(await flags.enabled("checkout"), false);
  assert.equal(await flags.enabled("checkout", "other"), false);
  assert.equal(await flags.enabled("checkout", "vip"), true);
  await assert.rejects(flags.enabled("checkout", "x".repeat(121)), {
    status: 400,
  });
  for (const keys of [null, ["x", 1], Array(21).fill("x")])
    await assert.rejects(evaluate.handle({ request: { body: { keys } } }), {
      status: 400,
    });
  for (const patch of [
    { description: 1 },
    { enabled: "true" },
    { public: null },
    { rollout: NaN },
    { subjects: [1] },
    { subjects: ["x".repeat(121)] },
  ]) {
    await assert.rejects(
      flags.save("new", { ...definition, ...patch }, null, "root"),
      { status: 400 },
    );
  }
  await assert.rejects(flags.save("new", definition, 0, "root"), {
    status: 400,
  });
});
