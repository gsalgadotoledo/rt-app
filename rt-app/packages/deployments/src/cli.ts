import { ENVIRONMENTS, ROLES, type DeployEnvironment, type Role } from "@gsalgadotoledo/rt-app-deploy";
import {
  applyDeployment,
  connectGithub,
  credentialStatus,
  deploymentStatus,
  loadRegistry,
  planDeployment,
  readDeploySettings,
  saveCredential,
  syncGithub,
  RUNTIME_SECRETS,
  type Runner,
} from "./index.js";

export const DEPLOY_USAGE = `Usage:
  rta deploy providers [--json]                 providers and the roles they serve
  rta deploy plan   --env develop|stage|prod [--role api] [--json]
  rta deploy apply  --env develop|stage|prod [--role api] [--json]
  rta deploy status --env develop|stage|prod [--json]
  rta deploy credentials --env stage [--json]   which API keys are present (never values)
  rta deploy credentials set --env stage KEY    reads the value from stdin
  (AWS outputs: rta deploy <outputs.json>)`;

export const GITHUB_USAGE = `Usage:
  rta github connect [--public] [--name owner/repo]   create the repo and push
  rta github sync [--env stage]                       environments + secrets (local keys and runtime secrets)`;

interface Io {
  root: string;
  env?: Record<string, string | undefined>;
  out?: (line: string) => void;
  stdin?: () => Promise<string>;
  run?: Runner;
  fetch?: typeof fetch;
  registry?: Awaited<ReturnType<typeof loadRegistry>>;
}

/**
 * In GitHub Actions the workflow passes every environment secret as RT_APP_SECRETS_JSON
 * (`toJSON(secrets)`), so new providers need no workflow edits. Explicit variables win.
 */
export function withCiSecrets(env: Record<string, string | undefined>) {
  if (!env.RT_APP_SECRETS_JSON) return env;
  let secrets: Record<string, unknown>;
  try {
    secrets = JSON.parse(env.RT_APP_SECRETS_JSON);
  } catch {
    throw new Error("RT_APP_SECRETS_JSON is not valid JSON");
  }
  const strings = Object.fromEntries(Object.entries(secrets).filter(([key, value]) => typeof value === "string" && key !== "github_token"));
  return { ...strings, ...env, RT_APP_SECRETS_JSON: undefined } as Record<string, string | undefined>;
}

function flags(argv: string[], values: string[], booleans: string[], usage: string) {
  const positional: string[] = [];
  const result: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) positional.push(arg);
    else if (booleans.includes(arg.slice(2))) result[arg.slice(2)] = true;
    else if (values.includes(arg.slice(2)) && argv[i + 1] && !argv[i + 1].startsWith("--")) result[arg.slice(2)] = argv[++i];
    else throw new Error(usage);
  }
  return { positional, flags: result };
}

function environmentOf(value: string | true | undefined, usage: string) {
  if (typeof value !== "string" || !ENVIRONMENTS.includes(value as DeployEnvironment)) throw new Error(usage);
  return value as DeployEnvironment;
}

function rolesOf(value: string | true | undefined, usage: string) {
  if (value === undefined) return undefined;
  const roles = String(value).split(",");
  if (roles.some((role) => !ROLES.includes(role as Role))) throw new Error(usage);
  return roles as Role[];
}

