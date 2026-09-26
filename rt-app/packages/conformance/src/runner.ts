import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import type { Case, Contract, Expectation, HttpExpectation } from "./contract.js";
import { READY } from "./host.js";
import { compare, expand, type Json } from "./values.js";

/**
 * A language implementation under test. `host` serves module contracts (host protocol);
 * `api` serves http contracts. Each is a URL of a running process or a command to start.
 */
export interface Target {
  name: string;
  host?: string | { command: string[]; cwd?: string; env?: Record<string, string> };
  api?: string | { command: string[]; cwd?: string; env?: Record<string, string>; port?: number; readyPath?: string };
}

export type Status = "passed" | "failed" | "missing" | "unrecorded" | "skipped";
export interface CaseResult {
  target: string;
  module: string;
  file?: string;
  name: string;
  tags: string[];
  status: Status;
  message?: string;
  ms: number;
}

class Missing extends Error {}

export interface Started { url: string; info?: Record<string, unknown>; stop(): Promise<void> }

function stopProcess(child: ChildProcess) {
  return new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode) return resolve();
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
}

/** Start (or connect to) a target's contract host; resolves when it announces readiness. */
export async function startHost(target: Target, { timeoutMs = 120000 } = {}): Promise<Started> {
  if (!target.host) throw new Error(`${target.name}: no host configured`);
  if (typeof target.host === "string") {
    const info = await (await fetch(target.host)).json();
    return { url: target.host, info, stop: async () => {} };
  }
  const { command, cwd, env } = target.host;
  const child = spawn(command[0], command.slice(1), { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${target.name}: host did not start in ${timeoutMs / 1000}s\n${output.slice(-2000)}`)), timeoutMs);
    const read = (chunk: Buffer) => {
      output += chunk.toString();
      const match = output.match(new RegExp(`${READY} (\\S+)`));
      if (match) { clearTimeout(timer); resolve(match[1]); }
    };
    child.stdout!.on("data", read);
    child.stderr!.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.once("error", (error) => { clearTimeout(timer); reject(new Error(`${target.name}: ${error.message}`)); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`${target.name}: host exited (${code}) before it was ready\n${output.slice(-2000)}`)); });
  });
  child.removeAllListeners("exit");
  const info = await (await fetch(url)).json();
  return { url, info, stop: () => stopProcess(child) };
}

/** A port that is free right now on 127.0.0.1. */
function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const { port } = server.address() as { port: number }; server.close(() => resolve(port)); });
  });
}

/** Start (or connect to) a target's API for http contracts; waits until readyPath answers. */
export async function startApi(target: Target, { timeoutMs = 120000 } = {}): Promise<Started> {
  if (!target.api) throw new Error(`${target.name}: no api configured`);
  if (typeof target.api === "string") return { url: target.api.replace(/\/$/, ""), stop: async () => {} };
  const { command, cwd, env, readyPath = "/health" } = target.api;
  const port = target.api.port ?? (await freePort());
  const child = spawn(command[0], command.slice(1), { cwd, env: { ...process.env, PORT: String(port), ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout!.on("data", (c: Buffer) => { output += c; });
  child.stderr!.on("data", (c: Buffer) => { output += c; });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${target.name}: API exited (${child.exitCode})\n${output.slice(-2000)}`);
    try { if ((await fetch(url + readyPath)).status < 500) return { url, stop: () => stopProcess(child) }; } catch { /* not listening yet */ }
    await delay(150);
  }
  await stopProcess(child);
  throw new Error(`${target.name}: API did not answer ${readyPath} in ${timeoutMs / 1000}s\n${output.slice(-2000)}`);
}

