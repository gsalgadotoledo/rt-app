/**
 * Supabase deploy provider: managed Postgres for the `database` role.
 *
 * One Supabase project per `<app>-<environment>-database` in the organization SUPABASE_ORG_ID. The
 * database password cannot be read back from Supabase, so the user supplies SUPABASE_DB_PASSWORD:
 * it becomes the password of a new project and is reused to build the URL of an existing one.
 *
 * `outputs.DATABASE_URL` is the shared pooler (Supavisor) URL read from the project's pooler config
 * (IPv4, transaction mode on port 6543 — recommended for serverless; no prepared statements). With
 * `connection: "direct"`, or when no pooler config is returned, it is the direct
 * `db.<ref>.supabase.co:5432` URL (IPv6 unless the IPv4 add-on is enabled).
 *
 * API reference: https://supabase.com/docs/reference/api (OpenAPI: https://api.supabase.com/api/v1-json).
 * Connection strings: https://supabase.com/docs/guides/database/connecting-to-postgres
 */
import {
  createApi,
  resourceName,
  type DeployContext,
  type DeployPlan,
  type DeployProvider,
  type DeployResult,
  type DeployStatus,
  type Role,
} from "@gsalgadotoledo/rt-app-deploy";

const PROVIDER = "supabase";
const BASE_URL = "https://api.supabase.com";
const ROLES: Role[] = ["database"];

/** Region codes accepted by POST /v1/projects (`region_selection.code`). */
export const SUPABASE_REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "ca-central-1",
  "sa-east-1",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "eu-north-1",
  "eu-central-1",
  "eu-central-2",
  "ap-south-1",
  "ap-east-1",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-northeast-1",
  "ap-northeast-2",
];

/** States that will not become healthy without a person acting in the dashboard. */
const STOPPED = ["INACTIVE", "PAUSING", "GOING_DOWN", "REMOVED"];
const FAILED = ["INIT_FAILED", "RESTORE_FAILED", "PAUSE_FAILED"];

interface SupabaseProject {
  id?: string;
  ref: string;
  name: string;
  organization_id?: string;
  organization_slug?: string;
  region?: string;
  status: string;
}

interface PoolerConfig {
  database_type?: string;
  db_user: string;
  db_host: string;
  db_port: number;
  db_name: string;
  pool_mode?: string;
}

