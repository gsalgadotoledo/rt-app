import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "@gsalgadotoledo/rt-app-dynamodb";
import { JsonStore } from "@gsalgadotoledo/rt-app-json";
import { schemaMigration } from "@gsalgadotoledo/rt-app-contracts";
import {
  MigrationRunner,
  MigrationLockedError,
  migrate,
  createContext,
} from "@gsalgadotoledo/rt-app-migrations";

// Catalog module used across tests: one engine-agnostic data migration with a reversible step.
function catalog(calls = []) {
  return {
    id: "catalog",
    endpoints: [],
    migrations: [
      schemaMigration("catalog"),
      {
        id: "catalog:002",
        checksum: "catalog-currencies-v1",
        description: "Add supported currencies",
        up: async ({ ensureRows }) => {
          calls.push("up");
          await ensureRows([
            { pk: "CURRENCY", sk: "USD", data: { code: "USD" } },
            { pk: "CURRENCY", sk: "EUR", data: { code: "EUR" } },
          ]);
        },
        down: async ({ store }) => {
          calls.push("down");
          for (const sk of ["USD", "EUR"]) {
            const row = await store.get("CURRENCY", sk);
            if (row) await store.transact([{ row, expected: row.version, delete: true }]);
          }
        },
      },
    ],
  };
}

const ids = async (store, pk) => (await store.list(pk)).items.map(row => row.sk).sort();

test("applies module migrations once, in feature order, and reports status", async () => {
  const store = new MemoryStore();
  const calls = [];
  const runner = new MigrationRunner({ store, features: [catalog(calls)] });
  assert.deepEqual((await runner.status()).map(s => s.state), ["pending", "pending"]);
  assert.deepEqual(await runner.up(), ["catalog:001", "catalog:002"]);
  assert.deepEqual(await runner.up(), []);
  assert.deepEqual(calls, ["up"]);
  assert.deepEqual(await ids(store, "CURRENCY"), ["EUR", "USD"]);
  const status = await runner.status();
  assert.deepEqual(status.map(s => [s.id, s.state, s.reversible]), [
    ["catalog:001", "applied", false],
    ["catalog:002", "applied", true],
  ]);
  assert.ok(status[1].appliedAt);
  // The lock is released after a successful run.
  assert.equal((await store.list("MIGRATION_LOCKS")).items.length, 0);
});

