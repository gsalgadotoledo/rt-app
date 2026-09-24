import test from "node:test";
import assert from "node:assert/strict";
import { NoSQLRegistry, requiredCapabilities } from "../dist/index.js";

test("explicit adapter registration is lazy and rejects missing persistence guarantees", () => {
  let calls = 0;
  const registry = new NoSQLRegistry();
  const store = { provider: "test", capabilities: { ...requiredCapabilities } };
  registry.register("test", (config) => {
    calls++;
    assert.equal(config.table, "example");
    return store;
  });
  assert.equal(calls, 0);
  assert.equal(registry.connect("test", { table: "example" }), store);
  assert.equal(calls, 1);
  assert.throws(() => registry.register("test", () => store), /Duplicate/);
  assert.throws(() => registry.connect("unknown", {}), /Unsupported/);
  for (const invalid of [
    { provider: "other", capabilities: requiredCapabilities },
    { provider: "test" },
    ...Object.keys(requiredCapabilities).map((key) => ({
      provider: "test",
      capabilities: { ...requiredCapabilities, [key]: false },
    })),
  ]) {
    const bad = new NoSQLRegistry().register("test", () => invalid);
    assert.throws(() => bad.connect("test", {}), /contract/);
  }
});
