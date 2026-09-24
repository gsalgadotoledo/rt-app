/**
 * Fly.io deploy provider (`flyio`): the API role as a Fly App built by Fly's remote builder.
 *
 * Apps are created and inspected with the Machines REST API (https://fly.io/docs/machines/api/).
 * Building an image from source is not part of that API, so secrets and deployments go through the
 * official `flyctl` CLI (https://fly.io/docs/flyctl/): `flyctl secrets import --stage` reads
 * NAME=VALUE pairs from stdin and `flyctl deploy --remote-only` builds and rolls out the release.
 * The token only ever travels in the child process environment (FLY_API_TOKEN), never in argv.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ProviderError,
  createApi,
  redact,
  resourceName,
  type DeployContext,
  type DeployPlan,
  type DeployProvider,
  type DeployResult,
  type DeployStatus,
  type PlannedAction,
} from "@gsalgadotoledo/rt-app-deploy";

const PROVIDER = "Fly.io";
const API_BASE = "https://api.machines.dev/v1";
const INSTALL_HINT = "Install flyctl: https://fly.io/docs/flyctl/install/";
/** Region IDs from https://fly.io/docs/reference/regions/ */
export const FLY_REGIONS = ["ams", "arn", "bom", "cdg", "dfw", "ewr", "fra", "gru", "iad", "jnb", "lax", "lhr", "nrt", "ord", "sin", "sjc", "syd", "yyz"];

// ---------------------------------------------------------------------------
// Command runner
// ---------------------------------------------------------------------------

export interface RunOptions {
  cwd?: string;
  env: Record<string, string | undefined>;
  /** Written to stdin, then stdin is closed. */
  input?: string;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a command without a shell. Rejects (error.code "ENOENT") when the binary is missing. */
export type Runner = (command: string, args: string[], options: RunOptions) => Promise<RunResult>;

/** Default runner: `child_process.spawn` without a shell, capturing stdout and stderr. */
export const spawnRunner: Runner = (command, args, options) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(options.input ?? "");
  });

// ---------------------------------------------------------------------------
// Secrets and configuration files
// ---------------------------------------------------------------------------

/**
 * Encode variables for `flyctl secrets import` (stdin). Every value is wrapped in triple quotes,
 * which flyctl's parser takes literally, including newlines. Values that parser would still
 * misread (a line containing `"""`, `\r`, a `#` it would treat as a comment, lines over 60k
 * characters) are rejected by name so nothing is silently truncated.
 * @example encodeSecrets({ A: "x#1" }) // 'A="""x#1"""\n'
 */
