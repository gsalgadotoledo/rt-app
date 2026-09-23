import test from "node:test";
import assert from "node:assert/strict";
import {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
} from "@aws-sdk/client-dynamodb";
import { DynamoStore } from "@gsalgadotoledo/rt-app-dynamodb";
import { Conflict } from "@gsalgadotoledo/rt-app-contracts";
import { createApplication, seedDemo } from "@gsalgadotoledo/rt-app-framework";
import { LocalMailbox } from "@gsalgadotoledo/rt-app-auth";
const endpoint = process.env.DYNAMODB_TEST_ENDPOINT;
test(
  "real DynamoDB API: migration, unique transactions, CAS, pagination and persisted auth",
  { skip: !endpoint, timeout: 60000 },
  async () => {
    const url = new URL(endpoint);
    assert.ok(
      ["127.0.0.1", "localhost"].includes(url.hostname),
      "Integration test is restricted to local endpoints",
    );
    const client = new DynamoDBClient({ endpoint, region: "us-east-1" }),
      table = `rt-app-test-${Date.now()}`;
    await client.send(
      new CreateTableCommand({
        TableName: table,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" },
        ],
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
      }),
    );
    try {
      const store = new DynamoStore(table, { endpoint, region: "us-east-1" });
      const options = {
        store,
        mailer: new LocalMailbox(),
        secret: "integration-secret".repeat(4),
      };
      const app = createApplication(options);
      await app.migrate();
      await app.migrate();
      await seedDemo(app, "Integration-password-2026!");
      const row = { pk: "TEST", sk: "one", version: 1, data: { value: 1 } };
      const results = await Promise.allSettled(
        [1, 2].map(() => store.transact([{ row, expected: null }])),
      );
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.ok(
        results.find((r) => r.status === "rejected").reason instanceof Conflict,
      );
      await assert.rejects(
        store.transact([{ row: { ...row, version: 3 }, expected: 2 }]),
        Conflict,
      );
      for (let batch = 0; batch < 3; batch++)
        await store.transact(
          Array.from({ length: 20 }, (_, i) => ({
            row: {
              pk: "PAGE",
              sk: String(batch * 20 + i).padStart(3, "0"),
              version: 1,
              data: { i },
            },
            expected: null,
          })),
        );
      const page = await store.list("PAGE");
      assert.equal(page.items.length, 50);
      assert.equal((await store.list("PAGE", page.cursor)).items.length, 10);
      const restarted = createApplication({
        ...options,
        store: new DynamoStore(table, { endpoint, region: "us-east-1" }),
      });
      const r = await restarted.auth.login(
        "owner@example.test",
        "Integration-password-2026!",
        "test",
      );
      assert.equal(r.user.role, "owner");
    } finally {
      await client.send(new DeleteTableCommand({ TableName: table }));
      client.destroy();
    }
  },
);
