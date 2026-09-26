import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { findContracts, loadContract, saveRecorded, type Contract, type Expectation } from "./contract.js";
import { runTarget, type CaseResult, type Target } from "./runner.js";

/**
 * contracts.json — where the contracts are and how to start each language:
 * ```json
 * {
 *   "contracts": ["contracts"],
 *   "reference": "node",
 *   "targets": {
 *     "node":   { "host": { "command": ["node", "hosts/node.mjs"] } },
 *     "python": { "host": { "command": ["python3", "-m", "rt_app.conformance"], "cwd": "../python" } },
 *     "go":     { "host": { "command": ["go", "run", "./cmd/contract-host"], "cwd": "../go" } }
 *   }
 * }
 * ```
 * Relative paths (contracts, cwd) are resolved from the config file's folder.
 */
export interface Config {
  contracts: string[];
  reference?: string;
  targets: Record<string, Omit<Target, "name">>;
}

export async function loadConfig(file: string): Promise<{ config: Config; targets: Target[]; contractPaths: string[] }> {
  const config = JSON.parse(await readFile(file, "utf8")) as Config;
  const base = dirname(resolve(file));
  const at = (p?: string) => (p ? resolve(base, p) : base);
  const targets = Object.entries(config.targets ?? {}).map(([name, t]) => ({
    name,
    ...(t.host ? { host: typeof t.host === "string" ? t.host : { ...t.host, cwd: at(t.host.cwd) } } : {}),
    ...(t.api ? { api: typeof t.api === "string" ? t.api : { ...t.api, cwd: at(t.api.cwd) } } : {}),
  }));
  return { config, targets, contractPaths: (config.contracts ?? []).map((p) => resolve(base, p)) };
}

const USAGE = `Usage:
  rta-contract test [paths…] [--config contracts.json] [--target name,…] [--filter text] [--record] [--json]
  rta-contract show [paths…] [--config contracts.json]      cases as a readable table (inputs → expected outputs)

  --record   run the reference target and write the outputs of steps that have no expect
  --target   only these targets (default: all in the config)
  --filter   only cases whose name contains the text or that have the tag`;

const ICON: Record<string, string> = { passed: "✓", failed: "✗", missing: "○", unrecorded: "?", skipped: "-" };

function args(argv: string[]) {
  const flags: Record<string, string | true> = {};
  const paths: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { paths.push(a); continue; }
    const name = a.slice(2);
    if (["record", "json", "help"].includes(name)) flags[name] = true;
    else if (["config", "target", "filter"].includes(name) && argv[i + 1] && !argv[i + 1].startsWith("--")) flags[name] = argv[++i];
    else throw new Error(USAGE);
  }
  return { flags, paths };
}

const brief = (v: unknown) => { const s = JSON.stringify(v); return s.length > 70 ? s.slice(0, 67) + "…" : s; };

function show(contracts: Contract[], out: (line: string) => void) {
  for (const contract of contracts) {
    out(`\n${contract.module}${contract.title ? " — " + contract.title : ""}  (${contract.cases.length} cases, ${contract.kind})`);
    if (contract.description) out("  " + contract.description.trim().split("\n").join("\n  "));
    for (const c of contract.cases) {
      out(`\n  • ${c.name}${c.tags.length ? `  [${c.tags.join(", ")}]` : ""}`);
      if (contract.kind === "module") {
        if (c.init && JSON.stringify(c.init) !== "{}") out(`      init ${brief(c.init)}`);
        if (c.create) out(`      create → ${c.create.error ? "error " + brief(c.create.error) : "ok"}`);
        for (const s of c.steps) out(`      ${s.call}(${brief(s.args).slice(1, -1)}) → ${!s.expect ? "(not recorded)" : s.expect.error ? "error " + brief(s.expect.error) : brief(s.expect.value)}`);
      } else for (const r of c.requests) out(`      ${r.request.method} ${r.request.path}${r.request.body !== undefined ? " " + brief(r.request.body) : ""} → ${r.expect?.status ?? "?"} ${r.expect?.body !== undefined ? brief(r.expect.body) : ""}`);
    }
  }
}

/** CLI entry; returns the exit code. */
export async function main(argv: string[], out: (line: string) => void = console.log): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "help") { out(USAGE); return command ? 0 : 1; }
  const { flags, paths } = args(rest);
  const configFile = typeof flags.config === "string" ? flags.config : paths.length ? undefined : "contracts.json";
  const loaded = configFile ? await loadConfig(configFile) : undefined;
  const files = await findContracts(paths.length ? paths.map((p) => resolve(p)) : loaded?.contractPaths ?? []);
  if (!files.length) throw new Error("No contracts found (*.contract.yaml|yml|json)");
  const contracts = await Promise.all(files.map(loadContract));
  if (command === "show") { show(contracts, out); return 0; }
  if (command !== "test") throw new Error(USAGE);
  if (!loaded) throw new Error("test needs --config (targets to run)");
  const wanted = typeof flags.target === "string" ? flags.target.split(",") : flags.record ? [loaded.config.reference ?? loaded.targets[0]?.name] : loaded.targets.map((t) => t.name);
  const targets = loaded.targets.filter((t) => wanted.includes(t.name));
  if (!targets.length) throw new Error(`No such target: ${wanted.join(", ")}`);
  if (flags.record && targets.length !== 1) throw new Error("--record runs exactly one (reference) target");
  const all: CaseResult[] = [];
  for (const target of targets) {
    const recorded = flags.record ? new Map<string, Map<string, Expectation>>() : undefined;
    if (!flags.json) out(`\n${target.name}`);
    const results = await runTarget(target, contracts, {
      filter: typeof flags.filter === "string" ? flags.filter : undefined,
      recorded,
      onResult: (r) => { if (!flags.json) out(`  ${ICON[r.status]} ${r.module} · ${r.name}${r.message && r.status !== "passed" ? `\n      ${r.message}` : ""}`); },
    });
    all.push(...results);
    if (recorded) for (const contract of contracts) {
      const written = await saveRecorded(contract, recorded.get(contract.file!) ?? new Map());
      if (written) out(`  recorded ${written} expectation(s) in ${relative(process.cwd(), contract.file!)}`);
    }
  }
  const summary = targets.map((t) => {
    const r = all.filter((x) => x.target === t.name);
    const count = (s: string) => r.filter((x) => x.status === s).length;
    return { target: t.name, passed: count("passed"), failed: count("failed"), missing: count("missing"), unrecorded: count("unrecorded"), skipped: count("skipped") };
  });
  if (flags.json) out(JSON.stringify({ summary, results: all }, null, 2));
  else {
    out("\n" + ["target", "passed", "failed", "missing", "unrecorded"].map((h) => h.padEnd(11)).join(""));
    for (const s of summary) out([s.target, s.passed, s.failed, s.missing, s.unrecorded].map((v) => String(v).padEnd(11)).join(""));
  }
  return all.some((r) => r.status === "failed" || r.status === "unrecorded") ? 1 : 0;
}
