import { test } from "node:test";
import assert from "node:assert/strict";
import { SQSQueue } from "../dist/index.js";
const url = "https://sqs.us-east-1.amazonaws.com/1/jobs",
  dead = url + "-dead";
const message = {
  id: "1",
  type: "x",
  payload: {},
  createdAt: new Date().toISOString(),
};
test("SQS commands, leases, poison quarantine and DLQ publish-before-delete", async () => {
  const calls = [];
  let messages = [
    {
      Body: JSON.stringify(message),
      ReceiptHandle: "receipt",
      Attributes: { ApproximateReceiveCount: "2" },
    },
  ];
  const client = {
    send: async (c) => {
      calls.push(c);
      return { Messages: messages };
    },
  };
  const q = new SQSQueue(client, url, dead);
  await q.publish(message);
  const [d] = await q.receive(2);
  assert.equal(d.attempts, 2);
  await d.extend(100);
  await d.retry(1);
  await d.ack();
  await d.deadLetter();
  assert.equal(calls.at(-2).input.QueueUrl, dead);
  assert.equal(calls.at(-1).constructor.name, "DeleteMessageCommand");
  await assert.rejects(d.retry(-1));
  messages = [
    { Body: "bad", ReceiptHandle: "bad" },
    { ReceiptHandle: "empty" },
  ];
  assert.deepEqual(await q.receive(1), []);
  messages = [{ Body: JSON.stringify(message), ReceiptHandle: "r" }];
  assert.equal((await q.receive(1))[0].attempts, 1);
  messages = [{}];
  await assert.rejects(q.receive(1), /receipt/);
  await assert.rejects(q.receive(11));
  assert.deepEqual(
    await new SQSQueue({ send: async () => ({}) }, url, dead).receive(1),
    [],
  );
  for (const args of [
    [client, "http://bad", dead],
    [client, url, url],
    [client, url + ".fifo", dead],
    [client, url, dead, 0],
  ])
    assert.throws(() => new SQSQueue(...args));
});
test("DLQ failure never deletes the source", async () => {
  const calls = [];
  const q = new SQSQueue(
    {
      send: async (c) => {
        calls.push(c.constructor.name);
        if (c.constructor.name === "SendMessageCommand") throw Error("offline");
        return { Messages: [{ Body: "bad", ReceiptHandle: "r" }] };
      },
    },
    url,
    dead,
  );
  await assert.rejects(q.receive(1), /offline/);
  assert.ok(!calls.includes("DeleteMessageCommand"));
});

test("DLQ inspection seals receipts; retry sends before deleting and rejects replay or tampering", async () => {
  const calls = [];
  let response = {
    Messages: [
      {
        Body: JSON.stringify(message),
        ReceiptHandle: "private",
        MessageId: "broker",
      },
    ],
  };
  let failSend = false,
    failDelete = false;
  const client = {
    send: async (command) => {
      calls.push(command);
      if (command.constructor.name === "SendMessageCommand" && failSend)
        throw Error("send failed");
      if (command.constructor.name === "DeleteMessageCommand" && failDelete)
        throw Error("delete failed");
      return response;
    },
  };
  const q = new SQSQueue(client, url, dead, 60, "x".repeat(32));
  assert.equal(q.capabilities.failedAdmin, true);
  const [item] = await q.inspectFailures(10);
  assert.equal(item.id, "1");
  assert.equal(item.retryable, true);
  assert.doesNotMatch(item.token, /private/);
  assert.equal(calls[0].input.QueueUrl, dead);
  assert.equal(calls[0].input.VisibilityTimeout, 60);
  await q.retryFailure(item.token);
  assert.equal(calls.at(-2).input.QueueUrl, url);
  assert.equal(calls.at(-1).input.QueueUrl, dead);
  await assert.rejects(q.retryFailure(item.token), /already/);
  await assert.rejects(q.retryFailure("bad"));
  response = {
    Messages: [{ Body: "bad", ReceiptHandle: "bad", MessageId: "poison" }, {}],
  };
  const invalid = await q.inspectFailures(2);
  assert.equal(invalid[0].retryable, false);
  assert.equal(invalid[1].id, "invalid");
  await assert.rejects(q.retryFailure(invalid[0].token));
  await assert.rejects(q.retryFailure(invalid[1].token));
  response = {};
  assert.deepEqual(await q.inspectFailures(1), []);
  await assert.rejects(q.inspectFailures(0));
  await assert.rejects(
    new SQSQueue(client, url, dead).inspectFailures(1),
    /secret/,
  );
  await assert.rejects(
    new SQSQueue(client, url, dead).retryFailure("x"),
    /secret/,
  );
  response = {
    Messages: [{ Body: JSON.stringify(message), ReceiptHandle: "next" }],
  };
  const [next] = await q.inspectFailures(1);
  failSend = true;
  const before = calls.filter(
    (c) => c.constructor.name === "DeleteMessageCommand",
  ).length;
  await assert.rejects(q.retryFailure(next.token));
  assert.equal(
    calls.filter((c) => c.constructor.name === "DeleteMessageCommand").length,
    before,
  );
  failSend = false;
  failDelete = true;
  await assert.rejects(q.retryFailure(next.token), /delete/);
  await assert.rejects(q.retryFailure(next.token), /already/);
});
