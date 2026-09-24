import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "@gsalgadotoledo/rt-app-dynamodb";
import { schemaMigration } from "@gsalgadotoledo/rt-app-contracts";

// The runner and its guarantees are tested in @gsalgadotoledo/rt-app-migrations.
test("schemaMigration keeps its permanent id/checksum and is idempotent", async () => {
  const store = new MemoryStore();
  const migration = schemaMigration("sample");
  assert.equal(migration.id, "sample:001");
  assert.equal(migration.checksum, "sample-document-v1");
  assert.equal(migration.providers, undefined, "one generic step for every engine");
  await migration.up({ store });
  await migration.up({ store });
  assert.deepEqual((await store.get("SCHEMA", "sample")).data, { schemaVersion: 1 });
});
