/**
 * Vercel deploy provider: Next.js SSR (`ssr`) and static SPA/admin (`frontend`) from a GitHub repository.
 *
 * One Vercel project per `<app>-<environment>-<role>`. Runtime variables become encrypted project
 * environment variables for the environment's target (prod → production, stage/develop → preview
 * limited to the source branch) and a git deployment of `source.branch` is created.
 *
 * API reference: https://vercel.com/docs/rest-api (OpenAPI: https://vercel.com/openapi.json).
 */
import {
  createApi,
  resourceName,
  ProviderError,
  type DeployContext,
  type DeployPlan,
  type DeployProvider,
  type DeployResult,
  type DeployStatus,
  type PlannedAction,
  type Role,
} from "@gsalgadotoledo/rt-app-deploy";

const PROVIDER = "vercel";
const BASE_URL = "https://api.vercel.com";
const ROLES: Role[] = ["ssr", "frontend"];

/** Compute regions for Vercel Functions (https://vercel.com/docs/regions). */
export const VERCEL_REGIONS = [
  "iad1", "cle1", "pdx1", "sfo1", "yul1", "gru1", "dub1", "lhr1", "cdg1", "fra1",
  "arn1", "bom1", "sin1", "hkg1", "hnd1", "kix1", "icn1", "syd1", "cpt1",
];

interface VercelProject {
  id: string;
  name: string;
}

interface VercelDeployment {
  id?: string;
  uid?: string;
  url?: string | null;
  readyState?: string;
}

