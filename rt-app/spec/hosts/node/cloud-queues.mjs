// Subjects: cache-redis, queue-sqs, queue-rabbitmq. The cloud adapters over fake clients that
// record the exact commands/requests they receive and answer with scripted responses or errors,
// so no network or cloud account is needed (docs/polyglot/{cache-redis,queue-sqs,queue-rabbitmq}.md).
//
// Every fake takes fail(method, message, skip?): the next call of `method` after `skip`
// successful ones throws Error(message) (the call is still recorded, as a sent command).
import { setTimeout as delay } from "node:timers/promises";
import { Cache, canonical, contentKey, validateEntry } from "@gsalgadotoledo/rt-app-cache";
import { RedisCache } from "@gsalgadotoledo/rt-app-cache-redis";
import { Queue } from "@gsalgadotoledo/rt-app-queue";
import { SQSQueue } from "@gsalgadotoledo/rt-app-queue-sqs";
import { RabbitQueue, createRabbitQueue } from "@gsalgadotoledo/rt-app-queue-rabbitmq";

// Wire null means "not given": optional TypeScript parameters receive undefined, not null.
const given = (value) => (value === null ? undefined : value);

/** Scripted failures: fail(method, message, skip?) throws on the call after `skip` successful ones. */
function failures() {
  const list = [];
  return {
    add(method, message, skip) {
      if (typeof method !== "string" || typeof message !== "string") throw new TypeError("fail(method, message, skip?)");
      list.push({ method, message, skip: typeof skip === "number" ? skip : 0 });
      return null;
    },
    check(method) {
      const index = list.findIndex((f) => f.method === method);
      if (index < 0) return;
      const found = list[index];
      if (found.skip > 0) {
        found.skip--;
        return;
      }
      list.splice(index, 1);
      throw new Error(found.message);
    },
  };
}

// --- cache-redis ------------------------------------------------------------------------------

/**
 * A Redis fake with the node-redis surface RedisCache uses. Commands are recorded as Redis sees
 * them (every argument a string): ["GET", key], ["SET", key, value, "PX", ms], ["DEL", key].
 * Keys expire when expires <= now on the facade clock (PX is honored).
 */
function fakeRedis(clock) {
  const rows = new Map();
  let commands = [];
  const faults = failures();
  const live = (key) => {
    const row = rows.get(key);
    if (row && row.expires <= clock.now()) rows.delete(key);
    return rows.get(key);
  };
  return {
    client: {
      get: async (key) => {
        commands.push(["GET", key]);
        faults.check("GET");
        return live(key)?.value ?? null;
      },
      set: async (key, value, options) => {
        commands.push(["SET", key, value, "PX", String(options.PX)]);
        faults.check("SET");
        rows.set(key, { value, expires: clock.now() + options.PX });
        return "OK";
      },
      del: async (key) => {
        commands.push(["DEL", key]);
        faults.check("DEL");
        return rows.delete(key) ? 1 : 0;
      },
    },
    methods: {
      // takeCommands() → the commands since the last call.
      takeCommands: () => {
        const taken = commands;
        commands = [];
        return taken;
      },
      fail: (command, message, skip) => faults.add(command, message, given(skip)),
      // seed(key, text, ttlMs?): a raw value written by someone else (not recorded).
      seed: (key, text, ttlMs) => {
        rows.set(key, { value: text, expires: typeof ttlMs === "number" ? clock.now() + ttlMs : Infinity });
        return null;
      },
      // raw(key) → the stored text of a live key, or null.
      raw: (key) => live(key)?.value ?? null,
      // ttl(key) → milliseconds left (Redis PTTL: -2 when missing, -1 without expiry).
      ttl: (key) => {
        const row = live(key);
        if (!row) return -2;
        return row.expires === Infinity ? -1 : row.expires - clock.now();
      },
      keys: () => [...rows.keys()].filter((key) => live(key)).sort(),
    },
  };
}

function msClock(init) {
  let now = typeof init.now === "number" ? init.now : 4102444800000;
  return {
    now: () => now,
    set: (ms) => {
      if (typeof ms !== "number" || !Number.isFinite(ms)) throw new TypeError("setNow needs epoch milliseconds");
      now = ms;
      return null;
    },
  };
}

