import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, main, initGit, USAGE } from "../index.mjs";

test("parses the name, options and rejects unknown or incomplete flags", () => {
  assert.deepEqual(parseArgs(["shop", "--template", "admin-crm", "--backend", "go", "--no-install", "--no-git", "--dir", "apps"]), {
    template: "admin-crm", backend: "go", dir: "apps", install: false, git: false, list: false, help: false, name: "shop",
  });
  assert.equal(parseArgs(["--list"]).list, true);
  assert.equal(parseArgs(["-h"]).help, true);
  assert.throws(() => parseArgs(["shop", "--force"]), /Unknown option --force/);
  assert.throws(() => parseArgs(["shop", "--template"]), /needs a value/);
  assert.throws(() => parseArgs(["a", "b"]), /Only one project name/);
});

test("creates in the current directory, commits and prints next steps", async () => {
  const lines = [], errors = [], calls = [];
  const code = await main(["shop"], {
    cwd: "/work",
    out: (l) => lines.push(l),
    err: (l) => errors.push(l),
    create: async (options) => { calls.push(options); options.onLog("Copying…"); return { path: "/work/shop", name: "shop" }; },
    git: (path) => path === "/work/shop",
  });
  assert.equal(code, 0);
  assert.deepEqual({ ...calls[0], onLog: undefined }, { workspace: "/work", name: "shop", templateId: "fullstack", backendId: "node-ts", install: true, onLog: undefined });
  assert.deepEqual(errors, ["Copying…"]);
  assert.ok(lines.includes("  cd shop"));
  assert.ok(lines.some((l) => l.includes("gh repo create --private --source . --push")));
});

test("help, list, missing name, failures and skipped git", async () => {
  const run = async (argv, extra = {}) => {
    const out = [], err = [];
    const code = await main(argv, { out: (l) => out.push(l), err: (l) => err.push(l), list: async () => [{ id: "fullstack" }], ...extra });
    return { code, out, err };
  };
  assert.deepEqual(await run(["--help"]), { code: 0, out: [USAGE], err: [] });
  assert.equal((await run(["--list"])).out[0], JSON.stringify([{ id: "fullstack" }], null, 2));
  assert.equal((await run([])).code, 1);
  const failed = await run(["shop"], { create: async () => { throw new Error("Invalid project name"); } });
  assert.deepEqual([failed.code, failed.err], [1, ["Invalid project name"]]);
  const noInstall = await run(["shop", "--no-install", "--dir", "/abs"], { create: async (o) => ({ path: o.workspace + "/shop", name: "shop" }), git: () => false });
  assert.ok(noInstall.out.includes("  cd /abs/shop") && noInstall.out.includes("  npm install"));
  assert.ok(noInstall.out.some((l) => l.includes("Git was not initialized")));
  const noGit = await run(["shop", "--no-git"], { create: async () => ({ path: "/x/shop", name: "shop" }), git: () => { throw new Error("must not run"); } });
  assert.equal(noGit.code, 0);
});

test("initGit makes one commit on main, and reports missing git", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "create-rt-app-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "README.md"), "# app\n");
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };
  const run = (cmd, args, options) => spawnSync(cmd, args, { ...options, env });
  assert.equal(initGit(dir, run), true);
  const log = spawnSync("git", ["log", "--oneline", "--format=%s", "main"], { cwd: dir, encoding: "utf8" });
  assert.equal(log.stdout.trim(), "Create application with RT-App");
  assert.equal(initGit(dir, () => ({ status: 1 })), false);
  let calls = 0;
  assert.equal(initGit(dir, () => ({ status: calls++ === 0 ? 0 : 1 })), false, "init failure");
});
