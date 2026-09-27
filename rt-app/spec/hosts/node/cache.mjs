// Subjects: cache-memory, cache-nosql, cache-file, cache-dynamodb (optional).
// Every subject is a facade over `new Cache(adapter)` with a settable clock (epoch ms). Other
// languages expose the same method names with the same positional arguments (cache contracts).
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Cache, MemoryCache, canonical, contentKey, validateEntry } from "@gsalgadotoledo/rt-app-cache";
import { NoSQLCache } from "@gsalgadotoledo/rt-app-cache-nosql";
import { FileCache } from "@gsalgadotoledo/rt-app-cache-file";
import { DynamoCache } from "@gsalgadotoledo/rt-app-cache-dynamodb";
import { JsonStore } from "@gsalgadotoledo/rt-app-json";
import { DynamoStore } from "@gsalgadotoledo/rt-app-dynamodb";
import { Conflict } from "@gsalgadotoledo/rt-app-contracts";
import { DynamoDBClient, CreateTableCommand, DeleteTableCommand } from "@aws-sdk/client-dynamodb";
import { memoryStore } from "./storage.mjs";

// Wire null means "not given": optional TypeScript parameters receive undefined, not null.
const given = (value) => (value === null ? undefined : value);

/** A settable clock in epoch milliseconds, starting at init.now (2100-01-01 when absent). */
function clock(init) {
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

/**
 * A store whose next transactions can fail on purpose, one queued fault per transaction:
 * "ok" passes through, "conflict" throws Conflict and "error" throws Error("Store unavailable")
 * (both without writing), "lostAck" writes and then throws Error("Acknowledgement lost").
 */
export function faultyStore(store) {
  const faults = [];
  let transacts = 0;
  return {
    get: (pk, sk) => store.get(pk, sk),
    list: (pk, cursor) => store.list(pk, cursor),
    async transact(writes) {
      transacts++;
      const fault = faults.shift();
      if (fault === "conflict") throw new Conflict();
      if (fault === "error") throw new Error("Store unavailable");
      await store.transact(writes);
      if (fault === "lostAck") throw new Error("Acknowledgement lost");
    },
    inject(kind, count) {
      if (!["ok", "conflict", "error", "lostAck"].includes(kind)) throw new TypeError("Unknown fault " + kind);
      for (let i = 0; i < (count ?? 1); i++) faults.push(kind);
      return null;
    },
    transacts: () => transacts,
  };
}

/** The shared surface: Cache methods plus loader bookkeeping and the clock. `state.cache` may be replaced. */
function facade(state, time, extra = {}) {
  let loads = 0;
  const loader = (outcome) => () => {
    loads++;
    if (outcome && typeof outcome.error === "string") throw new Error(outcome.error);
    return outcome?.value ?? null;
  };
  return {
    // get(key) → {hit:false} | {hit:true, value}: wire null cannot tell a miss from a cached null.
    get: async (key) => {
      const value = await state.cache.get(key);
      return value === undefined ? { hit: false } : { hit: true, value };
    },
    set: async (key, value, ttlMs) => (await state.cache.set(key, value, ttlMs), null),
    delete: async (key) => (await state.cache.delete(key), null),
    // remember(namespace, input, ttlMs, outcome): the loader returns outcome.value or throws outcome.error.
    remember: (namespace, input, ttlMs, outcome) => state.cache.remember(namespace, input, ttlMs, loader(outcome)),
    loads: () => loads,
    // `count` concurrent remember calls whose loader takes 50 ms → {loads, results}.
    rememberConcurrently: async (namespace, input, ttlMs, value, count) => {
      const before = loads;
      const slow = async () => {
        loads++;
        await delay(50);
        return value;
      };
      const results = await Promise.all(Array.from({ length: count }, () => state.cache.remember(namespace, input, ttlMs, slow)));
      return { loads: loads - before, results };
    },
    canonical: (value) => canonical(value),
    contentKey: (namespace, input) => contentKey(namespace, input),
    validateEntry: (key, ttlMs) => (validateEntry(key, ttlMs), null),
    setNow: (ms) => time.set(ms),
    ...extra,
  };
}

function memory(init) {
  const time = clock(init);
  return facade({ cache: new Cache(new MemoryCache(given(init.capacity), time.now)) }, time);
}

/** NoSQLCache over a MemoryStore holding init.rows, with fault injection. */
async function nosql(init) {
  const time = clock(init);
  const store = faultyStore(await memoryStore(init.rows));
  const state = { cache: new Cache(new NoSQLCache(store, given(init.namespace), time.now)) };
  return facade(state, time, {
    row: async (pk, sk) => (await store.get(pk, sk)) ?? null,
    injectFaults: (kind, count) => store.inject(kind, given(count)),
    transacts: () => store.transacts(),
    // useNamespace(ns): the same store seen through another namespace (loader counts are kept).
    useNamespace: (namespace) => ((state.cache = new Cache(new NoSQLCache(store, namespace, time.now))), null),
  });
}

/** FileCache on a fresh temporary file; reopen() builds a second instance on the same file. */
async function file(init) {
  const time = clock(init);
  const dir = await mkdtemp(join(tmpdir(), "rt-contract-cache-"));
  const path = join(dir, "cache.json");
  const build = () => new Cache(new FileCache(path, given(init.namespace), time.now));
  const state = { cache: build() };
  return facade(state, time, {
    row: async (pk, sk) => (await new JsonStore(path).get(pk, sk)) ?? null,
    reopen: () => ((state.cache = build()), null),
    // file() → the parsed file content ({format:1, rows:[…]}), or null before the first write.
    file: async () => {
      try {
        return JSON.parse(await readFile(path, "utf8"));
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    },
    close: () => rm(dir, { recursive: true, force: true }),
  });
}

/** DynamoCache on a fresh DynamoDB Local table (RT_APP_TEST_DYNAMODB_ENDPOINT); deleted on close. */
async function dynamo(init) {
  const time = clock(init);
  const endpoint = process.env.RT_APP_TEST_DYNAMODB_ENDPOINT;
  const table = `rt_contract_cache_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`;
  const client = new DynamoDBClient({ endpoint, region: "us-east-1" });
  await client.send(new CreateTableCommand({
    TableName: table,
    BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "sk", AttributeType: "S" }],
    KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }],
  }));
  const adapter = new DynamoCache(table, { endpoint, region: "us-east-1" }, given(init.namespace), time.now);
  const store = new DynamoStore(table, { endpoint, region: "us-east-1" });
  return facade({ cache: new Cache(adapter) }, time, {
    row: async (pk, sk) => (await store.get(pk, sk)) ?? null,
    close: async () => {
      await client.send(new DeleteTableCommand({ TableName: table })).catch(() => {});
      client.destroy();
    },
  });
}

export const subjects = {
  "cache-memory": memory,
  "cache-nosql": nosql,
  "cache-file": file,
  ...(process.env.RT_APP_TEST_DYNAMODB_ENDPOINT ? { "cache-dynamodb": dynamo } : {}),
};