export function encodeSecrets(variables: Record<string, string>) {
  let text = "";
  for (const [name, value] of Object.entries(variables)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new ProviderError(PROVIDER, 0, `Invalid secret name: ${name}`);
    const lines = value.split("\n");
    const firstBeforeHash = ('"""' + lines[0]).split("#");
    const commentCut = firstBeforeHash.length > 1 && (firstBeforeHash[0].match(/"/g) ?? []).length % 2 === 0;
    const unsafe = value.includes("\r") || lines.some((line) => line.includes('"""') || line.length > 60_000) || commentCut;
    if (unsafe) throw new ProviderError(PROVIDER, 0, `Secret ${name} cannot be passed to flyctl secrets import safely; set it with the Fly dashboard`);
    text += `${name}="""${value}"""\n`;
  }
  return text;
}

export interface FlyTomlOptions {
  app: string;
  region: string;
  port: number;
  autoStop: string;
  builder?: string;
  setPort: boolean;
}

/** Minimal fly.toml: app, primary region, optional buildpacks builder and one HTTPS service. */
export function flyToml(options: FlyTomlOptions) {
  const lines = [`app = ${JSON.stringify(options.app)}`, `primary_region = ${JSON.stringify(options.region)}`, ""];
  if (options.builder) lines.push("[build]", `  builder = ${JSON.stringify(options.builder)}`, "");
  // Fly does not inject PORT; set it so `listen(process.env.PORT)` matches internal_port.
  if (options.setPort) lines.push("[env]", `  PORT = "${options.port}"`, "");
  lines.push(
    "[http_service]",
    `  internal_port = ${options.port}`,
    "  force_https = true",
    `  auto_stop_machines = ${JSON.stringify(options.autoStop)}`,
    `  auto_start_machines = ${options.autoStop !== "off"}`,
    "  min_machines_running = 0",
    "",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface FlyProviderOptions {
  /** Command runner; tests inject a fake. Defaults to spawnRunner. */
  run?: Runner;
  /** Local checkout that `source.directory` is relative to. Defaults to process.cwd(). */
  root?: string;
  /** flyctl binary name or path. Defaults to "flyctl". */
  flyctl?: string;
  /** Base environment for flyctl (PATH, HOME…). Defaults to process.env. */
  env?: Record<string, string | undefined>;
}

interface Target {
  name: string;
  org: string;
  region: string;
  port: number;
  autoStop: string;
  builder?: string;
  ha: boolean;
  directory: string;
  dockerfile?: string;
}

/**
 * Build the Fly.io provider with an injectable command runner.
 * @example createFlyProvider({ run: async () => ({ code: 0, stdout: "", stderr: "" }), root: "/repo" })
 */
export function createFlyProvider(options: FlyProviderOptions = {}): DeployProvider {
  const run = options.run ?? spawnRunner;
  const flyctl = options.flyctl ?? "flyctl";

  function token(context: DeployContext) {
    const value = context.credentials.FLY_API_TOKEN;
    if (!value) throw new ProviderError(PROVIDER, 0, "FLY_API_TOKEN is required");
    return value;
  }

  function secretsOf(context: DeployContext) {
    return [token(context), ...Object.values(context.variables)];
  }

  function api(context: DeployContext) {
    return createApi({
      provider: PROVIDER,
      baseUrl: API_BASE,
      headers: { authorization: `Bearer ${token(context)}` },
      fetch: context.fetch,
      secrets: secretsOf(context),
    });
  }

  /** Validated app name, org, region, port and local source paths for the role. */
  function target(context: DeployContext): Target {
    if (context.role !== "api") throw new ProviderError(PROVIDER, 0, `Fly.io does not support the ${context.role} role`);
    const s = context.settings;
    const name = String(s.appName || resourceName(context.app, context.environment, context.role));
    if (!/^[a-z0-9][a-z0-9-]{1,61}$/.test(name)) throw new ProviderError(PROVIDER, 0, `Invalid Fly app name: ${name}`);
    const region = String(s.region ?? "iad");
    if (!FLY_REGIONS.includes(region)) throw new ProviderError(PROVIDER, 0, `Unknown Fly region: ${region}`);
    const port = Number(s.port ?? context.variables.PORT ?? 8080);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ProviderError(PROVIDER, 0, `Invalid port: ${port}`);
    const directory = resolve(options.root ?? process.cwd(), context.source.directory);
    const dockerfile = join(directory, "Dockerfile");
    const builder = s.builder ? String(s.builder) : undefined;
    const hasDockerfile = existsSync(dockerfile);
    if (!hasDockerfile && !builder)
      throw new ProviderError(PROVIDER, 0, `No Dockerfile in ${context.source.directory}; add one or set the "builder" setting (buildpacks)`);
    return {
      name,
      org: String(s.org || "personal"),
      region,
      port,
      autoStop: String(s.autoStop ?? "stop"),
      builder,
      ha: s.ha !== false,
      directory,
      dockerfile: hasDockerfile && !builder ? dockerfile : undefined,
    };
  }

  /** Run flyctl with the token in the environment only; failures carry redacted stderr. */
  async function flyctlRun(context: DeployContext, args: string[], cwd: string, input?: string) {
    const env = { ...(options.env ?? process.env), FLY_API_TOKEN: token(context), NO_COLOR: "1" };
    let result: RunResult;
    try {
      result = await run(flyctl, args, { cwd, env, input });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ProviderError(PROVIDER, 0, `flyctl was not found. ${INSTALL_HINT}`);
      throw new ProviderError(PROVIDER, 0, redact(`flyctl ${args[0]} failed: ${(error as Error).message}`, secretsOf(context)));
    }
    if (result.code !== 0) {
      const output = (result.stderr || result.stdout).trim().slice(-800);
      throw new ProviderError(PROVIDER, result.code, redact(`flyctl ${args.slice(0, 2).join(" ")} exited with ${result.code}: ${output}`, secretsOf(context)));
    }
    return result;
  }

  /** Read-only plan: does the app exist, which secret names change, deploy from which folder. */
  async function plan(context: DeployContext): Promise<DeployPlan> {
    const t = target(context);
    const app = await api(context).find(`/apps/${t.name}`);
    const actions: PlannedAction[] = [];
    if (!app) actions.push({ action: "create", resource: `app ${t.name}`, detail: `in org ${t.org}` });
    const keys = Object.keys(context.variables);
    if (keys.length) actions.push({ action: "update", resource: "secrets", detail: keys.sort().join(", ") });
    const build = t.dockerfile ? "Dockerfile" : `builder ${t.builder}`;
    actions.push({ action: "deploy", resource: `app ${t.name}`, detail: `flyctl deploy ${context.source.directory} (${build}, ${t.region})` });
    return { provider: "flyio", role: context.role, environment: context.environment, actions, state: { app: t.name, exists: !!app } };
  }

  /** Idempotent apply: create the app if missing, stage secrets, deploy with a generated fly.toml. */
  async function apply(context: DeployContext, deployPlan: DeployPlan): Promise<DeployResult> {
    const t = target(context);
    const client = api(context);
    // Fail before any remote write when flyctl is not installed.
    await flyctlRun(context, ["version"], t.directory);

    const state = deployPlan.provider === "flyio" && deployPlan.state?.app === t.name ? deployPlan.state : undefined;
    const exists = state ? state.exists === true : !!(await client.find(`/apps/${t.name}`));
    if (!exists) {
      try {
        await client.post("/apps", { app_name: t.name, org_slug: t.org });
      } catch (error) {
        if ((error as ProviderError).status === 422)
          throw new ProviderError(PROVIDER, 422, `App name ${t.name} is taken on Fly.io; set the "appName" setting (${(error as Error).message})`);
        throw error;
      }
      context.log(`Fly.io: created app ${t.name} in ${t.org}`);
    }

    const keys = Object.keys(context.variables);
    if (keys.length) {
      // --stage: store secrets now; the deploy below rolls them out with the new release.
      await flyctlRun(context, ["secrets", "import", "--app", t.name, "--stage"], t.directory, encodeSecrets(context.variables));
      context.log(`Fly.io: staged ${keys.length} secrets (${keys.sort().join(", ")})`);
    }

    const folder = await mkdtemp(join(tmpdir(), "rt-app-fly-"));
    try {
      const config = join(folder, "fly.toml");
      const setPort = context.variables.PORT === undefined;
      await writeFile(config, flyToml({ app: t.name, region: t.region, port: t.port, autoStop: t.autoStop, builder: t.builder, setPort }));
      const args = ["deploy", t.directory, "--app", t.name, "--config", config, "--remote-only", "--yes"];
      if (t.dockerfile) args.push("--dockerfile", t.dockerfile);
      if (!t.ha) args.push("--ha=false");
      context.log(`Fly.io: deploying ${t.name} from ${context.source.directory}`);
      await flyctlRun(context, args, t.directory);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }

    const app = await client.get(`/apps/${t.name}`);
    return {
      provider: "flyio",
      role: context.role,
      url: `https://${t.name}.fly.dev`,
      resources: [{ kind: "app", id: String(app?.id ?? t.name), name: t.name }],
    };
  }

  /** App state from its Machines: any started → live, launch failures → failed, transitions → deploying. */
  async function status(context: DeployContext): Promise<DeployStatus> {
    if (context.role !== "api") throw new ProviderError(PROVIDER, 0, `Fly.io does not support the ${context.role} role`);
    const name = String(context.settings.appName || resourceName(context.app, context.environment, context.role));
    const client = api(context);
    const app = await client.find(`/apps/${name}`);
    if (!app) return { state: "missing" };
    const url = `https://${name}.fly.dev`;
    const machines = ((await client.get(`/apps/${name}/machines`)) ?? []) as Array<{ state: string }>;
    return { ...machineState(machines.map((m) => m.state)), url };
  }

  return {
    id: "flyio",
    name: "Fly.io",
    roles: ["api"],
    website: "https://fly.io",
    credentials: [{ key: "FLY_API_TOKEN", label: "Org token (fly tokens create org)", url: "https://fly.io/docs/security/tokens/" }],
    settings: [
      { key: "org", label: "Organization slug", type: "string", default: "personal" },
      { key: "region", label: "Primary region", type: "string", default: "iad", options: FLY_REGIONS },
      { key: "appName", label: "App name (globally unique)", type: "string", help: "Defaults to <app>-<environment>-api" },
      { key: "port", label: "Internal port", type: "number", default: 8080 },
      { key: "autoStop", label: "Auto stop idle machines", type: "string", default: "stop", options: ["off", "stop", "suspend"] },
      { key: "ha", label: "Two machines for availability", type: "boolean", default: true },
      { key: "builder", label: "Buildpacks builder (no Dockerfile)", type: "string", help: "e.g. paketobuildpacks/builder-jammy-base" },
    ],
    notes: "Requires flyctl on the machine that deploys and a Dockerfile in the service folder (or a buildpacks builder). Builds run on Fly's remote builder.",
    plan,
    apply,
    status,
  };
}

/** Map Machine states (https://fly.io/docs/machines/machine-states/) to one deploy state. */
export function machineState(states: string[]): Pick<DeployStatus, "state" | "detail"> {
  const live = states.filter((s) => s !== "destroyed" && s !== "destroying" && s !== "replaced" && s !== "migrated");
  const detail = live.length ? `Machines: ${live.join(", ")}` : "No machines";
  if (!live.length) return { state: "unknown", detail };
  if (live.includes("started")) return { state: "live", detail };
  if (live.some((s) => ["created", "creating", "starting", "updating", "replacing", "restarting"].includes(s))) return { state: "deploying", detail };
  if (live.every((s) => s === "failed" || s === "launch_failed")) return { state: "failed", detail };
  // stopped/suspended: Fly Proxy starts them on the next request (auto_start_machines).
  if (live.every((s) => s === "stopped" || s === "suspended" || s === "stopping" || s === "suspending")) return { state: "live", detail };
  return { state: "unknown", detail };
}

export const provider = createFlyProvider();

export default provider;
