import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "@gsalgadotoledo/rt-app-dynamodb";
import { schemaMigration } from "@gsalgadotoledo/rt-app-contracts";
import { MigrationRunner, SeedRunner } from "@gsalgadotoledo/rt-app-migrations";
import { migrateCommand, seedCommand, MIGRATE_USAGE, SEED_USAGE } from "@gsalgadotoledo/rt-app-migrations/cli";

function application(environment = "local") {
  const store = new MemoryStore();
  const features = [{
    id: "catalog",
    endpoints: [],
    migrations: [
      schemaMigration("catalog"),
      { id: "catalog:002", checksum: "2", description: "Currencies", up: async () => {}, down: async () => {} },
    ],
    seeds: [{ id: "catalog:demo", description: "Demo products", run: async ({ secret }) => { secret("DEMO_PASSWORD"); } }],
  }];
  return {
    store,
    environment,
    migrations: options => new MigrationRunner({ environment, ...options, store, features }),
    seeds: options => new SeedRunner({ environment, ...options, store, features }),
  };
}

const capture = () => { const lines = []; return { lines, out: line => lines.push(line) }; };

test("migrate status, up, down with human and JSON output", async () => {
  const app = application();
  let c = capture();
  await migrateCommand(app, [], c.out);
  assert.match(c.lines.join("\n"), /pending  catalog:002 — Currencies[\s\S]*2 pending/);
  c = capture();
  await migrateCommand(app, ["up", "--step", "1"], c.out);
  assert.deepEqual(c.lines, ["  migrating catalog:001", "Applied: catalog:001"]);
  c = capture();
  await migrateCommand(app, ["up", "--json"], c.out);
  assert.deepEqual(JSON.parse(c.lines[0]), { environment: "local", applied: ["catalog:002"] });
  c = capture();
  await migrateCommand(app, ["up"], c.out);
  assert.deepEqual(c.lines, ["Nothing to apply."]);
  c = capture();
  await migrateCommand(app, ["status", "--json"], c.out);
  assert.deepEqual(JSON.parse(c.lines[0]).migrations.map(m => m.state), ["applied", "applied"]);
  c = capture();
  await migrateCommand(app, ["status"], c.out);
  assert.equal(c.lines.at(-1), "Up to date.");
  c = capture();
  await migrateCommand(app, ["down", "--to", "catalog:002"], c.out);
  assert.deepEqual(c.lines, ["  reverting catalog:002", "Reverted: catalog:002"]);
  c = capture();
  await migrateCommand(app, ["down", "--step", "0"], c.out);
  assert.deepEqual(c.lines, ["Nothing to revert."]);
  c = capture();
  await migrateCommand(app, ["down", "--json", "--step", "0"], c.out);
  assert.deepEqual(JSON.parse(c.lines[0]), { environment: "local", reverted: [] });
});

test("migrate rejects malformed arguments before touching the store", async () => {
  const app = application();
  for (const argv of [["sideways"], ["up", "--step", "-1"], ["up", "--step", "x"], ["up", "--to"], ["up", "--force"], ["status", "--step", "1"], ["up", "stray"]])
    await assert.rejects(migrateCommand(app, argv, () => {}), { message: MIGRATE_USAGE }, argv.join(" "));
  assert.equal((await app.store.list("MIGRATIONS")).items.length, 0);
});

test("seed run and status, with module filter, rerun and secrets", async () => {
  const app = application("stage");
  let c = capture();
  await assert.rejects(seedCommand(app, [], {}, c.out), /requires DEMO_PASSWORD/);
  c = capture();
  await seedCommand(app, ["--module", "catalog"], { DEMO_PASSWORD: "x" }, c.out);
  assert.deepEqual(c.lines, ["  seeding catalog:demo", "Seeded: catalog:demo"]);
  c = capture();
  await seedCommand(app, ["run"], { DEMO_PASSWORD: "x" }, c.out);
  assert.deepEqual(c.lines, ["No pending seeds for stage."]);
  c = capture();
  await seedCommand(app, ["run", "--rerun", "--json"], { DEMO_PASSWORD: "x" }, c.out);
  assert.deepEqual(JSON.parse(c.lines[0]), { environment: "stage", seeded: ["catalog:demo"] });
  c = capture();
  await seedCommand(app, ["status"], {}, c.out);
  assert.deepEqual(c.lines, ["Seeds (stage):", "  applied  catalog:demo — Demo products"]);
  c = capture();
  await seedCommand(app, ["status", "--json"], {}, c.out);
  assert.equal(JSON.parse(c.lines[0]).seeds[0].state, "applied");
  for (const argv of [["plant"], ["status", "--rerun"], ["--module"], ["--everything"]])
    await assert.rejects(seedCommand(app, argv, {}, () => {}), { message: SEED_USAGE }, argv.join(" "));
});

test("production reports skipped demo seeds and runs none", async () => {
  const app = application("prod");
  const c = capture();
  await seedCommand(app, [], { DEMO_PASSWORD: "x" }, c.out);
  assert.deepEqual(c.lines, ["No pending seeds for prod."]);
});
