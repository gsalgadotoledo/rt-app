import test from "node:test";
import assert from "node:assert/strict";
import {MemoryStore} from "@gsalgadotoledo/rt-app-dynamodb";
import {migrate,schemaMigration} from "@gsalgadotoledo/rt-app-contracts";
test("migration preflight rejects missing provider before running any migration", async () => {
  const store = new MemoryStore();
  let ran = false;
  const features = [
    {
      migrations: [
        {
          id: "one",
          checksum: "1",
          run: async () => {
            ran = true;
          },
        },
        {
          id: "two",
          checksum: "2",
          providers: { dynamodb: { checksum: "2", run: async () => {} } },
        },
      ],
    },
  ];
  await assert.rejects(migrate(store, features), /Unsupported migration two/);
  assert.equal(ran, false);
  assert.equal((await store.list("MIGRATIONS")).items.length, 0);
});

test("migration history records selected implementation and rejects checksum or engine drift", async () => {
  const store = new MemoryStore();
  const feature = { migrations: [schemaMigration("sample")] };
  await migrate(store, [feature]);
  await migrate(store, [feature]);
  const record = await store.get("MIGRATIONS", "sample:001");
  assert.equal(record.data.provider, "memory");
  assert.equal(record.data.checksum, "sample-document-v1");
  feature.migrations[0].providers.memory.checksum = "tampered";
  await assert.rejects(migrate(store, [feature]), /Migration changed/);
  feature.migrations[0] = schemaMigration("sample");
  Object.defineProperty(store, "provider", { value: "dynamodb" });
  await assert.rejects(migrate(store, [feature]), /Migration changed/);
});
