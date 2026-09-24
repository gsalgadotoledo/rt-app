import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { Conflict, schemaMigration } from "@gsalgadotoledo/rt-app-contracts";
import { MigrationRunner, SeedRunner } from "@gsalgadotoledo/rt-app-migrations";
import { PostgresStore, pgliteClient, pgClient } from "@gsalgadotoledo/rt-app-postgres";

async function store() {
  const db = new PGlite();
  const s = new PostgresStore(pgliteClient(db));
  await s.ensureSchema();
  await s.ensureSchema();
  return { s, db };
}

const row = (sk, version = 1, data = { n: 1 }) => ({ pk: "P", sk, version, data });

test("get, conditional insert, update, delete and conflicts", async () => {
  const { s } = await store();
  assert.equal(s.provider, "postgres");
  assert.equal(await s.get("P", "a"), undefined);
  await s.transact([{ row: { ...row("a"), ttl: 1700000000 }, expected: null }]);
  assert.deepEqual(await s.get("P", "a"), { ...row("a"), ttl: 1700000000 });
  await assert.rejects(s.transact([{ row: row("a"), expected: null }]), Conflict);
  await s.transact([{ row: row("a", 2, { n: 2, nested: { x: [1, "two"] } }), expected: 1 }]);
  assert.deepEqual((await s.get("P", "a")).data, { n: 2, nested: { x: [1, "two"] } });
  assert.equal((await s.get("P", "a")).ttl, undefined, "ttl cleared by the update");
  await assert.rejects(s.transact([{ row: row("a", 3), expected: 1 }]), Conflict, "stale version");
  await assert.rejects(s.transact([{ row: row("a"), expected: 1, delete: true }]), Conflict);
  await s.transact([{ row: row("a"), expected: 2, delete: true }]);
  assert.equal(await s.get("P", "a"), undefined);
  await s.transact([{ row: row("z"), expected: null, delete: true }]);
  await s.transact([]);
  await assert.rejects(s.transact([{ row: row("b"), expected: null }, { row: row("b"), expected: null }]), /Duplicate transaction key/);
});

test("a conflict rolls back the whole write set", async () => {
  const { s } = await store();
  await s.transact([{ row: row("x"), expected: null }]);
  await assert.rejects(s.transact([{ row: row("y"), expected: null }, { row: row("x", 2), expected: 7 }]), Conflict);
  assert.equal(await s.get("P", "y"), undefined);
  await s.transact([{ row: row("q"), expected: null }]);
  await assert.rejects(s.transact([{ row: row("q", 2), expected: 1 }, { row: row("q2"), expected: null, delete: false }, { row: row("x"), expected: null, delete: true }]), Conflict);
  assert.equal((await s.get("P", "q")).version, 1);
  assert.equal(await s.get("P", "q2"), undefined);
});

test("list pages by binary sort key with partition-bound cursors", async () => {
  const { s } = await store();
  const keys = Array.from({ length: 120 }, (_, i) => "k" + String(i).padStart(3, "0"));
  await s.transact(keys.slice(0, 60).map((sk) => ({ row: row(sk), expected: null })));
  await s.transact([...keys.slice(60).map((sk) => ({ row: row(sk), expected: null })), { row: { ...row("B"), pk: "OTHER" }, expected: null }, { row: row("Zeta"), expected: null }, { row: row("alpha"), expected: null }]);
  const seen = [];
  let cursor;
  do {
    const page = await s.list("P", cursor);
    assert.ok(page.items.length <= 50);
    seen.push(...page.items.map((r) => r.sk));
    cursor = page.cursor;
  } while (cursor);
  assert.deepEqual(seen, ["Zeta", "alpha", ...keys], "uppercase sorts before lowercase, like the other adapters");
  const first = await s.list("P");
  await assert.rejects(s.list("OTHER", first.cursor), /Invalid cursor/);
  await assert.rejects(s.list("P", "not-base64-json"), /Invalid cursor/);
  assert.deepEqual((await s.list("EMPTY")).items, []);
});

test("module migrations and seeds run unchanged on Postgres", async () => {
  const { s } = await store();
  const features = [{
    id: "catalog",
    endpoints: [],
    migrations: [schemaMigration("catalog"), { id: "catalog:002", checksum: "c2", up: async ({ ensureRows }) => { await ensureRows([{ pk: "CURRENCY", sk: "USD", data: { code: "USD" } }]); } }],
    seeds: [{ id: "catalog:demo", run: async ({ ensureRows }) => { await ensureRows([{ pk: "CRUD#catalog", sk: "p1", data: { name: "Demo" } }]); } }],
  }];
  assert.deepEqual(await new MigrationRunner({ store: s, features }).up(), ["catalog:001", "catalog:002"]);
  assert.deepEqual(await new MigrationRunner({ store: s, features }).up(), []);
  assert.deepEqual(await new SeedRunner({ store: s, features }).run(), ["catalog:demo"]);
  assert.equal((await s.get("MIGRATIONS", "catalog:002")).data.provider, "postgres");
  assert.equal((await s.get("CRUD#catalog", "p1")).data.name, "Demo");
});

test("the schema is created lazily once, and a failed creation is retried", async () => {
  let creates = 0, fail = true;
  const db = new PGlite();
  const base = pgliteClient(db);
  const client = { ...base, query: async (sql, params) => {
    if (sql.startsWith("CREATE TABLE")) { creates++; if (fail) { fail = false; throw new Error("database starting"); } }
    return base.query(sql, params);
  } };
  const s = new PostgresStore(client);
  await assert.rejects(s.get("P", "a"), /database starting/);
  await Promise.all([s.get("P", "a"), s.list("P"), s.transact([{ row: row("a"), expected: null }])]);
  assert.equal(creates, 2, "one failed attempt, then one shared creation");
});

test("table names are validated and connect() builds a TLS pool for remote hosts", async () => {
  assert.throws(() => new PostgresStore(pgliteClient(new PGlite()), { table: "rows; drop" }), /Invalid table name/);
  const custom = new PostgresStore(pgliteClient(new PGlite()), { table: "app_rows" });
  await custom.ensureSchema();
  await custom.transact([{ row: row("a"), expected: null }]);
  assert.equal((await custom.get("P", "a")).version, 1);
  const remote = PostgresStore.connect("postgres://u:p@db.example.test:5432/app");
  const local = PostgresStore.connect("postgres://u:p@localhost:5432/app", { max: 2 });
  assert.equal(remote.provider, "postgres");
  await remote.close();
  await local.close();
  await custom.close();
});

test("pg client wrapper commits, rolls back on error and always releases the connection", async () => {
  const log = [];
  const connection = {
    query: async (sql) => {
      log.push(sql);
      if (sql === "FAIL") throw new Error("boom");
      if (sql === "ROLLBACK") throw new Error("rollback also failed");
      return { rows: [{ ok: 1 }], rowCount: null };
    },
    release: () => log.push("release"),
  };
  const pool = { query: async () => ({ rows: [{ one: 1 }], rowCount: 1 }), connect: async () => connection, end: async () => log.push("end") };
  const client = pgClient(pool);
  assert.deepEqual(await client.query("SELECT 1"), { rows: [{ one: 1 }], rowCount: 1 });
  assert.equal(await client.transaction(async (q) => (await q("WORK")).rowCount), 0);
  await assert.rejects(client.transaction((q) => q("FAIL")), /boom/);
  await client.close();
  assert.deepEqual(log, ["BEGIN", "WORK", "COMMIT", "release", "BEGIN", "FAIL", "ROLLBACK", "release", "end"]);
});
