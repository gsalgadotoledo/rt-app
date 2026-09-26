// Contract host for the TypeScript/JavaScript implementations (reference target).
import { runHost } from "@gsalgadotoledo/rt-app-conformance";
import { MemoryStore } from "@gsalgadotoledo/rt-app-dynamodb";
import { FeatureFlags } from "@gsalgadotoledo/rt-app-feature-flags";

/** A memory store holding the given rows (as written by version-guarded creates). */
async function memoryStore(rows = []) {
  const store = new MemoryStore();
  if (rows.length) await store.transact(rows.map((row) => ({ row, expected: null })));
  return store;
}

await runHost({
  language: "javascript",
  subjects: {
    "nosql-memory": (init) => memoryStore(init.rows),
    "feature-flags": async (init) => new FeatureFlags(await memoryStore(init.rows)),
  },
});