/** The cache contract facade (hosts/node/cache.mjs) over RedisCache on the fake. init {now, prefix?}. */
function cacheRedis(init) {
  const clock = msClock(init);
  const redis = fakeRedis(clock);
  const cache = new Cache(new RedisCache(redis.client, given(init.prefix)));
  let loads = 0;
  const loader = (outcome) => () => {
    loads++;
    if (outcome && typeof outcome.error === "string") throw new Error(outcome.error);
    return outcome?.value ?? null;
  };
  return {
    get: async (key) => {
      const value = await cache.get(key);
      return value === undefined ? { hit: false } : { hit: true, value };
    },
    set: async (key, value, ttlMs) => (await cache.set(key, value, ttlMs), null),
    delete: async (key) => (await cache.delete(key), null),
    remember: (namespace, input, ttlMs, outcome) => cache.remember(namespace, input, ttlMs, loader(outcome)),
    loads: () => loads,
    rememberConcurrently: async (namespace, input, ttlMs, value, count) => {
      const before = loads;
      const slow = async () => {
        loads++;
        await delay(50);
        return value;
      };
      const results = await Promise.all(Array.from({ length: count }, () => cache.remember(namespace, input, ttlMs, slow)));
      return { loads: loads - before, results };
    },
    canonical: (value) => canonical(value),
    contentKey: (namespace, input) => contentKey(namespace, input),
    validateEntry: (key, ttlMs) => (validateEntry(key, ttlMs), null),
    setNow: (ms) => clock.set(ms),
    ...redis.methods,
  };
}

// --- shared queue facade ----------------------------------------------------------------------

/**
 * Numbers the deliveries an adapter hands out (receive, workOnce) 0, 1, 2…; ack/retry/extend/
 * deadLetter take that number. workOnce(outcomes, options) runs Queue(adapter).workOnce with a
 * handler driven by outcomes[messageId]: "ok" (default) or "fail" (throws Error("fail")).
 */
function queueFacade(adapter, init) {
  const deliveries = [];
  const recording = {
    get capabilities() {
      return adapter.capabilities;
    },
    publish: (message) => adapter.publish(message),
    receive: async (limit, signal) => {
      const list = await adapter.receive(limit, signal);
      deliveries.push(...list);
      return list;
    },
  };
  const random = typeof init.random === "number" ? () => init.random : undefined;
  const queue = new Queue(recording, { random });
  const delivery = (n) => {
    const found = Number.isInteger(n) ? deliveries[n] : undefined;
    if (!found) throw new TypeError("Unknown delivery " + n);
    return found;
  };
  return {
    capabilities: () => adapter.capabilities,
    publish: async (message) => (await recording.publish(message), null),
    receive: async (limit) =>
      (await recording.receive(limit)).map((d) => ({ delivery: deliveries.indexOf(d), attempts: d.attempts, message: d.message })),
    ack: async (n) => (await delivery(n).ack(), null),
    retry: async (n, seconds) => (await delivery(n).retry(seconds), null),
    extend: async (n, seconds) => (await delivery(n).extend(seconds), null),
    deadLetter: async (n) => (await delivery(n).deadLetter(), null),
    inspectFailures: (limit) => adapter.inspectFailures(limit),
    retryFailure: async (token) => (await adapter.retryFailure(token), null),
    workOnce: (outcomes, options) =>
      queue.workOnce(async (d) => {
        if ((outcomes?.[d.message.id] ?? "ok") === "fail") throw new Error("fail");
      }, given(options)),
  };
}

// --- queue-sqs --------------------------------------------------------------------------------

const SQS_URL = "https://sqs.us-east-1.amazonaws.com/123456789012/jobs";
const SQS_DEAD = "https://sqs.us-east-1.amazonaws.com/123456789012/jobs-dead";

/**
 * An SQS fake with the SDK v3 `send(command)` surface. Requests are recorded as
 * {action, params} with the API action name and its exact input; respond(action, response)
 * queues the next response of an action (default {}), fail(action, message, skip?) an error.
 */