async function call(url: string, method: string, body?: unknown) {
  const response = await fetch(url, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = (await response.json().catch(() => ({ protocolError: `HTTP ${response.status} without JSON` }))) as any;
  if (response.status === 404 && data.protocolError) throw new Missing(data.protocolError);
  if (!response.ok || data.protocolError) throw new Error(`Host protocol error: ${data.protocolError ?? response.status}`);
  return data;
}

/** Compare an outcome ({value} or {error}) with an expectation; returns the difference. */
export function check(outcome: { ok: boolean; value?: Json; error?: any }, expected: Expectation): string | undefined {
  if (expected.error) {
    if (outcome.ok) return `expected error ${JSON.stringify(expected.error)}, got value ${JSON.stringify(outcome.value)?.slice(0, 200)}`;
    for (const [key, value] of Object.entries(expected.error)) {
      const diff = compare(outcome.error?.[key] ?? null, value as Json, `error.${key}`);
      if (diff) return `${diff} (${outcome.error?.type}: ${outcome.error?.message})`;
    }
    return undefined;
  }
  if (!outcome.ok) return `threw ${outcome.error?.type}${outcome.error?.status ? ` ${outcome.error.status}` : ""}: ${outcome.error?.message}`;
  return compare(outcome.value, expected.value ?? null, "value");
}

const toExpectation = (outcome: { ok: boolean; value?: Json; error?: any }): Expectation =>
  outcome.ok ? { value: outcome.value ?? null } : { error: Object.fromEntries(Object.entries(outcome.error ?? {}).filter(([k]) => k !== "type")) as Expectation["error"] };

/** Run one module case against a host: fresh instance, steps in order, instance deleted. */
async function runModuleCase(url: string, c: Case, recorded?: Map<string, Expectation>): Promise<{ status: Status; message?: string }> {
  const created = await call(`${url}/instances`, "POST", { subject: c.subject, init: expand(c.init) });
  if (c.create) {
    const diff = check(created.ok ? { ok: true, value: null } : created, expand(c.create as Json) as Expectation);
    if (diff) return { status: "failed", message: `create: ${diff}` };
    if (!created.ok) return { status: "passed" };
  } else if (!created.ok) return { status: "failed", message: `create threw ${created.error?.type}: ${created.error?.message}` };
  const instance = `${url}/instances/${encodeURIComponent(created.id)}`;
  const results: Json[] = [];
  let unrecorded = 0;
  try {
    for (const [i, step] of c.steps.entries()) {
      const outcome = await call(`${instance}/${step.call}`, "POST", { args: expand(step.args, results) as Json[] });
      results.push(outcome.ok ? { value: outcome.value ?? null } : { error: outcome.error });
      if (!step.expect) {
        if (recorded) recorded.set(`${c.name}\u0000${i}`, toExpectation(outcome));
        else unrecorded++;
        continue;
      }
      const diff = check(outcome, expand(step.expect as Json, results.slice(0, -1)) as Expectation);
      if (diff) return { status: "failed", message: `step ${i + 1} ${step.call}(${JSON.stringify(step.args).slice(1, -1).slice(0, 120)}): ${diff}${step.note ? ` — ${step.note}` : ""}` };
    }
  } finally {
    await call(instance, "DELETE").catch(() => undefined);
  }
  return unrecorded ? { status: "unrecorded", message: `${unrecorded} step(s) without expect; record them with --record on the reference target` } : { status: "passed" };
}

/** Run one http case: requests in order against the API base URL. */
async function runHttpCase(api: string, c: Case): Promise<{ status: Status; message?: string }> {
  const results: Json[] = [];
  for (const [i, { request, expect }] of c.requests.entries()) {
    const path = request.path + (request.query ? "?" + new URLSearchParams(request.query) : "");
    const body = typeof request.raw === "string" ? request.raw : request.body === undefined ? undefined : JSON.stringify(expand(request.body, results));
    const response = await fetch(api + path, { method: request.method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...request.headers }, body });
    const text = await response.text();
    let parsed: Json = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* keep text */ }
    results.push({ status: response.status, body: parsed });
    if (!expect) return { status: "unrecorded", message: `request ${i + 1} has no expect` };
    if (expect.status !== undefined && response.status !== expect.status) return { status: "failed", message: `request ${i + 1} ${request.method} ${request.path}: expected status ${expect.status}, got ${response.status} ${text.slice(0, 200)}` };
    if (expect.body !== undefined) {
      const diff = compare(parsed, expand(expect.body as Json, results.slice(0, -1)), "body");
      if (diff) return { status: "failed", message: `request ${i + 1} ${request.method} ${request.path}: ${diff}` };
    }
    for (const [name, value] of Object.entries(expect.headers ?? {})) {
      const diff = compare(response.headers.get(name), value, `headers.${name}`);
      if (diff) return { status: "failed", message: `request ${i + 1}: ${diff}` };
    }
  }
  return { status: "passed" };
}

export interface RunOptions {
  /** Only cases whose name or tags contain this text. */
  filter?: string;
  /** Collect expectations of steps without `expect` (write them with saveRecorded). */
  recorded?: Map<string, Map<string, Expectation>>;
  onResult?(result: CaseResult): void;
}

/** Run contracts against one target. Module contracts use its host, http contracts its API. */
export async function runTarget(target: Target, contracts: Contract[], options: RunOptions = {}): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  const selected = (c: Case) => !options.filter || c.name.includes(options.filter) || c.tags.includes(options.filter);
  const report = (r: CaseResult) => { results.push(r); options.onResult?.(r); };
  const needHost = contracts.some((c) => c.kind === "module"), needApi = contracts.some((c) => c.kind === "http");
  const host = needHost && target.host ? await startHost(target) : undefined;
  let api: Started | undefined;
  try {
    api = needApi && target.api ? await startApi(target) : undefined;
    for (const contract of contracts) {
      const recorded = options.recorded ? new Map<string, Expectation>() : undefined;
      if (recorded && contract.file) options.recorded!.set(contract.file, recorded);
      const subjects = (host?.info?.subjects as string[] | undefined) ?? [];
      for (const c of contract.cases) {
        const base = { target: target.name, module: contract.module, file: contract.file, name: c.name, tags: c.tags };
        if (!selected(c)) continue;
        const started = Date.now();
        if (contract.kind === "module" && !host) { report({ ...base, status: "skipped", message: "API-only target (no host)", ms: 0 }); continue; }
        if (contract.kind === "module" && !subjects.includes(c.subject)) { report({ ...base, status: "missing", message: `subject ${c.subject} is not implemented`, ms: 0 }); continue; }
        if (contract.kind === "http" && !api) { report({ ...base, status: "skipped", message: "no api configured", ms: 0 }); continue; }
        try {
          const outcome = contract.kind === "module" ? await runModuleCase(host!.url, c, recorded) : await runHttpCase(api!.url, c);
          report({ ...base, ...outcome, ms: Date.now() - started });
        } catch (error) {
          report({ ...base, status: error instanceof Missing ? "missing" : "failed", message: (error as Error).message, ms: Date.now() - started });
        }
      }
    }
  } finally {
    await Promise.all([host?.stop(), api?.stop()]);
  }
  return results;
}
