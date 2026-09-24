import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ENVIRONMENTS,
  ProviderRegistry,
  ROLES,
  applyEnvironment,
  planEnvironment,
  resolveCredentials,
  settingsFor,
  validateDeploySettings,
  type DeployEnvironment,
  type DeployProvider,
  type DeploySettings,
  type DeploySource,
  type Role,
} from "@gsalgadotoledo/rt-app-deploy";
import * as render from "@gsalgadotoledo/rt-app-deploy-render";
import * as railway from "@gsalgadotoledo/rt-app-deploy-railway";
import * as flyio from "@gsalgadotoledo/rt-app-deploy-flyio";
import * as digitalocean from "@gsalgadotoledo/rt-app-deploy-digitalocean";
import * as heroku from "@gsalgadotoledo/rt-app-deploy-heroku";
import * as vercel from "@gsalgadotoledo/rt-app-deploy-vercel";
import * as neon from "@gsalgadotoledo/rt-app-deploy-neon";
import * as supabase from "@gsalgadotoledo/rt-app-deploy-supabase";

/**
 * Application-side deployment workbench shared by `rta deploy`, `rta github`, the local admin
 * (Deployments page) and the Service Manager: provider registry, per-role sources for the
 * starter layout, credentials (local file for planning, GitHub environment secrets for CI).
 */

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/**
 * Provider packages shipped with RT-App. Static imports keep them inside any bundle (the
 * Service Manager app, a Lambda): a dynamic import by name would silently drop them.
 */
const BUNDLED: Record<string, any> = {
  "@gsalgadotoledo/rt-app-deploy-render": render,
  "@gsalgadotoledo/rt-app-deploy-railway": railway,
  "@gsalgadotoledo/rt-app-deploy-flyio": flyio,
  "@gsalgadotoledo/rt-app-deploy-digitalocean": digitalocean,
  "@gsalgadotoledo/rt-app-deploy-heroku": heroku,
  "@gsalgadotoledo/rt-app-deploy-vercel": vercel,
  "@gsalgadotoledo/rt-app-deploy-neon": neon,
  "@gsalgadotoledo/rt-app-deploy-supabase": supabase,
};

export const PROVIDER_PACKAGES = Object.keys(BUNDLED);

/**
 * AWS runs through the existing Terraform pipeline (`rta install`, the GitHub deploy workflow),
 * not through provider API calls. It is listed so every role can choose it.
 */
export const awsProvider: DeployProvider = {
  id: "aws",
  name: "AWS (Lambda, S3 + CloudFront, Amplify, DynamoDB)",
  roles: [...ROLES],
  website: "https://aws.amazon.com",
  credentials: [],
  notes: "Deployed by Terraform: run `rta install` once, then merges deploy through the GitHub workflow.",
  async plan(context) {
    return {
      provider: "aws",
      role: context.role,
      environment: context.environment,
      actions: [{ action: "noop", resource: context.role, detail: "Managed by the Terraform pipeline (rta install / GitHub workflow)" }],
    };
  },
  async apply(context) {
    throw new Error(`AWS ${context.role} is deployed by the Terraform pipeline: run rta install or merge to the environment branch`);
  },
  async status() {
    return { state: "unknown", detail: "See the GitHub deploy workflow or rta urls" };
  },
};

/** Registry with AWS and every provider package that can be imported (all ship with the CLI). */
export async function loadRegistry(importer: (name: string) => Promise<any> = async (name) => BUNDLED[name]) {
  const registry = new ProviderRegistry().register(awsProvider);
  for (const name of PROVIDER_PACKAGES) {
    try {
      const module = await importer(name);
      if (module?.provider) registry.register(module.provider);
    } catch (error: any) {
      if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
    }
  }
  return registry;
}

// ---------------------------------------------------------------------------
// What each role deploys in an RT-App project
// ---------------------------------------------------------------------------

/**
 * Sources for the starter layout. The API is the starter server in portable mode: it applies
 * pending migrations (lease-locked, safe with several instances) and then serves HTTP.
 */
export function sourceFor(role: Role, repository: string | undefined, branch: string): DeploySource {
  const base = { repository, branch };
  switch (role) {
    case "api":
      return {
        ...base,
        directory: ".",
        runtime: "node",
        buildCommand: "npm ci --include=dev && npm run build",
        startCommand: "node apps/server/dist/migrate.js up && node apps/server/dist/index.js",
      };
    case "ssr":
      return { ...base, directory: "apps/ssr", runtime: "node", buildCommand: "npm run build", startCommand: "npm start" };
    case "frontend":
      return { ...base, directory: "apps/spa", runtime: "static", buildCommand: "npm run build", outputDirectory: "dist" };
    default:
      return { ...base, directory: ".", runtime: "node" };
  }
}

/** Branch deployed for each environment (merge → deploy). */
export const BRANCHES: Record<DeployEnvironment, string> = { develop: "develop", stage: "stage", prod: "main" };