/** `rta deploy …` (provider targets). Returns nothing; prints through `out`. Throws on errors. */
export async function deployCommand(argv: string[], io: Io) {
  const out = io.out ?? console.log;
  const [action, ...rest] = argv;
  const { positional, flags: f } = flags(rest, ["env", "role"], ["json"], DEPLOY_USAGE);
  const json = f.json === true;
  const registry = io.registry ?? (await loadRegistry());
  const base = { root: io.root, env: withCiSecrets(io.env ?? process.env), registry, fetch: io.fetch, run: io.run, log: json ? () => {} : (line: string) => out("  " + line) };
  if (action === "providers") {
    const catalog = registry.catalog();
    if (json) return out(JSON.stringify(catalog, null, 2));
    for (const p of catalog) out(`${p.id.padEnd(13)} ${p.roles.join(", ").padEnd(34)} ${p.credentials.map((c) => c.key + (c.optional ? "?" : "")).join(" ")}`);
    return;
  }
  if (action === "credentials") {
    const environment = environmentOf(f.env, DEPLOY_USAGE);
    if (positional[0] === "set") {
      if (!positional[1]) throw new Error(DEPLOY_USAGE);
      const value = ((await io.stdin?.()) ?? "").trim();
      if (!value) throw new Error("Pipe the value through stdin, e.g. pbpaste | rta deploy credentials set --env stage RENDER_API_KEY");
      await saveCredential(io.root, environment, positional[1], value);
      return out(`Saved ${positional[1]} for ${environment} in .rt-app/credentials.json (local, not committed). Push it with: rta github sync --env ${environment}`);
    }
    const { deploy } = await readDeploySettings(io.root, registry);
    const status = (await credentialStatus(io.root, registry, deploy, base.env))[environment];
    if (json) return out(JSON.stringify(status, null, 2));
    if (!status.length) return out(`No providers configured for ${environment}.`);
    for (const p of status) out(`${p.provider}: ${p.credentials.map((c: any) => `${c.key} ${c.present ? "✓" : c.optional ? "–" : "✗"}`).join("  ")}`);
    return;
  }
  const environment = environmentOf(f.env, DEPLOY_USAGE);
  const roles = rolesOf(f.role, DEPLOY_USAGE);
  if (action === "plan") {
    const plans = await planDeployment({ ...base, environment, roles });
    if (json) return out(JSON.stringify(plans, null, 2));
    if (!plans.length) return out(`Nothing to plan for ${environment} (no provider roles, or AWS only).`);
    for (const plan of plans) for (const a of plan.actions) out(`${plan.role.padEnd(9)} ${plan.provider.padEnd(13)} ${a.action.padEnd(7)} ${a.resource} — ${a.detail}`);
    return;
  }
  if (action === "apply") {
    const { results } = await applyDeployment({ ...base, environment, roles });
    if (json) return out(JSON.stringify(results.map(({ provider, role, url, resources }) => ({ provider, role, url, resources })), null, 2));
    if (!results.length) return out(`Nothing to apply for ${environment}.`);
    for (const r of results) out(`${r.role.padEnd(9)} ${r.provider.padEnd(13)} ${r.url ?? "(no public URL)"}`);
    return;
  }
  if (action === "status") {
    const statuses = await deploymentStatus({ ...base, environment });
    if (json) return out(JSON.stringify(statuses, null, 2));
    for (const s of statuses as any[]) out(`${s.role.padEnd(9)} ${s.provider.padEnd(13)} ${s.state.padEnd(9)} ${s.url ?? s.detail ?? ""}`);
    return;
  }
  throw new Error(DEPLOY_USAGE);
}

/** `rta github connect|sync`. */
export async function githubCommand(argv: string[], io: Io) {
  const out = io.out ?? console.log;
  const [action, ...rest] = argv;
  const { flags: f } = flags(rest, ["env", "name"], ["public", "json"], GITHUB_USAGE);
  if (action === "connect") {
    const result = connectGithub(io.root, { run: io.run, visibility: f.public ? "public" : "private", name: typeof f.name === "string" ? f.name : undefined });
    return out(result.created ? `Created and pushed ${result.repository}` : `Already connected to ${result.repository}`);
  }
  if (action === "sync") {
    const env = io.env ?? process.env;
    const environments = f.env ? [environmentOf(f.env, GITHUB_USAGE)] : undefined;
    const secrets = Object.fromEntries(RUNTIME_SECRETS.map((key) => [key, env[key]]));
    const result = await syncGithub(io.root, { run: io.run, environments, secrets });
    if (f.json) return out(JSON.stringify(result, null, 2));
    out(`GitHub ${result.repository}:`);
    for (const [environment, keys] of Object.entries(result.secrets)) out(`  ${environment}: ${keys.length ? keys.join(", ") : "environment ready, no secrets yet"}`);
    return;
  }
  throw new Error(GITHUB_USAGE);
}
