/**
 * Render deploy provider (`@gsalgadotoledo/rt-app-deploy-render`).
 *
 * api and ssr roles become Render web services built from GitHub (native runtimes: node, python,
 * go); the frontend role becomes a Render static site. Every runtime variable is stored as a
 * service environment variable (Render keeps them private to the workspace).
 *
 * API reference: https://api-docs.render.com (base URL https://api.render.com/v1, Bearer auth).
 */
import { createApi, resourceName } from "@gsalgadotoledo/rt-app-deploy";
import type { DeployContext, DeployPlan, DeployProvider, DeployResult, DeployStatus, PlannedAction, Role } from "@gsalgadotoledo/rt-app-deploy";

const API_URL = "https://api.render.com/v1";
const ROLES: Role[] = ["api", "ssr", "frontend"];

export const REGIONS = ["oregon", "ohio", "virginia", "frankfurt", "singapore"];
export const PLANS = ["free", "starter", "standard", "pro", "pro_plus", "pro_max", "pro_ultra"];

/** Render service object as returned inside `{ service }` list items and by PATCH. */
interface RenderService {
  id: string;
  name: string;
  type: string;
  ownerId?: string;
  suspended?: "suspended" | "not_suspended";
  dashboardUrl?: string;
  serviceDetails?: { url?: string };
}

interface RenderDeploy {
  id: string;
  status: string;
}

type ServiceType = "web_service" | "static_site";

/** Default native build/start commands when the application does not provide them. */
const RUNTIME_DEFAULTS: Record<string, { build: string; start: string }> = {
  node: { build: "npm install && npm run build --if-present", start: "npm start" },
  python: { build: "pip install -r requirements.txt", start: "python main.py" },
  go: { build: "go build -o app .", start: "./app" },
};

const DEPLOYING = ["created", "queued", "build_in_progress", "update_in_progress", "pre_deploy_in_progress"];
const FAILED = ["build_failed", "update_failed", "pre_deploy_failed", "canceled"];

function assertRole(context: DeployContext) {
  if (!ROLES.includes(context.role)) throw new Error(`Render does not support the ${context.role} role (supported: ${ROLES.join(", ")})`);
}

function client(context: DeployContext) {
  const key = context.credentials.RENDER_API_KEY;
  if (!key) throw new Error("Render: RENDER_API_KEY is required");
  return createApi({
    provider: "Render",
    baseUrl: API_URL,
    headers: { authorization: `Bearer ${key}` },
    fetch: context.fetch,
    secrets: Object.values(context.credentials),
  });
}

function serviceType(role: Role): ServiceType {
  return role === "frontend" ? "static_site" : "web_service";
}

function nameFor(context: DeployContext) {
  return resourceName(context.app, context.environment, context.role);
}

/** Find the service by exact name and type (the `name` filter is applied again locally). */
async function findService(api: ReturnType<typeof client>, context: DeployContext) {
  const name = nameFor(context);
  const query = new URLSearchParams({ name, type: serviceType(context.role), limit: "100" });
  if (context.credentials.RENDER_OWNER_ID) query.set("ownerId", context.credentials.RENDER_OWNER_ID);
  const items = (await api.get<Array<{ service: RenderService }>>(`/services?${query}`)) ?? [];
  return items.map((item) => item.service).find((service) => service.name === name) ?? null;
}

/** Workspace for new services: RENDER_OWNER_ID, or the only workspace the key can see. */
async function resolveOwner(api: ReturnType<typeof client>, context: DeployContext) {
  if (context.credentials.RENDER_OWNER_ID) return context.credentials.RENDER_OWNER_ID;
  const owners = (await api.get<Array<{ owner: { id: string } }>>("/owners?limit=100")) ?? [];
  if (owners.length === 1) return owners[0].owner.id;
  throw new Error(`Render: the API key can access ${owners.length} workspaces; set RENDER_OWNER_ID`);
}

function repositoryUrl(context: DeployContext) {
  const repository = context.source.repository;
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw new Error("Render: source.repository must be a GitHub repository in the form owner/name");
  return `https://github.com/${repository}`;
}

function rootDir(context: DeployContext) {
  const directory = context.source.directory.replace(/^\.?\/+|\/+$/g, "");
  return directory === "." ? "" : directory;
}

function envVars(context: DeployContext) {
  return Object.entries(context.variables).map(([key, value]) => ({ key, value }));
}

/** Type-specific `serviceDetails` shared by create and update. */
function serviceDetails(context: DeployContext, creating: boolean) {
  const { source, settings } = context;
  if (serviceType(context.role) === "static_site") {
    return {
      buildCommand: source.buildCommand ?? "npm install && npm run build",
      publishPath: source.outputDirectory ?? "dist",
    };
  }
  const runtime = context.role === "ssr" ? "node" : source.runtime ?? "node";
  const defaults = RUNTIME_DEFAULTS[runtime];
  if (!defaults) throw new Error(`Render: unsupported runtime "${runtime}" for the ${context.role} role`);
  return {
    runtime,
    plan: String(settings.plan ?? "starter"),
    ...(creating ? { region: String(settings.region ?? "oregon") } : {}),
    ...(settings.healthCheckPath ? { healthCheckPath: String(settings.healthCheckPath) } : {}),
    envSpecificDetails: {
      buildCommand: source.buildCommand ?? defaults.build,
      startCommand: source.startCommand ?? defaults.start,
    },
  };
}

