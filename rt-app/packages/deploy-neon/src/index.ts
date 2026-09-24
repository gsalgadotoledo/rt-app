/**
 * Neon deploy provider: serverless Postgres for the `database` role.
 *
 * One Neon project per `<app>-<environment>-database`. apply returns `outputs.DATABASE_URL` for the
 * project's default branch, database and owner role. By default it is the pooled (PgBouncer,
 * `-pooler` host) URI; set `pooled: false` for the direct compute URI (needed for some migration
 * tools and session features).
 *
 * API reference: https://api-docs.neon.tech/reference/getting-started-with-neon-api
 * (OpenAPI: https://neon.com/api_spec/release/v2.json).
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

const PROVIDER = "neon";
const BASE_URL = "https://console.neon.tech/api/v2";
const ROLES: Role[] = ["database"];

/** Regions open for new projects (https://neon.com/docs/introduction/regions). */
export const NEON_REGIONS = [
  "aws-us-east-1",
  "aws-us-east-2",
  "aws-us-west-2",
  "aws-eu-central-1",
  "aws-eu-west-2",
  "aws-ap-southeast-1",
  "aws-ap-southeast-2",
  "aws-sa-east-1",
];

export const NEON_PG_VERSIONS = ["14", "15", "16", "17", "18"];

interface NeonProject {
  id: string;
  name: string;
  region_id?: string;
  pg_version?: number;
}

interface NeonDatabase {
  name: string;
  owner_name: string;
  branch_id?: string;
}

interface NeonBranch {
  id: string;
  default?: boolean;
}