function fakeSqs() {
  let requests = [];
  const responses = {};
  const faults = failures();
  return {
    client: {
      send: async (command) => {
        const action = command.constructor.name.replace(/Command$/, "");
        requests.push({ action, params: structuredClone(command.input) });
        faults.check(action);
        return structuredClone(responses[action]?.shift() ?? {});
      },
    },
    methods: {
      respond: (action, response) => {
        (responses[action] ??= []).push(response ?? {});
        return null;
      },
      fail: (action, message, skip) => faults.add(action, message, given(skip)),
      // takeRequests() → the requests since the last call.
      takeRequests: () => {
        const taken = requests;
        requests = [];
        return taken;
      },
    },
  };
}

/** SQSQueue on the fake. init {url?, deadLetterUrl?, visibilitySeconds?, adminSecret?, random?}. */
function queueSqs(init) {
  const sqs = fakeSqs();
  const adapter = new SQSQueue(
    sqs.client,
    init.url ?? SQS_URL,
    init.deadLetterUrl ?? SQS_DEAD,
    given(init.visibilitySeconds),
    given(init.adminSecret),
  );
  return { ...queueFacade(adapter, init), ...sqs.methods };
}

// --- queue-rabbitmq ---------------------------------------------------------------------------

/**
 * A RabbitMQ broker fake behind the amqplib ConfirmChannel surface the adapter uses. Commands are
 * recorded as AMQP methods:
 *   {method: "basic.get", queue, noAck}
 *   {method: "basic.ack", deliveryTag, multiple}
 *   {method: "basic.nack", deliveryTag, multiple, requeue}
 *   {method: "basic.publish", exchange, routingKey, body, properties: {deliveryMode, messageId, contentType}}
 *   {method: "queue.declare", queue, durable, arguments}
 * Queues hold {body, headers}; delivery tags count from 1. A requeued message goes back to the
 * head with x-delivery-count + 1 (quorum queues); a rejected one (requeue false) moves to the
 * queue's dead-letter route (init.deadLetterQueue, or x-dead-letter-routing-key when declared).
 */
