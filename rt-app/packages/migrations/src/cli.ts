import type { MigrationRunner, SeedRunner, RunnerOptions } from "./index.js";

/** What an application must expose for the migrate/seed commands (the framework app does). */
export interface MigratableApplication {
  environment: string;
  migrations(options?: Omit<RunnerOptions, "store" | "features">): MigrationRunner;
  seeds(options?: Omit<RunnerOptions, "store" | "features">): SeedRunner;
}

export const MIGRATE_USAGE = "Usage: rta migrate [status|up|down] [--to <id>] [--step <n>] [--json]";
export const SEED_USAGE = "Usage: rta seed [status|run] [--module <id>[,<id>]] [--rerun] [--json]";

/** Parse `--name value` flags; boolean flags are listed explicitly so typos fail. */
function parse(argv: string[], valueFlags: string[], booleanFlags: string[], usage: string) {
  const [action, ...rest] = argv[0] && !argv[0].startsWith("--") ? argv : ["", ...argv];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const name = rest[i].replace(/^--/, "");
    if (!rest[i].startsWith("--")) throw new Error(usage);
    if (booleanFlags.includes(name)) flags[name] = true;
    else if (valueFlags.includes(name) && rest[i + 1] !== undefined && !rest[i + 1].startsWith("--")) flags[name] = rest[++i];
    else throw new Error(usage);
  }
  return { action, flags };
}

function step(value: string | true | undefined, usage: string) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(usage);
  return n;
}

/**
 * `rta migrate`: status (default), up or down. Output goes to `out`; `--json` prints machine-readable
 * results. Throws on invalid arguments, locked runs and failed migrations.
 * @example await migrateCommand(app, ["down", "--step", "1"])  // → prints "Reverted: catalog:002"
 */
export async function migrateCommand(app: MigratableApplication, argv: string[], out: (line: string) => void = console.log) {
  const { action = "", flags } = parse(argv, ["to", "step"], ["json"], MIGRATE_USAGE);
  const json = flags.json === true;
  const log = json ? () => {} : (line: string) => out("  " + line);
  const runner = app.migrations({ log });
  const target = { ...(typeof flags.to === "string" ? { to: flags.to } : {}), ...(flags.step !== undefined ? { step: step(flags.step, MIGRATE_USAGE) } : {}) };
  if (action === "" || action === "status") {
    if (flags.to || flags.step !== undefined) throw new Error(MIGRATE_USAGE);
    const status = await runner.status();
    if (json) return out(JSON.stringify({ environment: app.environment, migrations: status }, null, 2));
    out(`Migrations (${app.environment}):`);
    for (const m of status) out(`  ${m.state.padEnd(8)} ${m.id}${m.description ? " — " + m.description : ""}${m.appliedAt ? " (" + m.appliedAt + ")" : ""}`);
    const pending = status.filter(m => m.state === "pending").length;
    out(pending ? `${pending} pending. Run: rta migrate up` : "Up to date.");
    return;
  }
  if (action !== "up" && action !== "down") throw new Error(MIGRATE_USAGE);
  const ids = action === "up" ? await runner.up(target) : await runner.down(target);
  if (json) return out(JSON.stringify({ environment: app.environment, [action === "up" ? "applied" : "reverted"]: ids }));
  out(ids.length ? `${action === "up" ? "Applied" : "Reverted"}: ${ids.join(", ")}` : "Nothing to " + (action === "up" ? "apply." : "revert."));
}

/**
 * `rta seed`: run (default) or status. Secrets come from `secrets` (e.g. DEMO_PASSWORD from the environment).
 * @example await seedCommand(app, ["--module", "users", "--rerun"], {DEMO_PASSWORD: "…"})
 */
export async function seedCommand(
  app: MigratableApplication,
  argv: string[],
  secrets: Record<string, string | undefined>,
  out: (line: string) => void = console.log,
) {
  const { action = "", flags } = parse(argv, ["module"], ["rerun", "json"], SEED_USAGE);
  const json = flags.json === true;
  const runner = app.seeds({ secrets, log: json ? () => {} : line => out("  " + line) });
  if (action === "status") {
    if (flags.module || flags.rerun) throw new Error(SEED_USAGE);
    const status = await runner.status();
    if (json) return out(JSON.stringify({ environment: app.environment, seeds: status }, null, 2));
    out(`Seeds (${app.environment}):`);
    for (const s of status) out(`  ${s.state.padEnd(8)} ${s.id}${s.description ? " — " + s.description : ""}`);
    return;
  }
  if (action !== "" && action !== "run") throw new Error(SEED_USAGE);
  const modules = typeof flags.module === "string" ? flags.module.split(",").map(m => m.trim()).filter(Boolean) : undefined;
  const ran = await runner.run({ modules, rerun: flags.rerun === true });
  if (json) return out(JSON.stringify({ environment: app.environment, seeded: ran }));
  out(ran.length ? "Seeded: " + ran.join(", ") : `No pending seeds for ${app.environment}.`);
}
