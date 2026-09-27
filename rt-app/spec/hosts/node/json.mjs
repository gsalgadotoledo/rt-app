// Subject: json-store (@gsalgadotoledo/rt-app-json JsonStore: file format, locking, retention, secret file).
// Every instance owns a fresh temporary directory; the database is "db.json" there (or init.path,
// relative to it). File helpers take names relative to that directory; close() removes it.
// The nosql-json subject (the shared store contract) lives in storage.mjs.
import { chmod, mkdtemp, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonStore } from "@gsalgadotoledo/rt-app-json";

const DEFAULT_NOW = 1767225600000; // 2026-01-01T00:00:00.000Z

/** localSecret lives in the generated server (TypeScript source); Node >= 22.18 strips its types. */
const localSecret = async (database) =>
  (await import("../../../packages/create/starter/apps/server/src/local-secret.ts")).localSecret(database);

const missing = async (read) => {
  try {
    return await read();
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};

async function jsonStore(init) {
  const dir = await mkdtemp(join(tmpdir(), "rt-contract-json-"));
  const file = join(dir, init.path ?? "db.json");
  let now = typeof init.now === "number" ? init.now : DEFAULT_NOW;
  const open = () => new JsonStore(file, init.lockTimeout ?? undefined, { now: () => now });
  if (typeof init.text === "string") await writeFile(file, init.text);
  const store = open();
  if (init.rows?.length) await store.transact(init.rows.map((row) => ({ row, expected: null })));
  const path = (name) => (name == null ? file : join(dir, name));
  return {
    get: async (pk, sk) => (await store.get(pk, sk)) ?? null,
    transact: async (writes) => (await store.transact(writes), null),
    list: (pk, cursor) => store.list(pk, cursor ?? undefined),
    // race(writes, count): `count` store instances run the same transaction at once.
    race: async (writes, count) => {
      const results = await Promise.allSettled(Array.from({ length: count }, () => open().transact(writes)));
      const failed = results.filter((r) => r.status === "rejected");
      return {
        committed: results.length - failed.length,
        conflicts: failed.filter((r) => r.reason?.status === 409).length,
        errors: failed.filter((r) => r.reason?.status !== 409).map((r) => r.reason?.message),
      };
    },
    // The file as another process or language sees it.
    document: () => missing(async () => JSON.parse(await readFile(file, "utf8"))),
    text: (name) => missing(() => readFile(path(name), "utf8")),
    writeText: async (text, name) => (await writeFile(path(name), text), null),
    remove: async (name) => (await unlink(path(name)), null),
    // Octal permission bits ("600"), or null when the file does not exist.
    mode: (name) => missing(async () => ((await stat(path(name))).mode & 0o777).toString(8)),
    chmod: async (mode, name) => (await chmod(path(name), parseInt(mode, 8)), null),
    files: async () => (await readdir(dir)).sort(),
    lock: async () => (await writeFile(file + ".lock", ""), null),
    unlock: async () => (await unlink(file + ".lock"), null),
    setNow: (ms) => ((now = ms), null),
    // The auth key of the generated server, stored next to the database: "<file>.key".
    localSecret: () => localSecret(file),
    close: () => rm(dir, { recursive: true, force: true }),
  };
}

export const subjects = { "json-store": jsonStore };
