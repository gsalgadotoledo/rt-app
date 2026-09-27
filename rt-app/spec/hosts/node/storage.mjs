// Subjects: nosql-memory, nosql-json, nosql-postgres, nosql-dynamodb, feature-flags.
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonStore } from "@gsalgadotoledo/rt-app-json";
import { MemoryStore, DynamoStore } from "@gsalgadotoledo/rt-app-dynamodb";
import { PostgresStore } from "@gsalgadotoledo/rt-app-postgres";
import { DynamoDBClient, CreateTableCommand, DeleteTableCommand } from "@aws-sdk/client-dynamodb";
import { FeatureFlags } from "@gsalgadotoledo/rt-app-feature-flags";

/** Store the given rows with version-guarded creates. */
async function seed(store, rows = []) {
  if (rows.length) await store.transact(rows.map((row) => ({ row, expected: null })));
  return store;
}

/** A memory store holding the given rows. */
export const memoryStore = (rows = []) => seed(new MemoryStore(), rows);

/** A JsonStore on a fresh temporary file holding the given rows; the directory is removed on close. */
async function jsonStore(rows) {
  const dir = await mkdtemp(join(tmpdir(), "rt-contract-nosql-json-"));
  const store = await seed(new JsonStore(join(dir, "db.json")), rows);
  return Object.assign(Object.create(store), { close: () => rm(dir, { recursive: true, force: true }) });
}

const unique = () => `rt_contract_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;

/** A fresh PostgreSQL table per instance (RT_APP_TEST_POSTGRES_URL); dropped on close. */
async function postgresStore(rows) {
  const table = unique();
  const store = PostgresStore.connect(process.env.RT_APP_TEST_POSTGRES_URL, { table, max: 2, ssl: false });
  await seed(store, rows);
  return Object.assign(Object.create(store), {
    async close() {
      await store.client.query?.(`DROP TABLE IF EXISTS ${table}`).catch(() => {});
      await store.close();
    },
  });
}

/** A fresh DynamoDB Local table per instance (RT_APP_TEST_DYNAMODB_ENDPOINT); deleted on close. */
async function dynamoStore(rows) {
  const endpoint = process.env.RT_APP_TEST_DYNAMODB_ENDPOINT, table = unique();
  const client = new DynamoDBClient({ endpoint, region: "us-east-1" });
  await client.send(new CreateTableCommand({
    TableName: table,
    BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "sk", AttributeType: "S" }],
    KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }],
  }));
  const store = await seed(new DynamoStore(table, { endpoint, region: "us-east-1" }), rows);
  return Object.assign(Object.create(store), {
    async close() {
      await client.send(new DeleteTableCommand({ TableName: table })).catch(() => {});
      client.destroy();
    },
  });
}

export const subjects = {
  "nosql-memory": (init) => memoryStore(init.rows),
  "nosql-json": (init) => jsonStore(init.rows),
  ...(process.env.RT_APP_TEST_POSTGRES_URL ? { "nosql-postgres": (init) => postgresStore(init.rows) } : {}),
  ...(process.env.RT_APP_TEST_DYNAMODB_ENDPOINT ? { "nosql-dynamodb": (init) => dynamoStore(init.rows) } : {}),
  "feature-flags": async (init) => new FeatureFlags(await memoryStore(init.rows)),
};
