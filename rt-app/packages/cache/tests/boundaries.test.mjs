import test from "node:test";
import assert from "node:assert/strict";
import { Cache, MemoryCache, canonical, contentKey } from "../dist/index.js";

test("facade returns cloned false/null values and invalid entries never reach storage", async () => {
  const cache = new Cache(new MemoryCache(2));
  await cache.set("false", false, 1000);
  await cache.set("null", null, 1000);
  assert.equal(await cache.get("false"), false);
  assert.equal(await cache.get("null"), null);
  await cache.delete("false");
  assert.equal(await cache.get("false"), undefined);
  for (const ttl of [0, -1, Infinity, 1.5, 30 * 86400000 + 1])
    await assert.rejects(cache.set("key", 1, ttl), TypeError);
  await assert.rejects(cache.set("", 1, 10), TypeError);
  await assert.rejects(cache.set("key", "x".repeat(64001), 10), /64 KB/);
  assert.throws(() => new MemoryCache(0), TypeError);
  assert.throws(() => contentKey("bad namespace", {}), TypeError);
  const cyclic = {};
  cyclic.self = cyclic;
  for (const value of [undefined, NaN, Infinity, new Date(), 1n, cyclic])
    assert.throws(() => canonical(value), TypeError);
  assert.equal(
    canonical([null, false, 12, { z: 1, a: "x" }]),
    '[null,false,12,{"a":"x","z":1}]',
  );
});

test("expiry removes entries, cache hits skip loader and failures permit a fresh attempt", async () => {
  let now = 0,
    calls = 0;
  const adapter = new MemoryCache(1, () => now),
    cache = new Cache(adapter);
  await adapter.set("old", 1, 1);
  now = 2;
  await adapter.set("new", 2, 100);
  assert.equal(await adapter.get("old"), undefined);
  const load = () => {
    calls++;
    return { value: 1 };
  };
  await cache.remember("test", {}, 100, load);
  const hit = await cache.remember("test", {}, 100, load);
  hit.value = 99;
  assert.equal((await cache.remember("test", {}, 100, load)).value, 1);
  assert.equal(calls, 1);
  await assert.rejects(
    cache.remember("fail", {}, 100, () => {
      throw Error("load failed");
    }),
    /load failed/,
  );
  assert.equal(await cache.remember("fail", {}, 100, () => 7), 7);
});