interface NeonOperation {
  action?: string;
  status?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fail early with a clear message when a role is not served by Neon. */
function assertRole(context: DeployContext) {
  if (!ROLES.includes(context.role)) throw new Error(`Neon does not support the ${context.role} role`);
}

/** Authenticated JSON client; credential values are redacted from errors. */
function client(context: DeployContext) {
  const key = context.credentials.NEON_API_KEY;
  if (!key) throw new Error("Missing credential NEON_API_KEY");
  return createApi({
    provider: "Neon",
    baseUrl: BASE_URL,
    headers: { authorization: `Bearer ${key}` },
    fetch: context.fetch,
    secrets: Object.values(context.credentials),
  });
}

type Api = ReturnType<typeof client>;

/** Find the project by exact name (the API `search` matches partial names and ids). */
async function findProject(context: DeployContext, api: Api) {
  const name = resourceName(context.app, context.environment, context.role);
  const query = new URLSearchParams({ search: name, limit: "400" });
  if (context.credentials.NEON_ORG_ID) query.set("org_id", context.credentials.NEON_ORG_ID);
  const list = await api.get<{ projects?: NeonProject[] }>(`/projects?${query}`);
  const project = (list?.projects ?? []).find((p) => p.name === name) ?? null;
  return { name, project };
}

/** Default branch database and owner role of an existing project (first database of the branch). */
async function defaultDatabase(api: Api, projectId: string): Promise<NeonDatabase & { branch_id: string }> {
  const { branches = [] } = (await api.get<{ branches?: NeonBranch[] }>(`/projects/${projectId}/branches`)) ?? {};
  const branch = branches.find((b) => b.default) ?? branches[0];
  if (!branch) throw new Error(`Neon project ${projectId} has no branch`);
  const { databases = [] } = (await api.get<{ databases?: NeonDatabase[] }>(`/projects/${projectId}/branches/${branch.id}/databases`)) ?? {};
  const database = databases[0];
  if (!database) throw new Error(`Neon project ${projectId} has no database on its default branch`);
  return { ...database, branch_id: branch.id };
}

/** Whether the pooled URI is requested (default true). */
function pooled(context: DeployContext) {
  return context.settings.pooled !== false;
}

/** Map recent project operations to a status: any scheduled/running operation means deploying. */
export function mapOperations(operations: NeonOperation[]): DeployStatus["state"] {
  if (operations.some((o) => o.status === "running" || o.status === "scheduling")) return "deploying";
  return "live";
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/** Read-only plan (GET only): create the project when missing, otherwise nothing to change. */
async function plan(context: DeployContext): Promise<DeployPlan> {
  assertRole(context);
  const api = client(context);
  const { name, project } = await findProject(context, api);
  const region = String(context.settings.region ?? "aws-us-east-1");
  const version = String(context.settings.pgVersion ?? "17");
  return {
    provider: PROVIDER,
    role: context.role,
    environment: context.environment,
    actions: [
      project
        ? { action: "noop", resource: name, detail: `Project ${project.id} exists (${project.region_id ?? "?"}, Postgres ${project.pg_version ?? "?"})` }
        : { action: "create", resource: name, detail: `Create Neon project in ${region} (Postgres ${version})` },
    ],
    state: project ? { projectId: project.id } : {},
  };
}

/**
 * Create the project when missing (found again by name, so re-runs never duplicate it) and return
 * the connection string as `outputs.DATABASE_URL`. The URL is a secret: it is never logged. Neon
 * generates the role password; it is only read back through the connection_uri endpoint.
 */
async function apply(context: DeployContext, _plan: DeployPlan): Promise<DeployResult> {
  assertRole(context);
  const api = client(context);
  const found = await findProject(context, api);
  let projectId: string;
  let database: { name: string; owner_name: string; branch_id?: string };

  if (found.project) {
    projectId = found.project.id;
    database = await defaultDatabase(api, projectId);
  } else {
    context.log(`Neon: creating project ${found.name}`);
    const created = await api.post<{ project: NeonProject; databases?: NeonDatabase[]; branch?: NeonBranch }>("/projects", {
      project: {
        name: found.name,
        region_id: String(context.settings.region ?? "aws-us-east-1"),
        pg_version: Number(context.settings.pgVersion ?? 17),
        ...(context.credentials.NEON_ORG_ID ? { org_id: context.credentials.NEON_ORG_ID } : {}),
      },
    });
    projectId = created.project.id;
    const first = created.databases?.[0];
    database = first ? { ...first, branch_id: created.branch?.id ?? first.branch_id } : await defaultDatabase(api, projectId);
  }

  const query = new URLSearchParams({ database_name: database.name, role_name: database.owner_name, pooled: String(pooled(context)) });
  if (database.branch_id) query.set("branch_id", database.branch_id);
  const { uri } = await api.get<{ uri: string }>(`/projects/${projectId}/connection_uri?${query}`);
  context.log(`Neon: ${pooled(context) ? "pooled" : "direct"} connection string ready for ${found.name}`);

  return {
    provider: PROVIDER,
    role: context.role,
    outputs: { DATABASE_URL: uri },
    resources: [
      { kind: "project", id: projectId, name: found.name },
      { kind: "database", id: database.name, name: database.name },
    ],
  };
}

/** missing when the project does not exist; deploying while operations run; otherwise live. */
async function status(context: DeployContext): Promise<DeployStatus> {
  assertRole(context);
  const api = client(context);
  const { project } = await findProject(context, api);
  if (!project) return { state: "missing" };
  const { operations = [] } = (await api.get<{ operations?: NeonOperation[] }>(`/projects/${project.id}/operations?limit=10`)) ?? {};
  const state = mapOperations(operations);
  return { state, detail: state === "deploying" ? "Operations in progress" : `Project ${project.id}` };
}

export const provider: DeployProvider = {
  id: PROVIDER,
  name: "Neon",
  roles: ROLES,
  website: "https://neon.com",
  credentials: [
    { key: "NEON_API_KEY", label: "Neon API key", url: "https://console.neon.tech/app/settings/api-keys" },
    { key: "NEON_ORG_ID", label: "Organization ID (org-…)", url: "https://console.neon.tech/app/settings", optional: true },
  ],
  settings: [
    { key: "region", label: "Region", type: "string", default: "aws-us-east-1", options: NEON_REGIONS },
    { key: "pgVersion", label: "Postgres version", type: "number", default: 17, options: NEON_PG_VERSIONS },
    {
      key: "pooled",
      label: "Pooled connection string",
      type: "boolean",
      default: true,
      help: "PgBouncer (transaction mode) URL for serverless; disable for the direct URL.",
    },
  ],
  notes: "Free plan computes scale to zero and wake on the next connection. Region and Postgres version are fixed at creation.",
  plan,
  apply,
  status,
};

export default provider;