export interface SupabaseProviderOptions {
  /** Wait used between status polls and API retries; inject a fake in tests. */
  sleep?: (ms: number) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fail early with a clear message when a role is not served by Supabase. */
function assertRole(context: DeployContext) {
  if (!ROLES.includes(context.role)) throw new Error(`Supabase does not support the ${context.role} role`);
}

/** Required credential or a clear error (the orchestrator checks too; direct callers may not). */
function credential(context: DeployContext, key: string) {
  const value = context.credentials[key];
  if (!value) throw new Error(`Missing credential ${key}`);
  return value;
}

/** Map a Supabase project status to the RT-App status vocabulary. */
export function mapProjectStatus(status: string | undefined): DeployStatus["state"] {
  if (status === "ACTIVE_HEALTHY") return "live";
  if (status && ["COMING_UP", "RESTORING", "UPGRADING", "RESTARTING", "RESIZING"].includes(status)) return "deploying";
  if (status && [...FAILED, "ACTIVE_UNHEALTHY"].includes(status)) return "failed";
  return "unknown";
}

/** Postgres URL with the password percent-encoded. */
function postgresUrl(user: string, password: string, host: string, port: number, database: string) {
  return `postgresql://${user}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
}

/** Positive number setting in seconds, or the default. */
function seconds(value: unknown, fallback: number) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * Build the Supabase provider. `provider` (default export) uses real timers; tests pass a fake
 * `sleep` so polling never waits.
 */
export function createSupabaseProvider(options: SupabaseProviderOptions = {}): DeployProvider {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  /** Authenticated client; the token, org and database password (raw and encoded) are redacted. */
  function client(context: DeployContext) {
    const token = credential(context, "SUPABASE_ACCESS_TOKEN");
    const secrets = Object.values(context.credentials);
    const password = context.credentials.SUPABASE_DB_PASSWORD;
    if (password) secrets.push(encodeURIComponent(password));
    return createApi({
      provider: "Supabase",
      baseUrl: BASE_URL,
      headers: { authorization: `Bearer ${token}` },
      fetch: context.fetch,
      secrets,
      sleep,
    });
  }

  type Api = ReturnType<typeof client>;

  /** Find the project by exact name inside the configured organization, ignoring removed ones. */
  async function findProject(context: DeployContext, api: Api) {
    const organization = credential(context, "SUPABASE_ORG_ID");
    const name = resourceName(context.app, context.environment, context.role);
    const projects = (await api.get<SupabaseProject[]>("/v1/projects")) ?? [];
    const project =
      projects.find(
        (p) =>
          p.name === name &&
          p.status !== "REMOVED" &&
          (p.organization_slug === organization || p.organization_id === organization),
      ) ?? null;
    return { name, project };
  }

  /**
   * Poll GET /v1/projects/{ref} until ACTIVE_HEALTHY. Sleeps at most `waitTimeoutSeconds` in total
   * (`pollIntervalSeconds` apart); throws on failed/stopped states or when the wait runs out.
   */
  async function waitHealthy(context: DeployContext, api: Api, project: SupabaseProject) {
    const interval = seconds(context.settings.pollIntervalSeconds, 10);
    const timeout = seconds(context.settings.waitTimeoutSeconds, 600);
    const maxSleeps = interval > 0 ? Math.floor(timeout / interval) : 0;
    let current = project;
    for (let slept = 0; ; slept++) {
      if (current.status === "ACTIVE_HEALTHY") return current;
      if (FAILED.includes(current.status)) throw new Error(`Supabase project ${current.ref} is ${current.status}`);
      if (STOPPED.includes(current.status))
        throw new Error(`Supabase project ${current.ref} is ${current.status}; restore it from the dashboard and retry`);
      if (slept >= maxSleeps)
        throw new Error(`Supabase project ${current.ref} not healthy after ${timeout}s (last status ${current.status})`);
      context.log(`Supabase: waiting for ${current.ref} (${current.status})`);
      await sleep(interval * 1000);
      current = await api.get<SupabaseProject>(`/v1/projects/${current.ref}`);
    }
  }

  /** Pooler URL from the project's Supavisor config, or the direct URL (see module comment). */
  async function databaseUrl(context: DeployContext, api: Api, ref: string, password: string) {
    const direct = postgresUrl("postgres", password, `db.${ref}.supabase.co`, 5432, "postgres");
    if (context.settings.connection === "direct") return { url: direct, kind: "direct" };
    const configs = (await api.find<PoolerConfig[]>(`/v1/projects/${ref}/config/database/pooler`)) ?? [];
    const primary = configs.filter((c) => (c.database_type ?? "PRIMARY") === "PRIMARY");
    const pooler = primary.find((c) => c.pool_mode === "transaction") ?? primary[0];
    if (!pooler) return { url: direct, kind: "direct (no pooler config)" };
    return { url: postgresUrl(pooler.db_user, password, pooler.db_host, pooler.db_port, pooler.db_name), kind: `pooler (${pooler.pool_mode ?? "?"})` };
  }

  /** Read-only plan (GET only): create when missing, noop when the project exists. */
  async function plan(context: DeployContext): Promise<DeployPlan> {
    assertRole(context);
    const api = client(context);
    const { name, project } = await findProject(context, api);
    const region = String(context.settings.region ?? "us-east-1");
    return {
      provider: PROVIDER,
      role: context.role,
      environment: context.environment,
      actions: [
        project
          ? { action: "noop", resource: name, detail: `Project ${project.ref} exists (${project.region ?? "?"}, ${project.status})` }
          : { action: "create", resource: name, detail: `Create Supabase project in ${region} (takes a few minutes)` },
      ],
      state: project ? { ref: project.ref } : {},
    };
  }

  /**
   * Create the project when missing (found again by name, so re-runs never duplicate it), wait for
   * ACTIVE_HEALTHY and return `outputs.DATABASE_URL`. The URL and password are never logged.
   */
  async function apply(context: DeployContext, _plan: DeployPlan): Promise<DeployResult> {
    assertRole(context);
    const api = client(context);
    const password = credential(context, "SUPABASE_DB_PASSWORD");
    const found = await findProject(context, api);
    let project = found.project;

    if (!project) {
      context.log(`Supabase: creating project ${found.name}`);
      project = await api.post<SupabaseProject>("/v1/projects", {
        name: found.name,
        organization_slug: context.credentials.SUPABASE_ORG_ID,
        db_pass: password,
        region_selection: { type: "specific", code: String(context.settings.region ?? "us-east-1") },
      });
    }

    project = await waitHealthy(context, api, project);
    const { url, kind } = await databaseUrl(context, api, project.ref, password);
    context.log(`Supabase: ${kind} connection string ready for ${found.name}`);

    return {
      provider: PROVIDER,
      role: context.role,
      outputs: { DATABASE_URL: url },
      resources: [{ kind: "project", id: project.ref, name: found.name }],
    };
  }

  /** Project status mapped to missing | deploying | live | failed | unknown. */
  async function status(context: DeployContext): Promise<DeployStatus> {
    assertRole(context);
    const api = client(context);
    const { project } = await findProject(context, api);
    if (!project) return { state: "missing" };
    return { state: mapProjectStatus(project.status), detail: project.status };
  }

  return {
    id: PROVIDER,
    name: "Supabase",
    roles: ROLES,
    website: "https://supabase.com",
    credentials: [
      { key: "SUPABASE_ACCESS_TOKEN", label: "Personal access token", url: "https://supabase.com/dashboard/account/tokens" },
      { key: "SUPABASE_ORG_ID", label: "Organization slug (Organization settings → General)", url: "https://supabase.com/dashboard/org/_/general" },
      { key: "SUPABASE_DB_PASSWORD", label: "Database password (new projects use it; existing ones must match)" },
    ],
    settings: [
      { key: "region", label: "Region", type: "string", default: "us-east-1", options: SUPABASE_REGIONS },
      {
        key: "connection",
        label: "DATABASE_URL type",
        type: "string",
        default: "pooler",
        options: ["pooler", "direct"],
        help: "pooler: Supavisor (IPv4, transaction mode). direct: db.<ref>.supabase.co:5432 (IPv6 unless the IPv4 add-on is enabled).",
      },
      { key: "waitTimeoutSeconds", label: "Max wait for a healthy project (s)", type: "number", default: 600 },
      { key: "pollIntervalSeconds", label: "Status poll interval (s)", type: "number", default: 10 },
    ],
    notes: "New projects take a few minutes to become healthy. Free projects pause after a week of inactivity. The database password cannot be read back: keep SUPABASE_DB_PASSWORD in sync.",
    plan,
    apply,
    status,
  };
}

export const provider: DeployProvider = createSupabaseProvider();

export default provider;