interface EnvResponse {
  failed?: Array<{ error?: { code?: string; key?: string; envVarKey?: string; message?: string } }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fail early with a clear message when a role is not served by Vercel. */
function assertRole(context: DeployContext) {
  if (!ROLES.includes(context.role)) throw new Error(`Vercel does not support the ${context.role} role`);
}

/** Authenticated JSON client. Every credential and runtime variable value is redacted from errors. */
function client(context: DeployContext) {
  const token = context.credentials.VERCEL_TOKEN;
  if (!token) throw new Error("Missing credential VERCEL_TOKEN");
  return createApi({
    provider: "Vercel",
    baseUrl: BASE_URL,
    headers: { authorization: `Bearer ${token}` },
    fetch: context.fetch,
    secrets: [...Object.values(context.credentials), ...Object.values(context.variables)],
  });
}

/** Append the optional `teamId` query parameter (VERCEL_TEAM_ID) to an API path. */
function withTeam(context: DeployContext, path: string) {
  const teamId = context.credentials.VERCEL_TEAM_ID;
  if (!teamId) return path;
  return `${path}${path.includes("?") ? "&" : "?"}teamId=${encodeURIComponent(teamId)}`;
}

/** Vercel env var target for an RT-App environment; preview variables are scoped to the branch. */
export function envTarget(context: DeployContext): { target: string[]; gitBranch?: string } {
  if (context.environment === "prod") return { target: ["production"] };
  return { target: ["preview"], gitBranch: context.source.branch };
}

/** Split `owner/name` into the GitHub org and repository name Vercel expects. */
function repository(context: DeployContext) {
  const value = context.source.repository ?? "";
  const [org, repo, extra] = value.split("/");
  if (!org || !repo || extra !== undefined) throw new Error("Vercel needs source.repository as owner/name (GitHub)");
  return { full: value, org, repo };
}

/** Project build settings: Next.js for ssr, no framework preset plus output folder for frontend. */
function projectSettings(context: DeployContext) {
  const settings: Record<string, unknown> = {
    framework: context.role === "ssr" ? "nextjs" : null,
    rootDirectory: context.source.directory && context.source.directory !== "." ? context.source.directory : null,
  };
  if (context.source.buildCommand) settings.buildCommand = context.source.buildCommand;
  if (context.role === "frontend") settings.outputDirectory = context.source.outputDirectory ?? null;
  const region = context.settings.functionRegion;
  if (context.role === "ssr" && typeof region === "string" && region) settings.serverlessFunctionRegion = region;
  return settings;
}

/** Find the project by name; null when it does not exist (404). */
async function findProject(context: DeployContext, api: ReturnType<typeof client>) {
  const name = resourceName(context.app, context.environment, context.role);
  const project = await api.find<VercelProject>(withTeam(context, `/v9/projects/${encodeURIComponent(name)}`));
  return { name, project };
}

/** Map a Vercel deployment `readyState` to the RT-App status vocabulary. */
export function mapReadyState(state: string | undefined): DeployStatus["state"] {
  switch (state) {
    case "READY":
      return "live";
    case "QUEUED":
    case "INITIALIZING":
    case "BUILDING":
      return "deploying";
    case "ERROR":
    case "CANCELED":
    case "BLOCKED":
      return "failed";
    default:
      return "unknown";
  }
}

function deploymentUrl(deployment: VercelDeployment) {
  return deployment.url ? `https://${deployment.url}` : undefined;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/** Read-only plan: looks the project up (GET only) and lists what apply will do. */
async function plan(context: DeployContext): Promise<DeployPlan> {
  assertRole(context);
  const api = client(context);
  const { name, project } = await findProject(context, api);
  const { target, gitBranch } = envTarget(context);
  const count = Object.keys(context.variables).length;
  const actions: PlannedAction[] = [
    project
      ? { action: "update", resource: name, detail: `Update project settings (${context.role === "ssr" ? "Next.js" : "static"})` }
      : { action: "create", resource: name, detail: `Create project from ${context.source.repository ?? "?"} (${context.source.directory})` },
  ];
  if (count)
    actions.push({
      action: "update",
      resource: name,
      detail: `Set ${count} encrypted variable(s) for ${target[0]}${gitBranch ? ` (branch ${gitBranch})` : ""}`,
    });
  actions.push({ action: "deploy", resource: name, detail: `Deploy branch ${context.source.branch} to ${target[0]}` });
  return {
    provider: PROVIDER,
    role: context.role,
    environment: context.environment,
    actions,
    state: project ? { projectId: project.id } : {},
  };
}

/**
 * Create or update the project, upsert every runtime variable (values never logged) and trigger a
 * git deployment. Safe to re-run: the project is found by name and variables use `upsert=true`.
 * Throws ProviderError (redacted) when Vercel rejects a call or any variable fails.
 */
async function apply(context: DeployContext, _plan: DeployPlan): Promise<DeployResult> {
  assertRole(context);
  const api = client(context);
  const repo = repository(context);
  const settings = projectSettings(context);
  const found = await findProject(context, api);
  let project = found.project;

  if (project) {
    context.log(`Vercel: updating project ${found.name}`);
    await api.patch(withTeam(context, `/v9/projects/${project.id}`), settings);
  } else {
    context.log(`Vercel: creating project ${found.name}`);
    project = await api.post<VercelProject>(withTeam(context, "/v11/projects"), {
      name: found.name,
      ...settings,
      gitRepository: { type: "github", repo: repo.full },
    });
  }

  const { target, gitBranch } = envTarget(context);
  const variables = Object.entries(context.variables).map(([key, value]) => ({
    key,
    value,
    type: context.settings.sensitiveVariables === true ? "sensitive" : "encrypted",
    target,
    ...(gitBranch ? { gitBranch } : {}),
  }));
  if (variables.length) {
    context.log(`Vercel: setting ${variables.length} variable(s) for ${target[0]}`);
    const response = await api.post<EnvResponse>(withTeam(context, `/v10/projects/${project.id}/env?upsert=true`), variables);
    const failed = response?.failed ?? [];
    if (failed.length) {
      const keys = failed.map((f) => `${f.error?.envVarKey ?? f.error?.key ?? "?"}:${f.error?.code ?? "error"}`).join(", ");
      throw new ProviderError("Vercel", 400, `environment variables failed (${keys})`);
    }
  }

  context.log(`Vercel: deploying ${context.source.branch}`);
  const deployment = await api.post<VercelDeployment>(withTeam(context, "/v13/deployments?skipAutoDetectionConfirmation=1"), {
    name: found.name,
    project: project.id,
    ...(context.environment === "prod" ? { target: "production" } : {}),
    gitSource: { type: "github", org: repo.org, repo: repo.repo, ref: context.source.branch },
  });

  return {
    provider: PROVIDER,
    role: context.role,
    url: deploymentUrl(deployment),
    resources: [
      { kind: "project", id: project.id, name: found.name },
      { kind: "deployment", id: String(deployment.id ?? deployment.uid ?? ""), name: found.name },
    ],
  };
}

/** Latest deployment state for the environment: production target for prod, the branch otherwise. */
async function status(context: DeployContext): Promise<DeployStatus> {
  assertRole(context);
  const api = client(context);
  const { project } = await findProject(context, api);
  if (!project) return { state: "missing" };
  const filter = context.environment === "prod" ? "target=production" : `branch=${encodeURIComponent(context.source.branch)}`;
  const list = await api.get<{ deployments?: VercelDeployment[] }>(
    withTeam(context, `/v7/deployments?projectId=${project.id}&limit=1&${filter}`),
  );
  const latest = list?.deployments?.[0];
  if (!latest) return { state: "missing", detail: "Project exists but has no deployment yet" };
  return { state: mapReadyState(latest.readyState), url: deploymentUrl(latest), detail: latest.readyState };
}

export const provider: DeployProvider = {
  id: PROVIDER,
  name: "Vercel",
  roles: ROLES,
  website: "https://vercel.com",
  credentials: [
    { key: "VERCEL_TOKEN", label: "Vercel access token", url: "https://vercel.com/account/settings/tokens" },
    { key: "VERCEL_TEAM_ID", label: "Team ID (team projects only)", url: "https://vercel.com/docs/accounts#find-your-team-id", optional: true },
  ],
  settings: [
    {
      key: "functionRegion",
      label: "Function region (SSR)",
      type: "string",
      default: "iad1",
      options: VERCEL_REGIONS,
      help: "Run Next.js functions close to the database.",
    },
    {
      key: "sensitiveVariables",
      label: "Store variables as sensitive",
      type: "boolean",
      default: false,
      help: "Sensitive values cannot be read back from the Vercel dashboard.",
    },
  ],
  notes: "Builds from GitHub: install the Vercel GitHub app on the repository first. Preview variables are scoped to the stage/develop branch.",
  plan,
  apply,
  status,
};

export default provider;