test("the same migration runs unchanged on memory and JSON stores", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rt-migrations-"));
  try {
    for (const store of [new MemoryStore(), new JsonStore(join(dir, "db.json"))]) {
      await migrate(store, [catalog()]);
      assert.deepEqual(await ids(store, "CURRENCY"), ["EUR", "USD"], store.provider);
      assert.equal((await store.get("MIGRATIONS", "catalog:002")).data.provider, store.provider);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("step and to limit up; down reverts the latest reversible migrations", async () => {
  const store = new MemoryStore();
  const calls = [];
  const runner = new MigrationRunner({ store, features: [catalog(calls)] });
  assert.deepEqual(await runner.up({ step: 1 }), ["catalog:001"]);
  assert.deepEqual(await runner.up({ to: "catalog:002" }), ["catalog:002"]);
  assert.deepEqual(await runner.down(), ["catalog:002"]);
  assert.deepEqual(calls, ["up", "down"]);
  assert.deepEqual(await ids(store, "CURRENCY"), []);
  assert.equal(await store.get("MIGRATIONS", "catalog:002"), undefined);
  assert.deepEqual(await runner.down({ step: 0 }), []);
  await assert.rejects(runner.down({ to: "catalog:002" }), /not applied/);
});

test("down refuses irreversible migrations before reverting anything", async () => {
  const store = new MemoryStore();
  const calls = [];
  const runner = new MigrationRunner({ store, features: [catalog(calls)] });
  await runner.up();
  await assert.rejects(runner.down({ to: "catalog:001" }), /Irreversible migrations: catalog:001/);
  await assert.rejects(runner.down({ step: 2 }), /Irreversible/);
  // Nothing was reverted or unlogged by the rejected plans.
  assert.deepEqual(calls, ["up"]);
  assert.deepEqual(await ids(store, "MIGRATIONS"), ["catalog:001", "catalog:002"]);
  assert.deepEqual(await ids(store, "CURRENCY"), ["EUR", "USD"]);
});

test("preflight rejects unsupported providers, duplicates and invalid ids without writing", async () => {
  const store = new MemoryStore();
  let ran = false;
  const dynamoOnly = {
    id: "search",
    endpoints: [],
    migrations: [
      { id: "search:001", checksum: "1", up: async () => { ran = true; } },
      { id: "search:002", checksum: "2", providers: { dynamodb: { checksum: "2", up: async () => {} } } },
    ],
  };
  assert.throws(() => new MigrationRunner({ store, features: [dynamoOnly] }), /Unsupported migration search:002 for memory/);
  assert.throws(() => new MigrationRunner({ store, features: [catalog(), catalog()] }), /Duplicate migration id/);
  assert.throws(
    () => new MigrationRunner({ store, features: [{ id: "x", endpoints: [], migrations: [{ id: "no-module", checksum: "1", up: async () => {} }] }] }),
    /Invalid migration id/,
  );
  assert.throws(
    () => new MigrationRunner({ store, features: [{ id: "x", endpoints: [], migrations: [{ id: "x:001", checksum: "", up: async () => {} }] }] }),
    /without checksum/,
  );
  assert.throws(() => new MigrationRunner({ store, features: [], environment: "qa" }), /Unknown environment/);
  assert.equal(ran, false);
  assert.equal((await store.list("MIGRATIONS")).items.length, 0);
});

test("provider overrides win over generic steps; legacy run(store) still works", async () => {
  const store = new MemoryStore();
  const used = [];
  await migrate(store, [{
    id: "legacy",
    endpoints: [],
    migrations: [
      {
        id: "legacy:001",
        checksum: "generic",
        up: async () => used.push("generic"),
        providers: { memory: { checksum: "memory-v1", up: async ({ provider }) => used.push(provider) } },
      },
      { id: "legacy:002", checksum: "old", run: async s => used.push("run:" + s.provider) },
    ],
  }]);
  assert.deepEqual(used, ["memory", "run:memory"]);
  assert.equal((await store.get("MIGRATIONS", "legacy:001")).data.checksum, "memory-v1");
});

test("reuses pre-Umzug history and rejects changed checksums or engine-specific drift", async () => {
  const store = new MemoryStore();
  // Record written by the previous contracts.migrate implementation.
  await store.transact([{ row: { pk: "MIGRATIONS", sk: "catalog:001", version: 1, data: { checksum: "catalog-document-v1", provider: "dynamodb", appliedAt: "2026-01-01T00:00:00.000Z" } }, expected: null }]);
  const calls = [];
  // Generic migrations may move between engines (e.g. data copied from DynamoDB to JSON).
  assert.deepEqual(await new MigrationRunner({ store, features: [catalog(calls)] }).up(), ["catalog:002"]);

  const changed = catalog();
  changed.migrations[1].checksum = "tampered";
  await assert.rejects(new MigrationRunner({ store, features: [changed] }).up(), /Migration changed: catalog:002/);

  const specific = { id: "idx", endpoints: [], migrations: [{ id: "idx:001", checksum: "c", providers: { memory: { checksum: "c", up: async () => {} } } }] };
  await store.transact([{ row: { pk: "MIGRATIONS", sk: "idx:001", version: 1, data: { checksum: "c", provider: "dynamodb" } }, expected: null }]);
  await assert.rejects(new MigrationRunner({ store, features: [specific] }).up(), /Migration changed: idx:001/);
  // A failed verification releases the lock.
  assert.equal((await store.list("MIGRATION_LOCKS")).items.length, 0);
});

test("history from disabled modules is reported as unknown and never reverted", async () => {
  const store = new MemoryStore();
  await migrate(store, [catalog(), { id: "old", endpoints: [], migrations: [schemaMigration("old")] }]);
  const runner = new MigrationRunner({ store, features: [catalog()] });
  const status = await runner.status();
  assert.deepEqual(status.at(-1), { id: "old:001", module: "old", state: "unknown", appliedAt: status.at(-1).appliedAt, reversible: false });
  assert.deepEqual(await runner.down(), ["catalog:002"]);
  assert.ok(await store.get("MIGRATIONS", "old:001"));
});

test("a failing migration is not recorded, stops the plan and can be retried", async () => {
  const store = new MemoryStore();
  let fail = true;
  const later = [];
  const feature = {
    id: "flaky",
    endpoints: [],
    migrations: [
      schemaMigration("flaky"),
      { id: "flaky:002", checksum: "2", up: async () => { if (fail) throw new Error("provider unavailable"); } },
      { id: "flaky:003", checksum: "3", up: async () => later.push("3") },
    ],
  };
  await assert.rejects(migrate(store, [feature]), /flaky:002/);
  assert.deepEqual(await ids(store, "MIGRATIONS"), ["flaky:001"]);
  assert.deepEqual(later, []);
  assert.equal((await store.list("MIGRATION_LOCKS")).items.length, 0);
  fail = false;
  assert.deepEqual(await migrate(store, [feature]), ["flaky:002", "flaky:003"]);
});

test("concurrent runners: exactly one applies each migration, the other is locked out", async () => {
  const store = new MemoryStore();
  let runs = 0;
  let release;
  const gate = new Promise(resolve => (release = resolve));
  const feature = { id: "slow", endpoints: [], migrations: [{ id: "slow:001", checksum: "1", up: async () => { runs++; await gate; } }] };
  const first = migrate(store, [feature], { owner: "runner-a" });
  // Let runner-a take the lock before runner-b starts.
  await new Promise(resolve => setImmediate(resolve));
  const results = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => migrate(store, [feature], { owner: "runner-" + i })));
  release();
  assert.deepEqual(await first, ["slow:001"]);
  for (const result of results) {
    assert.equal(result.status, "rejected");
    assert.ok(result.reason instanceof MigrationLockedError);
    assert.equal(result.reason.holder, "runner-a");
  }
  assert.equal(runs, 1);
});

test("racing lock acquisitions on the same store never both win", async () => {
  const store = new MemoryStore();
  const feature = { id: "race", endpoints: [], migrations: [schemaMigration("race")] };
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => migrate(store, [feature])));
  const applied = results.filter(r => r.status === "fulfilled" && r.value.length);
  assert.equal(applied.length, 1);
  for (const r of results) if (r.status === "rejected") assert.ok(r.reason instanceof MigrationLockedError, String(r.reason));
  assert.equal((await store.list("MIGRATION_LOCKS")).items.length, 0);
});

