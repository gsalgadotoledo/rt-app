/**
 * DigitalOcean App Platform deploy provider (`@gsalgadotoledo/rt-app-deploy-digitalocean`).
 *
 * Each role is one App Platform app named `<app>-<environment>-<role>` with a single component
 * named after the role: api and ssr are `services` built from GitHub, the frontend is a
 * `static_sites` component. Runtime variables become `SECRET` environment variables.
 *
 * API reference: https://docs.digitalocean.com/reference/api/digitalocean/#tag/Apps
 * (base URL https://api.digitalocean.com/v2, Bearer auth). App spec reference:
 * https://docs.digitalocean.com/products/app-platform/reference/app-spec/
 */
import { createApi, resourceName } from "@gsalgadotoledo/rt-app-deploy";
import type { DeployContext, DeployPlan, DeployProvider, DeployResult, DeployStatus, PlannedAction, Role } from "@gsalgadotoledo/rt-app-deploy";

const API_URL = "https://api.digitalocean.com/v2";
const ROLES: Role[] = ["api", "ssr", "frontend"];

export const REGIONS = ["nyc", "sfo", "tor", "atl", "ams", "fra", "lon", "blr", "sgp", "syd"];
export const INSTANCE_SIZES = [
  "apps-s-1vcpu-0.5gb",
  "apps-s-1vcpu-1gb-fixed",
  "apps-s-1vcpu-1gb",
  "apps-s-1vcpu-2gb",
  "apps-s-2vcpu-4gb",
  "apps-d-1vcpu-0.5gb",
  "apps-d-1vcpu-1gb",
  "apps-d-1vcpu-2gb",
  "apps-d-1vcpu-4gb",
  "apps-d-2vcpu-4gb",
  "apps-d-2vcpu-8gb",
  "apps-d-4vcpu-8gb",
  "apps-d-4vcpu-16gb",
  "apps-d-8vcpu-32gb",
];

/** App and component names: `^[a-z][a-z0-9-]{0,30}[a-z0-9]$` (32 characters at most). */
const NAME_LENGTH = 32;
const PAGE_SIZE = 200;
const MAX_PAGES = 50;

type Spec = Record<string, any> & { name: string };

interface Deployment {
  id: string;
  phase?: string;
}

interface App {
  id: string;
  spec: Spec;
  live_url?: string;
  default_ingress?: string;
  active_deployment?: Deployment;
  in_progress_deployment?: Deployment;
  pending_deployment?: Deployment;
}

const DEPLOYING = ["PENDING_BUILD", "BUILDING", "PENDING_DEPLOY", "DEPLOYING"];
const FAILED = ["ERROR", "CANCELED"];

function assertRole(context: DeployContext) {
  if (!ROLES.includes(context.role))
    throw new Error(`DigitalOcean App Platform does not support the ${context.role} role (supported: ${ROLES.join(", ")})`);
}

function client(context: DeployContext) {
  const token = context.credentials.DIGITALOCEAN_TOKEN;
  if (!token) throw new Error("DigitalOcean: DIGITALOCEAN_TOKEN is required");
  return createApi({
    provider: "DigitalOcean",
    baseUrl: API_URL,
    headers: { authorization: `Bearer ${token}` },
    fetch: context.fetch,
    secrets: Object.values(context.credentials),
  });
}

type Api = ReturnType<typeof client>;

function nameFor(context: DeployContext) {
  return resourceName(context.app, context.environment, context.role, NAME_LENGTH);
}

function isStatic(role: Role) {
  return role === "frontend";
}

/** List every app page by page and return the one whose spec name matches. */
async function findApp(api: Api, name: string) {
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = await api.get<{ apps?: App[] }>(`/apps?page=${page}&per_page=${PAGE_SIZE}`);
    const apps = body?.apps ?? [];
    const found = apps.find((app) => app.spec?.name === name);
    if (found) return found;
    if (apps.length < PAGE_SIZE) return null;
  }
  return null;
}

function urlOf(app: App) {
  return app.live_url ?? app.default_ingress ?? undefined;
}

/** The single component this role owns, built from the application's source. */
function component(context: DeployContext) {
  const { source, settings } = context;
  const repository = source.repository;
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw new Error("DigitalOcean: source.repository must be a GitHub repository in the form owner/name");
  const directory = source.directory.replace(/^\.?\/+|\/+$/g, "");
  const base = {
    name: context.role,
    github: { repo: repository, branch: source.branch, deploy_on_push: false },
    ...(directory && directory !== "." ? { source_dir: directory } : {}),
    ...(source.buildCommand ? { build_command: source.buildCommand } : {}),
    envs: Object.entries(context.variables).map(([key, value]) => ({
      key,
      value,
      type: "SECRET",
      scope: isStatic(context.role) ? "BUILD_TIME" : "RUN_AND_BUILD_TIME",
    })),
  };
  if (isStatic(context.role)) {
    return {
      ...base,
      ...(source.outputDirectory ? { output_dir: source.outputDirectory } : {}),
      catchall_document: "index.html",
    };
  }
  // App Platform adds PORT=http_port itself when the spec does not define PORT.
  return {
    ...base,
    ...(source.startCommand ? { run_command: source.startCommand } : {}),
    http_port: Number(settings.port ?? 8080),
    instance_size_slug: String(settings.instanceSize ?? INSTANCE_SIZES[0]),
    instance_count: 1,
  };
}

