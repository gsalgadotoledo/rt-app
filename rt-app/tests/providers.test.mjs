import test from "node:test";
import assert from "node:assert/strict";
import {NoSQLRegistry} from "@gsalgadotoledo/rt-app-nosql";
import {InfraRegistry,SimulatedInfraDriver} from "@gsalgadotoledo/rt-app-infra";
import {MemoryStore} from "@gsalgadotoledo/rt-app-dynamodb";
test("provider registries reject unsupported, duplicate and incompatible adapters", () => {
  const registry = new NoSQLRegistry().register(
    "memory",
    () => new MemoryStore(),
  );
  assert.equal(registry.connect("memory", {}).provider, "memory");
  assert.throws(() => registry.connect("firestore", {}), /Unsupported/);
  assert.throws(
    () => registry.register("memory", () => new MemoryStore()),
    /Duplicate/,
  );
  const invalid = new NoSQLRegistry().register("bad", () => ({
    provider: "bad",
    capabilities: {},
  }));
  assert.throws(() => invalid.connect("bad", {}), /contract/);
  const infra = new InfraRegistry().register(
    "local",
    () => new SimulatedInfraDriver(),
  );
  assert.equal(infra.connect("local").simulation, true);
  assert.throws(() => infra.connect("azure"), /Unsupported/);
});