/** Secrets and values the API process needs in portable mode, read from the environment. */
export const RUNTIME_SECRETS = ["JWT_SECRET", "ADMIN_PASSWORD_VERIFIER", "MAIL_FROM", "SMTP_URL", "DATABASE_URL"];

export function runtimeVariables(environment: DeployEnvironment, env: Record<string, string | undefined>) {
  const variables: Record<string, string> = { RT_APP_TARGET: "portable", RT_APP_ENVIRONMENT: environment, NODE_ENV: "production" };
  for (const key of RUNTIME_SECRETS) if (env[key]) variables[key] = env[key]!;
  return variables;
}

// ---------------------------------------------------------------------------
// Project files
// ---------------------------------------------------------------------------

async function readJson(path: string, fallback?: any) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error: any) {
    if (error.code === "ENOENT" && fallback !== undefined) return fallback;
    throw error;
  }
}

async function writeJson(path: string, data: unknown, mode = 0o644) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(data, null, 2) + "\n", { mode });
  await rename(temp, path);
  await chmod(path, mode);
}

/** Read and validate `deploy` from rt-app.settings.json. */
export async function readDeploySettings(root: string, registry: ProviderRegistry) {
  const settings = await readJson(join(root, "rt-app.settings.json"));
  return { settings, deploy: validateDeploySettings(settings.deploy, registry) };
}

/** Validate and save `deploy` into rt-app.settings.json, keeping every other setting. */
export async function saveDeploySettings(root: string, registry: ProviderRegistry, deploy: unknown) {
  const path = join(root, "rt-app.settings.json");
  const settings = await readJson(path);
  const validated = validateDeploySettings(deploy, registry);
  await writeJson(path, { ...settings, deploy: validated });
  return validated;
}

// ---------------------------------------------------------------------------
// Credentials: local file (0600, git-ignored under .rt-app/) and GitHub environment secrets
// ---------------------------------------------------------------------------

const CREDENTIALS = ".rt-app/credentials.json";
const KEY = /^[A-Z][A-Z0-9_]{1,80}$/;

type CredentialFile = Partial<Record<DeployEnvironment, Record<string, string>>>;

export async function readCredentials(root: string): Promise<CredentialFile> {
  return readJson(join(root, CREDENTIALS), {});
}

/** Store one credential locally (never in rt-app.settings.json, never logged). Empty value deletes it. */
export async function saveCredential(root: string, environment: DeployEnvironment, key: string, value: string) {
  if (!ENVIRONMENTS.includes(environment)) throw new Error("Unknown environment: " + environment);
  if (!KEY.test(key)) throw new Error("Invalid credential name: " + key);
  if (typeof value !== "string" || value.length > 10_000) throw new Error("Invalid credential value");
  const file = await readCredentials(root);
  const current = { ...file[environment] };
  if (value) current[key] = value;
  else delete current[key];
  await writeJson(join(root, CREDENTIALS), { ...file, [environment]: current }, 0o600);
}

/** Which credentials each configured provider needs, and whether they are present (no values). */
export async function credentialStatus(root: string, registry: ProviderRegistry, deploy: DeploySettings, env: Record<string, string | undefined> = {}) {
  const local = await readCredentials(root);
  return Object.fromEntries(
    ENVIRONMENTS.map((environment) => {
      const targets = deploy.environments[environment] ?? {};
      const providers = [...new Set(Object.values(targets).map((t) => t!.provider))].map((id) => registry.get(id));
      const merged = { ...env, ...local[environment] };
      return [
        environment,
        providers.map((provider) => ({
          provider: provider.id,
          credentials: provider.credentials.map((spec) => ({ ...spec, present: Boolean(merged[spec.key]) })),
          missing: resolveCredentials(provider, merged).missing,
        })),
      ];
    }),
  );
}

export type Runner = (command: string, args: string[], options?: { cwd?: string; input?: string }) => { status: number | null; stdout: string; stderr: string };

export const defaultRunner: Runner = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: options.cwd, input: options.input, encoding: "utf8" });
  if (result.error) return { status: 127, stdout: "", stderr: String(result.error.message) };
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

/** `owner/name` of the GitHub origin, or undefined when the project is not on GitHub. */
export function githubRepository(root: string, run: Runner = defaultRunner) {
  const result = run("git", ["remote", "get-url", "origin"], { cwd: root });
  if (result.status !== 0) return undefined;
  const match = result.stdout.trim().match(/github\.com[:/]([^/]+\/[^/.]+?)(\.git)?$/);
  return match?.[1];
}

/**
 * Create the three GitHub environments and push local credentials plus runtime secrets as
 * environment secrets (values go through stdin, never argv). Requires `gh auth login`.
 */