function fakeRabbit(init) {
  const queues = new Map();
  const routes = new Map();
  const unacked = new Map();
  let commands = [];
  let tag = 0;
  let hold = false;
  const held = [];
  const rejects = [];
  const faults = failures();
  const list = (name) => {
    if (!queues.has(name)) queues.set(name, []);
    return queues.get(name);
  };
  if (typeof init.queue === "string" && typeof init.deadLetterQueue === "string") routes.set(init.queue, init.deadLetterQueue);
  const settle = (raw) => {
    const found = unacked.get(raw.fields.deliveryTag);
    if (!found) throw new Error("PRECONDITION_FAILED - unknown delivery tag " + raw.fields.deliveryTag);
    unacked.delete(raw.fields.deliveryTag);
    return found;
  };
  const channel = {
    get: async (queue, options) => {
      commands.push({ method: "basic.get", queue, noAck: options?.noAck ?? false });
      faults.check("basic.get");
      const item = list(queue).shift();
      if (!item) return false;
      const deliveryTag = ++tag;
      unacked.set(deliveryTag, { queue, item });
      const headers = item.headers === null ? undefined : { ...item.headers };
      return {
        fields: { deliveryTag, redelivered: false, exchange: "", routingKey: queue, messageCount: list(queue).length },
        properties: { headers, messageId: item.messageId, contentType: item.contentType },
        content: Buffer.from(item.body, "utf8"),
      };
    },
    ack: (raw, allUpTo) => {
      commands.push({ method: "basic.ack", deliveryTag: raw.fields.deliveryTag, multiple: allUpTo ?? false });
      faults.check("basic.ack");
      settle(raw);
    },
    nack: (raw, allUpTo, requeue) => {
      commands.push({ method: "basic.nack", deliveryTag: raw.fields.deliveryTag, multiple: allUpTo ?? false, requeue: requeue ?? true });
      faults.check("basic.nack");
      const { queue, item } = settle(raw);
      if (requeue ?? true) {
        const count = Number(item.headers?.["x-delivery-count"] ?? 0);
        list(queue).unshift({ ...item, headers: { ...(item.headers ?? {}), "x-delivery-count": count + 1 } });
      } else if (routes.has(queue)) {
        const { "x-delivery-count": _, ...headers } = item.headers ?? {};
        list(routes.get(queue)).push({ ...item, headers });
      }
    },
    sendToQueue: (queue, content, options, callback) => {
      commands.push({
        method: "basic.publish",
        exchange: "",
        routingKey: queue,
        body: content.toString("utf8"),
        properties: { deliveryMode: options.persistent ? 2 : 1, messageId: options.messageId, contentType: options.contentType },
      });
      faults.check("basic.publish");
      const item = { body: content.toString("utf8"), headers: {}, messageId: options.messageId, contentType: options.contentType };
      const confirm = (error) => {
        if (!error) list(queue).push(item);
        callback(error ?? null);
      };
      const reject = rejects.shift();
      if (hold) held.push({ confirm, reject });
      else queueMicrotask(() => confirm(reject ? new Error(reject) : null));
      return true;
    },
    assertQueue: async (queue, options) => {
      commands.push({ method: "queue.declare", queue, durable: options.durable, arguments: options.arguments });
      faults.check("queue.declare");
      list(queue);
      if (options.arguments?.["x-dead-letter-routing-key"]) routes.set(queue, options.arguments["x-dead-letter-routing-key"]);
      return { queue, messageCount: list(queue).length, consumerCount: 0 };
    },
  };
  return {
    channel,
    methods: {
      // enqueue(queue, body, headers?): a message already in the broker (headers null: none).
      enqueue: (queue, body, headers) => {
        list(queue).push({ body, headers: headers === undefined ? {} : headers });
        return null;
      },
      // messages(queue) → [{body, headers}] waiting (not delivered) in the queue.
      messages: (queue) => list(queue).map(({ body, headers }) => ({ body, headers: headers ?? null })),
      // unacked() → delivery tags delivered and not settled, ascending.
      unacked: () => [...unacked.keys()].sort((a, b) => a - b),
      // rejectPublish(message): the broker nacks the next publish (confirm error).
      rejectPublish: (message) => (rejects.push(message ?? "nack"), null),
      // holdConfirms(): publishes wait for releaseConfirms() before they are confirmed.
      holdConfirms: () => ((hold = true), null),
      releaseConfirms: () => {
        hold = false;
        for (const { confirm, reject } of held.splice(0)) confirm(reject ? new Error(reject) : null);
        return null;
      },
      fail: (method, message, skip) => faults.add(method, message, given(skip)),
      takeCommands: () => {
        const taken = commands;
        commands = [];
        return taken;
      },
    },
  };
}

/**
 * RabbitQueue on the fake. init {queue ("jobs"), deadLetterQueue?}. provision(queue, dlq) builds
 * the adapter with createRabbitQueue instead. publishInBackground(message) starts a publish
 * without waiting for it; background() → {ok: true} | {error: message} once it settles.
 */
async function queueRabbit(init) {
  const rabbit = fakeRabbit(init);
  const state = { adapter: new RabbitQueue(rabbit.channel, init.queue ?? "jobs", given(init.deadLetterQueue)) };
  const proxy = {
    get capabilities() {
      return state.adapter.capabilities;
    },
    publish: (m) => state.adapter.publish(m),
    receive: (limit, signal) => state.adapter.receive(limit, signal),
    inspectFailures: (limit) => state.adapter.inspectFailures(limit),
    retryFailure: (token) => state.adapter.retryFailure(token),
  };
  let pending;
  return {
    ...queueFacade(proxy, init),
    ...rabbit.methods,
    provision: async (queue, deadLetterQueue) => {
      state.adapter = await createRabbitQueue(rabbit.channel, queue, deadLetterQueue);
      return null;
    },
    publishInBackground: async (message) => {
      pending = state.adapter.publish(message).then(
        () => ({ ok: true }),
        (error) => ({ error: error.message }),
      );
      await delay(0);
      return null;
    },
    background: () => pending ?? null,
  };
}

export const subjects = {
  "cache-redis": cacheRedis,
  "queue-sqs": queueSqs,
  "queue-rabbitmq": queueRabbit,
};