/**
 * Desired spec: the existing spec (domains, alerts and other components are preserved) with this
 * role's component replaced and a `/` ingress rule to it when none routes there yet.
 */
function desiredSpec(context: DeployContext, existing?: Spec): Spec {
  const own = component(context);
  const listKey = isStatic(context.role) ? "static_sites" : "services";
  const spec: Spec = existing ? { ...existing } : { name: nameFor(context), region: String(context.settings.region ?? "nyc") };
  const others = ((spec[listKey] ?? []) as Array<{ name: string }>).filter((item) => item.name !== own.name);
  spec[listKey] = [...others, own];
  const rules = (spec.ingress?.rules ?? []) as Array<{ component?: { name: string } }>;
  if (!rules.some((rule) => rule.component?.name === own.name))
    spec.ingress = { ...spec.ingress, rules: [...rules, { component: { name: own.name }, match: { path: { prefix: "/" } } }] };
  return spec;
}

/** Read-only: find the app by name and describe what apply will do. */
async function plan(context: DeployContext): Promise<DeployPlan> {
  assertRole(context);
  const api = client(context);
  const name = nameFor(context);
  const app = await findApp(api, name);
  const kind = isStatic(context.role) ? "static site" : "service";
  const variables = Object.keys(context.variables).length;
  const actions: PlannedAction[] = app
    ? [
        { action: "update", resource: name, detail: `update the ${kind} component and ${variables} secret env vars in the app spec` },
        { action: "deploy", resource: name, detail: `deploy branch ${context.source.branch}` },
      ]
    : [
        { action: "create", resource: name, detail: `create app in ${context.settings.region ?? "nyc"} with a ${kind} and ${variables} secret env vars` },
        { action: "deploy", resource: name, detail: "initial deployment starts on creation" },
      ];
  return {
    provider: "digitalocean",
    role: context.role,
    environment: context.environment,
    actions,
    state: app ? { appId: app.id } : {},
  };
}

/** Create the app or update its spec, then make sure a deployment runs. Safe to re-run. */
async function apply(context: DeployContext, planned: DeployPlan): Promise<DeployResult> {
  assertRole(context);
  const api = client(context);
  const name = nameFor(context);
  // Validate the component before any request so bad input never reaches the API.
  component(context);
  const appId = typeof planned.state?.appId === "string" ? planned.state.appId : undefined;
  const existing = appId ? (await api.get<{ app: App }>(`/apps/${appId}`)).app : await findApp(api, name);
  let app: App;
  if (!existing) {
    context.log(`DigitalOcean: creating app ${name}`);
    app = (await api.post<{ app: App }>("/apps", { spec: desiredSpec(context) })).app;
  } else {
    context.log(`DigitalOcean: updating app ${name}`);
    app = (await api.put<{ app: App }>(`/apps/${existing.id}`, { spec: desiredSpec(context, existing.spec), update_all_source_versions: true })).app;
    // A spec update normally queues a deployment; only force one when none is pending.
    if (!app.pending_deployment?.id && !app.in_progress_deployment?.id) {
      const { deployment } = await api.post<{ deployment: Deployment }>(`/apps/${existing.id}/deployments`, { force_build: true });
      context.log(`DigitalOcean: deployment ${deployment.id} created`);
    }
  }
  return {
    provider: "digitalocean",
    role: context.role,
    url: urlOf(app),
    resources: [{ kind: "app", id: app.id, name }],
  };
}

function mapPhase(phase: string | undefined, url: string | undefined): DeployStatus {
  if (phase === "ACTIVE") return { state: "live", url };
  if (phase && DEPLOYING.includes(phase)) return { state: "deploying", url, detail: phase };
  if (phase && FAILED.includes(phase)) return { state: "failed", url, detail: phase };
  return { state: "unknown", url, detail: phase ?? "no deployments yet" };
}

/** Pending or in-progress deployment first, otherwise the phase of the latest deployment. */
async function status(context: DeployContext): Promise<DeployStatus> {
  assertRole(context);
  const api = client(context);
  const app = await findApp(api, nameFor(context));
  if (!app) return { state: "missing" };
  const url = urlOf(app);
  const running = app.in_progress_deployment ?? app.pending_deployment;
  if (running) return { state: "deploying", url, detail: running.phase };
  const body = await api.get<{ deployments?: Deployment[] }>(`/apps/${app.id}/deployments?page=1&per_page=1`);
  return mapPhase(body?.deployments?.[0]?.phase, url);
}

export const provider: DeployProvider = {
  id: "digitalocean",
  name: "DigitalOcean App Platform",
  roles: ROLES,
  website: "https://www.digitalocean.com/products/app-platform",
  credentials: [
    { key: "DIGITALOCEAN_TOKEN", label: "DigitalOcean personal access token (app read/write scopes)", url: "https://cloud.digitalocean.com/account/api/tokens" },
  ],
  settings: [
    { key: "region", label: "Region", type: "string", default: "nyc", options: REGIONS, help: "Set when the app is created." },
    { key: "instanceSize", label: "Instance size (api/ssr)", type: "string", default: INSTANCE_SIZES[0], options: INSTANCE_SIZES },
    { key: "port", label: "HTTP port the process listens on (api/ssr)", type: "number", default: 8080 },
  ],
  notes: "The DigitalOcean GitHub app must have access to the repository. Static sites receive variables at build time only. Each role is a separate app.",
  plan,
  apply,
  status,
};

export default provider;
