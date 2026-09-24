import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "@gsalgadotoledo/rt-app-dynamodb";
import { SeedRunner, MigrationLockedError } from "@gsalgadotoledo/rt-app-migrations";

function modules(log = []) {
  return [
    {
      id: "users",
      endpoints: [],
      migrations: [],
      seeds: [{
        id: "users:demo",
        description: "Demo identities",
        run: async ({ ensureRows, secret }) => {
          log.push("users");
          await ensureRows([{ pk: "USERS", sk: "ana", data: { password: secret("DEMO_PASSWORD") } }]);
        },
      }],
    },
    {
      id: "catalog",
      endpoints: [],
      migrations: [],
      seeds: [
        { id: "catalog:currencies", environments: ["local", "develop", "stage", "prod"], run: async ({ ensureRows }) => { log.push("currencies"); await ensureRows([{ pk: "CURRENCY", sk: "USD", data: {} }]); } },
        { id: "catalog:products", run: async ({ service }) => { log.push("products:" + service("users").owner); } },
      ],
    },
  ];
}

const options = extra => ({ secrets: { DEMO_PASSWORD: "Demo-password-2026!" }, services: { users: { owner: "ana" } }, ...extra });

test("runs each seed once per environment, in module order", async () => {
  const store = new MemoryStore();
  const log = [];
  const runner = new SeedRunner(options({ store, features: modules(log), environment: "stage" }));
  assert.deepEqual(await runner.run(), ["users:demo", "catalog:currencies", "catalog:products"]);
  assert.deepEqual(await runner.run(), []);
  assert.deepEqual(log, ["users", "currencies", "products:ana"]);
  assert.deepEqual((await runner.status()).map(s => s.state), ["applied", "applied", "applied"]);
  assert.equal((await store.get("SEEDS", "users:demo")).data.environment, "stage");
});

test("production only runs seeds that explicitly list prod", async () => {
  const store = new MemoryStore();
  const log = [];
  const runner = new SeedRunner(options({ store, features: modules(log), environment: "prod" }));
  assert.deepEqual(await runner.run(), ["catalog:currencies"]);
  assert.deepEqual((await runner.status()).map(s => s.state), ["skipped", "applied", "skipped"]);
  assert.equal(await store.get("USERS", "ana"), undefined, "demo identities never reach production");
});

test("rerun forces applied seeds; a new version re-runs only the changed seed", async () => {
  const store = new MemoryStore();
  const log = [];
  const features = modules(log);
  await new SeedRunner(options({ store, features })).run();
  assert.deepEqual(await new SeedRunner(options({ store, features })).run({ rerun: true, modules: ["users"] }), ["users:demo"]);
  features[1].seeds[1].version = "2";
  const runner = new SeedRunner(options({ store, features }));
  assert.equal((await runner.status())[2].state, "changed");
  assert.deepEqual(await runner.run(), ["catalog:products"]);
  assert.equal((await store.get("SEEDS", "catalog:products")).data.version, "2");
  assert.deepEqual(log, ["users", "currencies", "products:ana", "users", "products:ana"]);
});

test("module filter, unknown modules and invalid declarations", async () => {
  const store = new MemoryStore();
  const log = [];
  const runner = new SeedRunner(options({ store, features: modules(log) }));
  assert.deepEqual(await runner.run({ modules: ["catalog"] }), ["catalog:currencies", "catalog:products"]);
  await assert.rejects(runner.run({ modules: ["billing"] }), /Unknown module: billing/);
  assert.deepEqual(await new SeedRunner({ store, features: [] }).run(), []);
  const bad = seed => () => new SeedRunner({ store, features: [{ id: "x", endpoints: [], migrations: [], seeds: [seed] }] });
  assert.throws(bad({ id: "x:a", environments: [], run: async () => {} }), /Invalid environments/);
  assert.throws(bad({ id: "x:a", environments: ["qa"], run: async () => {} }), /Invalid environments/);
  assert.throws(bad({ id: "nomodule", run: async () => {} }), /Invalid seed id/);
  const dup = { id: "x", endpoints: [], migrations: [], seeds: [{ id: "x:a", run: async () => {} }, { id: "x:a", run: async () => {} }] };
  assert.throws(() => new SeedRunner({ store, features: [dup] }), /Duplicate seed id/);
  assert.throws(() => new SeedRunner({ store, features: [], environment: "qa" }), /Unknown environment/);
});

test("missing secrets or services fail the seed without recording it", async () => {
  const store = new MemoryStore();
  await assert.rejects(new SeedRunner({ store, features: modules() }).run({ modules: ["users"] }), /users:demo requires DEMO_PASSWORD/);
  assert.equal(await store.get("SEEDS", "users:demo"), undefined);
  await assert.rejects(
    new SeedRunner({ store, features: modules(), secrets: {} }).run({ modules: ["catalog"] }),
    /catalog:products requires the users service/,
  );
  assert.ok(await store.get("SEEDS", "catalog:currencies"), "seeds before the failure stay recorded");
  assert.equal((await store.list("MIGRATION_LOCKS")).items.length, 0);
});

test("faker is deterministic per seed id", async () => {
  const names = [];
  const features = [{
    id: "demo",
    endpoints: [],
    migrations: [],
    seeds: [{ id: "demo:people", run: async ({ faker }) => { const f = await faker(); names.push(f.person.fullName()); } }],
  }];
  for (let i = 0; i < 2; i++) await new SeedRunner({ store: new MemoryStore(), features }).run();
  assert.equal(names.length, 2);
  assert.equal(names[0], names[1]);
});

test("seeding is locked separately from migrations and refuses concurrent runs", async () => {
  const store = new MemoryStore();
  let release;
  const gate = new Promise(resolve => (release = resolve));
  const features = [{ id: "slow", endpoints: [], migrations: [], seeds: [{ id: "slow:data", run: () => gate }] }];
  const first = new SeedRunner({ store, features, owner: "a" }).run();
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(new SeedRunner({ store, features, owner: "b" }).run(), MigrationLockedError);
  release();
  assert.deepEqual(await first, ["slow:data"]);
});
