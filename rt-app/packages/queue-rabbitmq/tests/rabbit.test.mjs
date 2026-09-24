import { test } from "node:test";
import assert from "node:assert/strict";
import { RabbitQueue } from "../dist/index.js";
const message = {
  id: "1",
  type: "x",
  payload: {},
  createdAt: new Date().toISOString(),
};
const raw = () => ({
  content: Buffer.from(JSON.stringify(message)),
  properties: { headers: { "x-delivery-count": 2 } },
});
function fake() {
  let items = [];
  const calls = [];
  return {
    calls,
    set items(x) {
      items = x;
    },
    get: async () => items.shift() ?? false,
    ack: (m) => calls.push(["ack"]),
    nack: (m, all, requeue) => calls.push(["nack", requeue]),
    sendToQueue: (name, body, opts, cb) => {
      calls.push(["send", opts]);
      cb(null);
      return true;
    },
  };
}
test("confirmed persistent publishing and bounded manual settlement", async () => {
  const channel = fake(),
    q = new RabbitQueue(channel, "jobs");
  await q.publish(message);
  assert.equal(channel.calls[0][1].persistent, true);
  channel.items = [raw(), raw(), raw()];
  const ds = await q.receive(3);
  assert.equal(ds[0].attempts, 3);
  await ds[0].ack();
  await assert.rejects(ds[0].ack());
  await ds[1].retry(0);
  await ds[2].deadLetter();
  assert.deepEqual(channel.calls.at(-1), ["nack", false]);
  await assert.rejects(ds[1].retry(3));
  await assert.rejects(ds[1].extend(3));
  assert.deepEqual(await q.receive(1), []);
  channel.items = [
    { ...raw(), content: Buffer.from("bad") },
    { ...raw(), properties: {} },
  ];
  assert.equal((await q.receive(2))[0].attempts, 1);
  channel.items = [
    { ...raw(), properties: { headers: { "x-delivery-count": "bad" } } },
  ];
  assert.equal((await q.receive(1))[0].attempts, 1);
  assert.throws(() => new RabbitQueue(channel, ""));
  await assert.rejects(q.receive(0));
  await assert.rejects(q.receive(1, AbortSignal.abort()));
});
test("publisher backpressure, rejected confirms and partial receive failure", async () => {
  let confirm;
  const channel = fake();
  channel.sendToQueue = (q, b, o, cb) => {
    confirm = cb;
    return false;
  };
  const q = new RabbitQueue(channel, "jobs");
  const pending = q.publish(message);
  await assert.rejects(q.publish(message), /busy/);
  confirm(Error("broker"));
  await assert.rejects(pending, /rejected/);
  let n = 0;
  channel.get = async () => {
    if (n++) throw Error("connection");
    return raw();
  };
  await assert.rejects(q.receive(2), /connection/);
  assert.deepEqual(channel.calls.at(-1), ["nack", true]);
});

test("explicit provisioning declares durable quorum source and dead-letter route", async () => {
  const { createRabbitQueue } = await import("../dist/index.js");
  const calls = [];
  const channel = {
    ...fake(),
    assertQueue: async (name, options) => calls.push({ name, options }),
  };
  assert.ok(await createRabbitQueue(channel, "jobs", "failed"));
  assert.equal(calls[0].name, "failed");
  assert.equal(
    calls[1].options.arguments["x-dead-letter-routing-key"],
    "failed",
  );
  await assert.rejects(createRabbitQueue(channel, "jobs", "jobs"));
});

test("Rabbit DLQ reservations reuse a bounded batch and republish before ack", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const channel = fake(),
    q = new RabbitQueue(channel, "jobs", "failed");
  channel.items = [raw()];
  const [item] = await q.inspectFailures(1);
  assert.equal(item.id, "1");
  assert.equal(item.retryable, true);
  assert.equal((await q.inspectFailures(1))[0].token, item.token);
  await q.retryFailure(item.token);
  assert.deepEqual(
    channel.calls.map((c) => c[0]),
    ["send", "ack"],
  );
  await assert.rejects(q.retryFailure(item.token), /expired/);
  channel.items = [{ content: Buffer.from("bad"), properties: {} }];
  const [poison] = await q.inspectFailures(1);
  assert.equal(poison.retryable, false);
  await assert.rejects(q.retryFailure(poison.token), /Invalid/);
  t.mock.timers.tick(60001);
  assert.deepEqual(channel.calls.at(-1), ["nack", true]);
  assert.deepEqual(await q.inspectFailures(1), []);
  await assert.rejects(q.inspectFailures(0));
  await assert.rejects(new RabbitQueue(channel, "jobs").inspectFailures(1));
  assert.throws(() => new RabbitQueue(channel, "jobs", "jobs"));
  channel.items = [raw()];
  const [failed] = await q.inspectFailures(1);
  channel.sendToQueue = (q, b, o, cb) => cb(Error("failed"));
  await assert.rejects(q.retryFailure(failed.token));
  assert.deepEqual(channel.calls.at(-1), ["nack", true]);
});

test("Rabbit concurrent inspection/retry is rejected and closed channels are tolerated", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const channel = fake(),
    q = new RabbitQueue(channel, "jobs", "failed");
  let complete;
  channel.get = () => new Promise((resolve) => (complete = resolve));
  const pending = q.inspectFailures(1);
  await assert.rejects(q.inspectFailures(1), /already/);
  complete(raw());
  const [item] = await pending;
  let confirm;
  channel.sendToQueue = (q, b, o, cb) => {
    confirm = cb;
    return true;
  };
  const retry = q.retryFailure(item.token);
  await assert.rejects(q.retryFailure(item.token), /already/);
  t.mock.timers.tick(60001);
  assert.equal(channel.calls.length, 0);
  channel.nack = () => {
    throw Error("closed");
  };
  confirm(Error("closed"));
  await assert.rejects(retry);
  channel.get = async () => raw();
  await q.inspectFailures(1);
  t.mock.timers.tick(60001);
});
