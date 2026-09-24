import test from "node:test";
import assert from "node:assert/strict";
import { NoSQLCache } from "../dist/index.js";
import { Conflict } from "@gsalgadotoledo/rt-app-contracts";

test("cache deletion is idempotent and conflict retries are bounded", async () => {
  let attempts = 0,
    row;
  const store = {
    get: async () => row,
    transact: async () => {
      attempts++;
      throw new Conflict();
    },
  };
  const cache = new NoSQLCache(store);
  await cache.delete("missing");
  assert.equal(attempts, 0);
  await assert.rejects(cache.set("key", 1, 100), Conflict);
  assert.equal(attempts, 4);
  const error = Error("storage unavailable");
  attempts = 0;
  store.transact = async () => {
    attempts++;
    throw error;
  };
  await assert.rejects(cache.set("key", 1, 100), (e) => e === error);
  assert.equal(attempts, 1);
});
