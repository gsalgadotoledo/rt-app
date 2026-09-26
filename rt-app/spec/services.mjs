#!/usr/bin/env node
/**
 * Throwaway databases for store contracts, then a command with their URLs in the environment:
 *
 *   node rt-app/spec/services.mjs --postgres --dynamodb -- npm run contracts
 *
 * - PostgreSQL: embedded-postgres (portable binaries from npm), a fresh cluster in a temp folder.
 *   → RT_APP_TEST_POSTGRES_URL
 * - DynamoDB Local: the official AWS jar (SHA-256 verified, cached in ~/.rt-app/cache), in memory.
 *   Needs Java 17+ on PATH or installed by the Service Manager toolchains.
 *   → RT_APP_TEST_DYNAMODB_ENDPOINT
 * Both listen on 127.0.0.1 on free ports and are removed when the command ends.
 */
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile, rename } from "node:fs/promises";
import { createServer, connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const DYNAMO_URL = "https://d1ni2b6xgvw0s0.cloudfront.net/v2.x/dynamodb_local_latest.tar.gz";
const CACHE = join(homedir(), ".rt-app", "cache", "dynamodb-local");

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

async function waitPort(port, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise((resolve) => { const socket = connect(port, "127.0.0.1", () => { socket.end(); resolve(true); }); socket.once("error", () => resolve(false)); });
    if (open) return;
    await delay(200);
  }
  throw new Error(`Nothing listening on ${port} after ${timeoutMs / 1000}s`);
}

/** Start a throwaway PostgreSQL cluster. */
export async function startPostgres() {
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  const dir = await mkdtemp(join(tmpdir(), "rt-app-pg-"));
  const port = await freePort();
  const password = randomBytes(18).toString("hex");
  const pg = new EmbeddedPostgres({ databaseDir: join(dir, "data"), user: "rtapp", password, port, persistent: false, onLog: () => {}, onError: () => {} });
  await pg.initialise();
  await pg.start();
  return {
    env: { RT_APP_TEST_POSTGRES_URL: `postgres://rtapp:${password}@127.0.0.1:${port}/postgres` },
    stop: async () => { await pg.stop().catch(() => {}); await rm(dir, { recursive: true, force: true }); },
  };
}

/** A Java 17+ binary: PATH first, then the Service Manager toolchains. */
export async function findJava() {
  const candidates = ["java"];
  try { candidates.push(...JSON.parse(await readFile(join(homedir(), ".rt-app", "service-manager", "toolchains", "paths.json"), "utf8")).map((p) => join(p, "java"))); } catch {}
  for (const java of candidates) {
    const result = spawnSync(java, ["-version"], { encoding: "utf8" });
    const version = Number(`${result.stderr}${result.stdout}`.match(/version "(\d+)/)?.[1]);
    if (!result.error && version >= 17) return java;
  }
  throw new Error("DynamoDB Local needs Java 17+. Install it (Service Manager → toolchains: Java) or put java on PATH.");
}

/** Download DynamoDB Local once (checksum verified) and return its folder. */
export async function dynamoLocal() {
  const sums = await (await fetch(DYNAMO_URL + ".sha256")).text();
  const expected = sums.trim().split(/\s+/)[0];
  if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error("Unexpected DynamoDB Local checksum file");
  const dir = join(CACHE, expected.slice(0, 16));
  if (existsSync(join(dir, "DynamoDBLocal.jar"))) return dir;
  const response = await fetch(DYNAMO_URL);
  if (!response.ok) throw new Error(`DynamoDB Local download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error("DynamoDB Local checksum mismatch");
  const stage = await mkdtemp(join(tmpdir(), "rt-app-ddb-"));
  await writeFile(join(stage, "ddb.tgz"), bytes);
  execFileSync("tar", ["-xzf", "ddb.tgz"], { cwd: stage });
  await rm(join(stage, "ddb.tgz"));
  await mkdir(CACHE, { recursive: true });
  await rename(stage, dir);
  return dir;
}

/** Start DynamoDB Local in memory. */
export async function startDynamo() {
  const [java, dir, port] = [await findJava(), await dynamoLocal(), await freePort()];
  const child = spawn(java, [`-Djava.library.path=${join(dir, "DynamoDBLocal_lib")}`, "-jar", join(dir, "DynamoDBLocal.jar"), "-inMemory", "-port", String(port)], { cwd: dir, stdio: "ignore" });
  await waitPort(port);
  return {
    env: { RT_APP_TEST_DYNAMODB_ENDPOINT: `http://127.0.0.1:${port}`, AWS_ACCESS_KEY_ID: "local", AWS_SECRET_ACCESS_KEY: "local", AWS_REGION: "us-east-1" },
    stop: async () => { child.kill("SIGTERM"); await delay(200); },
  };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const args = process.argv.slice(2);
  const split = args.indexOf("--");
  const flags = split < 0 ? args : args.slice(0, split), command = split < 0 ? [] : args.slice(split + 1);
  if (!command.length || flags.some((f) => !["--postgres", "--dynamodb"].includes(f))) {
    console.error("Usage: node rt-app/spec/services.mjs [--postgres] [--dynamodb] -- <command…>");
    process.exit(2);
  }
  const started = [];
  const stopAll = () => Promise.all(started.map((s) => s.stop()));
  try {
    if (flags.includes("--postgres")) { started.push(await startPostgres()); console.log("PostgreSQL ready"); }
    if (flags.includes("--dynamodb")) { started.push(await startDynamo()); console.log("DynamoDB Local ready"); }
  } catch (error) {
    await stopAll();
    console.error(error.message);
    process.exit(1);
  }
  const child = spawn(command[0], command.slice(1), { stdio: "inherit", env: { ...process.env, ...Object.assign({}, ...started.map((s) => s.env)) } });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("exit", async (code) => { await stopAll(); process.exit(code ?? 1); });
}