/** Read-only: find the service and describe what apply will do. */
async function plan(context: DeployContext): Promise<DeployPlan> {
  assertRole(context);
  const api = client(context);
  const name = nameFor(context);
  const service = await findService(api, context);
  const kind = serviceType(context.role) === "static_site" ? "static site" : "web service";
  const variables = Object.keys(context.variables).length;
  const actions: PlannedAction[] = service
    ? [
        { action: "update", resource: name, detail: `update ${kind} settings and replace ${variables} environment variables` },
        { action: "deploy", resource: name, detail: `deploy branch ${context.source.branch}` },
      ]
    : [
        { action: "create", resource: name, detail: `create ${kind} from ${context.source.repository ?? "?"}@${context.source.branch} with ${variables} environment variables` },
        { action: "deploy", resource: name, detail: "initial deploy starts on creation" },
      ];
  return {
    provider: "render",
    role: context.role,
    environment: context.environment,
    actions,
    state: service ? { serviceId: service.id } : {},
  };
}

/** Create or update the service, replace its environment variables and start a deploy. Safe to re-run. */
async function apply(context: DeployContext, planned: DeployPlan): Promise<DeployResult> {
  assertRole(context);
  const api = client(context);
  const name = nameFor(context);
  const repo = repositoryUrl(context);
  const knownId = typeof planned.state?.serviceId === "string" ? planned.state.serviceId : undefined;
  // Look again when the plan saw nothing: another run may have created it meanwhile.
  const existing = knownId ? { id: knownId } : await findService(api, context);
  let service: RenderService;
  if (!existing) {
    const ownerId = await resolveOwner(api, context);
    context.log(`Render: creating ${serviceType(context.role)} ${name}`);
    const created = await api.post<{ service: RenderService; deployId?: string }>("/services", {
      type: serviceType(context.role),
      name,
      ownerId,
      repo,
      branch: context.source.branch,
      autoDeploy: "no",
      rootDir: rootDir(context),
      envVars: envVars(context),
      serviceDetails: serviceDetails(context, true),
    });
    service = created.service;
  } else {
    context.log(`Render: updating ${name}`);
    service = await api.patch<RenderService>(`/services/${existing.id}`, {
      repo,
      branch: context.source.branch,
      autoDeploy: "no",
      rootDir: rootDir(context),
      serviceDetails: serviceDetails(context, false),
    });
    await api.put(`/services/${existing.id}/env-vars`, envVars(context));
    const deploy = await api.post<RenderDeploy>(`/services/${existing.id}/deploys`, { clearCache: "do_not_clear" });
    context.log(`Render: deploy ${deploy?.id ?? ""} started`);
  }
  return {
    provider: "render",
    role: context.role,
    url: service.serviceDetails?.url,
    resources: [{ kind: serviceType(context.role), id: service.id, name }],
  };
}

/** Map the latest deploy of the service to the shared status vocabulary. */
async function status(context: DeployContext): Promise<DeployStatus> {
  assertRole(context);
  const api = client(context);
  const service = await findService(api, context);
  if (!service) return { state: "missing" };
  const url = service.serviceDetails?.url;
  if (service.suspended === "suspended") return { state: "unknown", url, detail: "service is suspended" };
  const deploys = (await api.get<Array<{ deploy: RenderDeploy }>>(`/services/${service.id}/deploys?limit=1`)) ?? [];
  const latest = deploys[0]?.deploy;
  if (!latest) return { state: "unknown", url, detail: "no deploys yet" };
  if (latest.status === "live") return { state: "live", url };
  if (DEPLOYING.includes(latest.status)) return { state: "deploying", url, detail: latest.status };
  if (FAILED.includes(latest.status)) return { state: "failed", url, detail: latest.status };
  return { state: "unknown", url, detail: latest.status };
}

export const provider: DeployProvider = {
  id: "render",
  name: "Render",
  roles: ROLES,
  website: "https://render.com",
  credentials: [
    { key: "RENDER_API_KEY", label: "Render API key", url: "https://dashboard.render.com/u/settings?add-api-key" },
    { key: "RENDER_OWNER_ID", label: "Workspace (owner) id, required when the key can access several workspaces", optional: true },
  ],
  settings: [
    { key: "region", label: "Region", type: "string", default: "oregon", options: REGIONS, help: "Fixed at creation; Render cannot move a service." },
    { key: "plan", label: "Instance type (api/ssr)", type: "string", default: "starter", options: PLANS },
    { key: "healthCheckPath", label: "Health check path (api/ssr)", type: "string" },
  ],
  notes: "Free instances sleep after 15 minutes without traffic and wake up slowly. The GitHub repository must be connected to Render. Region cannot change after creation.",
  plan,
  apply,
  status,
};

export default provider;