export async function syncGithub(root: string, options: { run?: Runner; environments?: DeployEnvironment[]; secrets?: Record<string, string | undefined> } = {}) {
  const run = options.run ?? defaultRunner;
  const repository = githubRepository(root, run);
  if (!repository) throw new Error("No GitHub origin. Run: rta github connect");
  if (run("gh", ["auth", "status"], { cwd: root }).status !== 0) throw new Error("GitHub CLI is not authenticated. Run: gh auth login");
  const local = await readCredentials(root);
  const report: Record<string, string[]> = {};
  for (const environment of options.environments ?? [...ENVIRONMENTS]) {
    const created = run("gh", ["api", "--method", "PUT", `repos/${repository}/environments/${environment}`, "--silent"], { cwd: root });
    if (created.status !== 0) throw new Error(`Could not create environment ${environment}: ${created.stderr.trim()}`);
    const values = { ...Object.fromEntries(Object.entries(options.secrets ?? {}).filter(([, v]) => v)), ...local[environment] } as Record<string, string>;
    report[environment] = [];
    for (const [key, value] of Object.entries(values)) {
      if (!KEY.test(key)) continue;
      const set = run("gh", ["secret", "set", key, "--env", environment, "--repo", repository], { cwd: root, input: value });
      if (set.status !== 0) throw new Error(`Could not set ${key} in ${environment}: ${set.stderr.trim()}`);
      report[environment].push(key);
    }
  }
  return { repository, secrets: report };
}

/** Create (or reuse) the GitHub repository for this project and push the current branch. */
export function connectGithub(root: string, options: { run?: Runner; visibility?: "private" | "public"; name?: string } = {}) {
  const run = options.run ?? defaultRunner;
  const existing = githubRepository(root, run);
  if (existing) return { repository: existing, created: false };
  if (run("gh", ["auth", "status"], { cwd: root }).status !== 0) throw new Error("GitHub CLI is not authenticated. Run: gh auth login");
  const args = ["repo", "create", ...(options.name ? [options.name] : []), `--${options.visibility ?? "private"}`, "--source", ".", "--push"];
  const created = run("gh", args, { cwd: root });
  if (created.status !== 0) throw new Error("gh repo create failed: " + created.stderr.trim());
  return { repository: githubRepository(root, run), created: true };
}

// ---------------------------------------------------------------------------
// Plan / apply for an environment
// ---------------------------------------------------------------------------

export interface EnvironmentRun {
  root: string;
  environment: DeployEnvironment;
  roles?: Role[];
  env?: Record<string, string | undefined>;
  registry?: ProviderRegistry;
  fetch?: typeof fetch;
  log?: (message: string) => void;
  run?: Runner;
}

async function orchestration(options: EnvironmentRun) {
  const registry = options.registry ?? (await loadRegistry());
  const { settings, deploy } = await readDeploySettings(options.root, registry);
  const local = await readCredentials(options.root);
  const env = { ...options.env, ...local[options.environment] };
  const repository = githubRepository(options.root, options.run);
  // AWS roles are handled by Terraform; provider calls cover every other role.
  const targets = deploy.environments[options.environment] ?? {};
  const roles = (options.roles ?? [...ROLES]).filter((role) => targets[role] && targets[role]!.provider !== "aws");
  return {
    registry,
    settings: deploy,
    app: String(settings.project?.name ?? "app"),
    environment: options.environment,
    env,
    roles,
    source: (role: Role) => sourceFor(role, repository, BRANCHES[options.environment]),
    variables: runtimeVariables(options.environment, env),
    fetch: options.fetch,
    log: options.log,
  };
}

export async function planDeployment(options: EnvironmentRun) {
  const run = await orchestration(options);
  return run.roles.length ? planEnvironment(run) : [];
}

export async function applyDeployment(options: EnvironmentRun) {
  const run = await orchestration(options);
  return run.roles.length ? applyEnvironment(run) : { results: [], outputs: {} };
}

/** Current status of every configured role (never throws for one failing provider). */
export async function deploymentStatus(options: EnvironmentRun) {
  const run = await orchestration(options);
  const targets = run.settings.environments[options.environment] ?? {};
  const statuses = [];
  for (const role of ROLES) {
    const target = targets[role];
    if (!target) continue;
    const provider = run.registry.get(target.provider);
    try {
      const credentials = resolveCredentials(provider, run.env);
      if (credentials.missing.length) {
        statuses.push({ role, provider: provider.id, state: "unknown", detail: "Missing " + credentials.missing.join(", ") });
        continue;
      }
      const status = await provider.status({
        app: run.app,
        environment: options.environment,
        role,
        settings: settingsFor(provider, target),
        credentials: credentials.values,
        source: run.source(role),
        variables: {},
        fetch: run.fetch ?? fetch,
        log: run.log ?? (() => {}),
      });
      statuses.push({ role, provider: provider.id, ...status });
    } catch (error) {
      statuses.push({ role, provider: provider.id, state: "unknown", detail: (error as Error).message });
    }
  }
  return statuses;
}