test("an expired lock from a crashed runner is taken over; a live one is not", async () => {
  const store = new MemoryStore();
  let now = new Date("2026-09-24T10:00:00Z");
  const clock = () => now;
  await store.transact([{ row: { pk: "MIGRATION_LOCKS", sk: "migrations", version: 3, data: { owner: "crashed", expiresAt: "2026-09-24T10:05:00.000Z" } }, expected: null }]);
  await assert.rejects(migrate(store, [catalog()], { clock }), err => err instanceof MigrationLockedError && err.holder === "crashed");
  now = new Date("2026-09-24T10:06:00Z");
  assert.deepEqual(await migrate(store, [catalog()], { clock, lockTtlMs: 1000 }), ["catalog:001", "catalog:002"]);
  assert.equal((await store.list("MIGRATION_LOCKS")).items.length, 0);
});

test("a runner that lost its lease stops before recording more history", async () => {
  const store = new MemoryStore();
  const feature = {
    id: "lease",
    endpoints: [],
    migrations: [{
      id: "lease:intrude",
      checksum: "1",
      up: async ({ store: s }) => {
        // Simulate another runner taking over an expired lease mid-step.
        const lock = await s.get("MIGRATION_LOCKS", "migrations");
        await s.transact([{ row: { ...lock, version: lock.version + 1, data: { ...lock.data, owner: "intruder" } }, expected: lock.version }]);
      },
    }, { id: "lease:after", checksum: "2", up: async () => {} }],
  };
  await assert.rejects(migrate(store, [feature]));
  assert.equal(await store.get("MIGRATIONS", "lease:intrude"), undefined);
  assert.equal(await store.get("MIGRATIONS", "lease:after"), undefined);
  // The intruder's lease is left intact for its holder.
  assert.equal((await store.get("MIGRATION_LOCKS", "migrations")).data.owner, "intruder");
});

test("ensureRows is idempotent and safe under concurrent inserts", async () => {
  const store = new MemoryStore();
  const context = createContext(store, "local", () => {});
  const rows = [{ pk: "P", sk: "a", data: { n: 1 } }, { pk: "P", sk: "b", data: { n: 2 } }];
  const results = await Promise.all(Array.from({ length: 10 }, () => context.ensureRows(rows)));
  assert.equal(results.flat().length, 2);
  await store.transact([{ row: { ...(await store.get("P", "a")), version: 2, data: { n: 99 } }, expected: 1 }]);
  assert.deepEqual(await context.ensureRows(rows), []);
  assert.equal((await store.get("P", "a")).data.n, 99, "existing rows are never overwritten");
  const failing = createContext({ provider: "x", get: async () => undefined, transact: async () => { throw new Error("offline"); }, list: async () => ({ items: [] }) }, "local", () => {});
  await assert.rejects(failing.ensureRows(rows), /offline/);
});

test("logs progress through the injected logger", async () => {
  const lines = [];
  const store = new MemoryStore();
  const runner = new MigrationRunner({ store, features: [catalog()], log: line => lines.push(line) });
  await runner.up();
  await runner.down();
  assert.deepEqual(lines, ["migrating catalog:001", "migrating catalog:002", "reverting catalog:002"]);
});
