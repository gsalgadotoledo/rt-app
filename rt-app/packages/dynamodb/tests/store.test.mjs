import test from "node:test";
import assert from "node:assert/strict";
import { DynamoStore, MemoryStore } from "../dist/index.js";

test("Dynamo commands keep consistent reads, version checks and pagination scoped to the partition", async () => {
  const store = new DynamoStore("test", { region: "us-east-1" });
  const calls = [];
  let response = {};
  store.client = {
    send: async (command) => {
      calls.push(command.input);
      return response;
    },
  };
  assert.equal(await store.get("P", "1"), undefined);
  assert.deepEqual(calls.at(-1), {
    TableName: "test",
    Key: { pk: "P", sk: "1" },
    ConsistentRead: true,
  });
  response = { Item: { pk: "P", sk: "1" } };
  assert.deepEqual(await store.get("P", "1"), response.Item);
  const row = { pk: "P", sk: "1", version: 1, data: {} };
  await store.transact([]);
  await store.transact([
    { row, expected: null },
    { row: { ...row, sk: "2" }, expected: 3, delete: true },
  ]);
  assert.equal(
    calls.at(-1).TransactItems[0].Put.ConditionExpression,
    "attribute_not_exists(pk)",
  );
  assert.deepEqual(
    calls.at(-1).TransactItems[1].Delete.ExpressionAttributeValues,
    { ":v": 3 },
  );
  response = { Items: [row], LastEvaluatedKey: { pk: "P", sk: "1" } };
  const page = await store.list("P");
  response = {};
  assert.deepEqual((await store.list("P", page.cursor)).items, []);
  assert.deepEqual(calls.at(-1).ExclusiveStartKey, { pk: "P", sk: "1" });
  await assert.rejects(store.list("OTHER", page.cursor), { status: 400 });
  await assert.rejects(store.list("P", "!"), { status: 400 });
  assert.throws(() => new DynamoStore(""), /TABLE_NAME/);
});

test("only Dynamo conditional conflicts become 409; infrastructure failures retain their identity", async () => {
  const store = new DynamoStore("test");
  for (const code of ["ConditionalCheckFailed", "TransactionConflict"]) {
    store.client = {
      send: async () => {
        throw {
          name: "TransactionCanceledException",
          CancellationReasons: [{ Code: code }],
        };
      },
    };
    await assert.rejects(store.transact([{ row: {}, expected: null }]), {
      status: 409,
    });
  }
  for (const error of [
    new Error("offline"),
    { name: "TransactionCanceledException" },
    {
      name: "TransactionCanceledException",
      CancellationReasons: [{ Code: "ThrottlingError" }],
    },
  ]) {
    store.client = {
      send: async () => {
        throw error;
      },
    };
    await assert.rejects(
      store.transact([{ row: {}, expected: null }]),
      (e) => e === error,
    );
  }
});

test("memory transactions are atomic, clone values and paginate deterministically", async () => {
  const store = new MemoryStore();
  const rows = Array.from({ length: 51 }, (_, i) => ({
    pk: "P",
    sk: String(i).padStart(3, "0"),
    version: 1,
    data: { i },
  }));
  await store.transact(rows.map((row) => ({ row, expected: null })));
  const first = await store.list("P");
  assert.equal(first.items.length, 50);
  assert.equal((await store.list("P", first.cursor)).items.length, 1);
  first.items[0].data.i = 900;
  assert.equal((await store.get("P", "000")).data.i, 0);
  await assert.rejects(store.list("other", first.cursor), { status: 400 });
  await assert.rejects(store.list("P", "bad"), { status: 400 });
  await assert.rejects(
    store.transact([
      { row: rows[0], expected: 1, delete: true },
      { row: rows[1], expected: 99 },
    ]),
    { status: 409 },
  );
  assert.ok(await store.get("P", "000"));
  await assert.rejects(
    store.transact([
      { row: rows[0], expected: 1 },
      { row: rows[0], expected: 1 },
    ]),
    /Duplicate/,
  );
  await store.transact([{ row: rows[0], expected: 1, delete: true }]);
  assert.equal(await store.get("P", "000"), undefined);
});
