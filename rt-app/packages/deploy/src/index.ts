/**
 * Deployment contract shared by every provider package (`@gsalgadotoledo/rt-app-deploy-<provider>`).
 *
 * An application picks one provider per role and environment in `rt-app.settings.json` (`deploy`).
 * Providers never read the database: they receive credentials (API keys from environment
 * variables / GitHub environment secrets), the application's source and runtime variables, and
 * return an explicit plan before applying it.
 */

// ---------------------------------------------------------------------------
// Roles and configuration
// ---------------------------------------------------------------------------

export const ROLES = ["api", "ssr", "frontend", "files", "database"] as const;
export type Role = (typeof ROLES)[number];

export const ENVIRONMENTS = ["develop", "stage", "prod"] as const;
export type DeployEnvironment = (typeof ENVIRONMENTS)[number];

export const ROLE_LABELS: Record<Role, string> = {
  api: "API (Node, Python or Go process)",
  ssr: "SSR (Next.js)",
  frontend: "Frontend (static SPA and admin)",
  files: "Files (uploads)",
  database: "Database",
};

/** One role of one environment: which provider serves it and its non-secret settings. */
export interface RoleTarget {
  provider: string;
  settings?: Record<string, string | number | boolean>;
}

/** `rt-app.settings.json` → `deploy`. Secrets never appear here. */
export interface DeploySettings {
  environments: Partial<Record<DeployEnvironment, Partial<Record<Role, RoleTarget>>>>;
}

// ---------------------------------------------------------------------------
// Provider contract
// ---------------------------------------------------------------------------

export interface CredentialSpec {
  /** Environment variable / GitHub secret name, e.g. RENDER_API_KEY. */
  key: string;
  label: string;
  /** Where to create the key. */
  url?: string;
  optional?: boolean;
}

export interface SettingSpec {
  key: string;
  label: string;
  type: "string" | "number" | "boolean";
  default?: string | number | boolean;
  options?: string[];
  help?: string;
}

/** What the application gives a provider for one role. */
export interface DeploySource {
  /** owner/name on GitHub; providers that build from git use it. */
  repository?: string;
  branch: string;
  /** Folder inside the repository (e.g. apps/ssr). */
  directory: string;
  buildCommand?: string;
  startCommand?: string;
  /** Static output folder relative to `directory` (frontend). */
  outputDirectory?: string;
  runtime?: "node" | "python" | "go" | "static";
}

export interface DeployContext {
  /** Application name, used to name remote resources: `<app>-<environment>-<role>`. */
  app: string;
  environment: DeployEnvironment;
  role: Role;
  settings: Record<string, string | number | boolean>;
  credentials: Record<string, string>;
  source: DeploySource;
  /** Runtime variables for the deployed process (DATABASE_URL, JWT_SECRET…). Values are secret. */
  variables: Record<string, string>;
  fetch: typeof fetch;
  log: (message: string) => void;
}

export interface PlannedAction {
  action: "create" | "update" | "deploy" | "noop";
  resource: string;
  detail: string;
}

export interface DeployPlan {
  provider: string;
  role: Role;
  environment: DeployEnvironment;
  actions: PlannedAction[];
  /** Opaque provider state carried from plan to apply (e.g. existing service id). */
  state?: Record<string, unknown>;
}

export interface DeployResult {
  provider: string;
  role: Role;
  url?: string;
  /** Values other roles need, e.g. `DATABASE_URL` from the database role. Secret. */
  outputs?: Record<string, string>;
  resources: Array<{ kind: string; id: string; name: string }>;
}

export interface DeployStatus {
  state: "missing" | "deploying" | "live" | "failed" | "unknown";
  url?: string;
  detail?: string;
}

export interface DeployProvider {
  id: string;
  name: string;
  roles: Role[];
  website: string;
  credentials: CredentialSpec[];
  settings?: SettingSpec[];
  /** Short note shown in the admin, e.g. free-tier sleep, CLI required. */
  notes?: string;
  plan(context: DeployContext): Promise<DeployPlan>;
  apply(context: DeployContext, plan: DeployPlan): Promise<DeployResult>;
  status(context: DeployContext): Promise<DeployStatus>;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Providers are registered explicitly; configuration never imports arbitrary code. */
export class ProviderRegistry {
  private providers = new Map<string, DeployProvider>();

  register(provider: DeployProvider) {
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(provider.id)) throw new Error("Invalid provider id: " + provider.id);
    if (this.providers.has(provider.id)) throw new Error("Duplicate provider: " + provider.id);
    if (!provider.roles.length || provider.roles.some((r) => !ROLES.includes(r)))
      throw new Error("Invalid roles for provider " + provider.id);
    this.providers.set(provider.id, provider);
    return this;
  }

  get(id: string) {
    const provider = this.providers.get(id);
    if (!provider) throw new Error("Unknown deploy provider: " + id);
    return provider;
  }

