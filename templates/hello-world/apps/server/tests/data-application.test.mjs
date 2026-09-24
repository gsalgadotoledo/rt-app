import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const server = fileURLToPath(new URL("..", import.meta.url));
const root = fileURLToPath(new URL("../../..", import.meta.url));

// rta migrate/seed run from the project root; the dev server runs inside apps/server.
// Both must open the same JSON database.
test("migrate uses the server's JSON database regardless of the working directory", async (t) => {
  const relative = ".rt-app/test-" + process.pid + ".json";
  const file = server + relative;
  t.after(() => Promise.all([rm(file, { force: true }), rm(file + ".key", { force: true })]));
  const env = { ...process.env, RT_APP_MODE: "json", RT_APP_JSON_FILE: relative };
  const run = cwd => JSON.parse(execFileSync(process.execPath, [server + "dist/migrate.js", "up", "--json"], { cwd, env, encoding: "utf8" }));
  assert.ok(run(root).applied.length > 0);
  assert.ok(existsSync(file), "database created next to the server");
  assert.deepEqual(run(server).applied, [], "the server directory sees the same history");
});