  list() {
    return [...this.providers.values()];
  }

  /** Public description for the admin and the Service Manager (no functions, no secrets). */
  catalog() {
    return this.list().map(({ id, name, roles, website, credentials, settings, notes }) => ({
      id,
      name,
      roles,
      website,
      credentials,
      settings: settings ?? [],
      notes,
    }));
  }
}

// ---------------------------------------------------------------------------
// Validation and credentials
// ---------------------------------------------------------------------------

/** Validate the `deploy` section against the registered providers and their roles. */
export function validateDeploySettings(input: unknown, registry: ProviderRegistry): DeploySettings {
  const environments: DeploySettings["environments"] = {};
  const value = (input ?? {}) as any;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("deploy must be an object");
  for (const [environment, roles] of Object.entries(value.environments ?? {})) {
    if (!ENVIRONMENTS.includes(environment as DeployEnvironment)) throw new Error("Unknown environment: " + environment);
    const targets: Partial<Record<Role, RoleTarget>> = {};
    for (const [role, target] of Object.entries((roles ?? {}) as Record<string, any>)) {
      if (!ROLES.includes(role as Role)) throw new Error("Unknown role: " + role);
      const provider = registry.get(String(target?.provider));
      if (!provider.roles.includes(role as Role)) throw new Error(`${provider.name} does not support the ${role} role`);
      const settings: Record<string, string | number | boolean> = {};
      for (const [key, v] of Object.entries(target.settings ?? {})) {
        const spec = provider.settings?.find((s) => s.key === key);
        if (!spec) throw new Error(`Unknown setting ${key} for ${provider.id}`);
        if (typeof v !== spec.type || (spec.options && !spec.options.includes(String(v))))
          throw new Error(`Invalid value for ${provider.id}.${key}`);
        settings[key] = v as string | number | boolean;
      }
      targets[role as Role] = { provider: provider.id, ...(Object.keys(settings).length ? { settings } : {}) };
    }
    environments[environment as DeployEnvironment] = targets;
  }
  return { environments };
}

/**
 * Credentials for a provider from environment variables. Missing required keys are reported,
 * never guessed. Values are returned for the provider call only; do not log them.
 */
export function resolveCredentials(provider: DeployProvider, env: Record<string, string | undefined>) {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const spec of provider.credentials) {
    const value = env[spec.key];
    if (value) values[spec.key] = value;
    else if (!spec.optional) missing.push(spec.key);
  }
  return { values, missing };
}

/** Merge the provider's declared defaults under the configured settings. */
export function settingsFor(provider: DeployProvider, target: RoleTarget) {
  const defaults = Object.fromEntries((provider.settings ?? []).filter((s) => s.default !== undefined).map((s) => [s.key, s.default!]));
  return { ...defaults, ...target.settings };
}

/** Remote resource name: lowercase, provider-safe, stable per app/environment/role. */
export function resourceName(app: string, environment: string, role: string, max = 40) {
  const base = `${app}-${environment}-${role}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return base.length <= max ? base : base.slice(0, max).replace(/-$/, "");
}

// ---------------------------------------------------------------------------
// HTTP helper for provider APIs
// ---------------------------------------------------------------------------

/** Every secret a provider handles for one call: credentials and runtime variables (DATABASE_URL…). */
export function secretValues(context: Pick<DeployContext, "credentials" | "variables">) {
  return [...Object.values(context.credentials), ...Object.values(context.variables)].filter((value) => value.length >= 4);
}

export class ProviderError extends Error {
  constructor(
    public provider: string,
    public status: number,
    message: string,
  ) {
    super(`${provider}: ${message}`);
  }
}

/** Replace every secret value in a text before it reaches logs or errors. */
export function redact(text: string, secrets: Iterable<string>) {
  let result = text;
  for (const secret of secrets) if (secret && secret.length >= 4) result = result.split(secret).join("[redacted]");
  return result;
}

export interface ApiOptions {
  provider: string;
  baseUrl: string;
  headers: Record<string, string>;
  fetch: typeof fetch;
  secrets: string[];
  timeoutMs?: number;
  /** Retries for GET and for 429/502/503/504 responses. Writes are never retried blindly. */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * JSON client for provider REST APIs: timeout, bounded retries for safe requests and rate limits,
 * and error messages with secrets redacted. Returns undefined for 204 and `{status:404}` → null.
 */
export function createApi(options: ApiOptions) {
  const { provider, baseUrl, headers, secrets } = options;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const retries = options.retries ?? 2;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  async function request<T = any>(method: string, path: string, body?: unknown, allow404 = false): Promise<T | null> {
    const url = path.startsWith("https://") ? path : baseUrl.replace(/\/$/, "") + path;
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await options.fetch(url, {
          method,
          headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        if (method === "GET" && attempt < retries) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        throw new ProviderError(provider, 0, redact(`${method} ${path} failed: ${(error as Error).message}`, secrets));
      }
      if (response.status === 404 && allow404) return null;
      const retryable = response.status === 429 || (method === "GET" && [502, 503, 504].includes(response.status));
      if (retryable && attempt < retries) {
        const after = Number(response.headers.get("retry-after"));
        await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 30) * 1000 : 500 * 2 ** attempt);
        continue;
      }
      const text = await response.text();
      if (!response.ok)
        throw new ProviderError(provider, response.status, redact(`${method} ${path} → ${response.status} ${text.slice(0, 500)}`, secrets));
      if (!text) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        return text as unknown as T;
      }
    }
  }

  return {
    get: <T = any>(path: string) => request<T>("GET", path) as Promise<T>,
    find: <T = any>(path: string) => request<T>("GET", path, undefined, true),
    post: <T = any>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}) as Promise<T>,
    put: <T = any>(path: string, body?: unknown) => request<T>("PUT", path, body ?? {}) as Promise<T>,
    patch: <T = any>(path: string, body?: unknown) => request<T>("PATCH", path, body ?? {}) as Promise<T>,
    delete: <T = any>(path: string) => request<T>("DELETE", path),
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Only the API (and the database/files roles that produce them) handle secrets. The SSR and the
 * static frontend are built into public bundles, so they only receive public values: deployed
 * URLs, the environment name and NODE_ENV. A secret can never reach a browser bundle this way.
 */
export const PUBLIC_VARIABLE = /^(RT_APP_[A-Z_]+_URL|RT_APP_ENVIRONMENT|RT_APP_TARGET|NODE_ENV)$/;

export function variablesFor(role: Role, variables: Record<string, string>) {
  if (role === "api" || role === "database" || role === "files") return { ...variables };
  return Object.fromEntries(Object.entries(variables).filter(([key]) => PUBLIC_VARIABLE.test(key)));
}

/** Deploy order: the database first (its URL feeds the API), then files, API, SSR and frontend. */
export const ROLE_ORDER: Role[] = ["database", "files", "api", "ssr", "frontend"];

export interface OrchestratorOptions {
  registry: ProviderRegistry;
  settings: DeploySettings;
  app: string;
  environment: DeployEnvironment;
  env: Record<string, string | undefined>;
  source: (role: Role) => DeploySource;
  variables?: Record<string, string>;
  fetch?: typeof fetch;
  log?: (message: string) => void;
  roles?: Role[];
}

function contexts(options: OrchestratorOptions) {
  const targets = options.settings.environments[options.environment] ?? {};
  const selected = ROLE_ORDER.filter((role) => targets[role] && (!options.roles || options.roles.includes(role)));
  return selected.map((role) => {
    const target = targets[role]!;
    const provider = options.registry.get(target.provider);
    const { values, missing } = resolveCredentials(provider, options.env);
    const context: DeployContext = {
      app: options.app,
      environment: options.environment,
      role,
      settings: settingsFor(provider, target),
      credentials: values,
      source: options.source(role),
      variables: variablesFor(role, options.variables ?? {}),
      fetch: options.fetch ?? fetch,
      log: options.log ?? (() => {}),
    };
    return { role, provider, context, missing };
  });
}

/** Plan every configured role. Fails before calling any provider if a credential is missing. */
export async function planEnvironment(options: OrchestratorOptions) {
  const selected = contexts(options);
  const missing = selected.flatMap((s) => s.missing.map((key) => `${s.provider.id}:${key}`));
  if (missing.length) throw new Error("Missing credentials: " + missing.join(", "));
  const plans: DeployPlan[] = [];
  for (const { provider, context } of selected) plans.push(await provider.plan(context));
  return plans;
}

/**
 * Apply in role order. Outputs of earlier roles (DATABASE_URL, FILES_BUCKET…) become runtime
 * variables of later ones. Stops at the first failure and reports what was already applied.
 */
export async function applyEnvironment(options: OrchestratorOptions) {
  const selected = contexts(options);
  const missing = selected.flatMap((s) => s.missing.map((key) => `${s.provider.id}:${key}`));
  if (missing.length) throw new Error("Missing credentials: " + missing.join(", "));
  const outputs: Record<string, string> = {};
  const results: DeployResult[] = [];
  for (const { role, provider, context } of selected) {
    context.variables = variablesFor(role, { ...context.variables, ...outputs });
    try {
      const plan = await provider.plan(context);
      const result = await provider.apply(context, plan);
      // Later roles learn earlier URLs: the SSR and frontend call RT_APP_API_URL.
      if (result.url) outputs[`RT_APP_${role.toUpperCase()}_URL`] = result.url;
      Object.assign(outputs, result.outputs);
      results.push(result);
    } catch (error) {
      const done = results.map((r) => `${r.role}:${r.provider}`).join(", ") || "nothing";
      throw new Error(`${(error as Error).message} (already applied: ${done})`);
    }
  }
  return { results, outputs };
}
