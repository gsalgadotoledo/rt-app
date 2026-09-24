/**
 * Railway deploy provider (`railway`): API and SSR services built from GitHub, and Railway Postgres.
 *
 * Model: one Railway project per application environment (`<app>-<environment>`), holding one
 * Railway environment with the same name as ours (develop | stage | prod) and one service per role
 * (`<app>-<environment>-<role>`). Keeping environments in separate projects means each service has
 * exactly one instance, so branch, root directory and variables never leak between environments.
 *
 * Everything goes through the public GraphQL API (https://docs.railway.com/integrations/api).
 */
import { randomBytes } from "node:crypto";
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
  type Role,
} from "@gsalgadotoledo/rt-app-deploy";

const PROVIDER = "Railway";
const API_ORIGIN = "https://backboard.railway.com";
const API_PATH = "/graphql/v2";
const POSTGRES_IMAGE = "ghcr.io/railwayapp-templates/postgres-ssl";
/** The postgres-ssl image refuses to start unless its volume is mounted exactly here. */
const POSTGRES_MOUNT = "/var/lib/postgresql/data";
const REGIONS = ["us-west2", "us-east4-eqdc4a", "europe-west4-drams3a", "asia-southeast1-eqsg3a"];
const ROLES: Role[] = ["api", "ssr", "database"];

// ---------------------------------------------------------------------------
// GraphQL operations (copied from the official API guides)
// ---------------------------------------------------------------------------

export const QUERIES = {
  projects: `query projects {
  projects {
    edges {
      node {
        id
        name
      }
    }
  }
}`,
  workspaceProjects: `query workspaceProjects($workspaceId: String!) {
  projects(workspaceId: $workspaceId) {
    edges {
      node {
        id
        name
      }
    }
  }
}`,
  project: `query project($id: String!) {
  project(id: $id) {
    id
    name
    services {
      edges {
        node {
          id
          name
        }
      }
    }
    environments {
      edges {
        node {
          id
          name
        }
      }
    }
  }
}`,
  serviceInstance: `query serviceInstance($serviceId: String!, $environmentId: String!) {
  serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
    id
    rootDirectory
    latestDeployment {
      id
      status
    }
  }
}`,
  domains: `query domains($projectId: String!, $environmentId: String!, $serviceId: String!) {
  domains(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) {
    serviceDomains {
      id
      domain
    }
  }
}`,
  variables: `query variables($projectId: String!, $environmentId: String!, $serviceId: String) {
  variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
}`,
  projectCreate: `mutation projectCreate($input: ProjectCreateInput!) {
  projectCreate(input: $input) {
    id
    name
  }
}`,
  environmentCreate: `mutation environmentCreate($input: EnvironmentCreateInput!) {
  environmentCreate(input: $input) {
    id
    name
  }
}`,
  serviceCreate: `mutation serviceCreate($input: ServiceCreateInput!) {
  serviceCreate(input: $input) {
    id
    name
  }
}`,
  serviceInstanceUpdate: `mutation serviceInstanceUpdate($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) {
  serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
}`,
  volumeCreate: `mutation volumeCreate($input: VolumeCreateInput!) {
  volumeCreate(input: $input) {
    id
    name
  }
}`,
  variableCollectionUpsert: `mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) {
  variableCollectionUpsert(input: $input)
}`,
  serviceDomainCreate: `mutation serviceDomainCreate($input: ServiceDomainCreateInput!) {
  serviceDomainCreate(input: $input) {
    id
    domain
  }
}`,
  serviceInstanceDeployV2: `mutation serviceInstanceDeployV2($serviceId: String!, $environmentId: String!) {
  serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId)
}`,
};

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** GraphQL call; `secrets` can grow (e.g. a generated password) and is used for every redaction. */
type Graphql = (<T = any>(query: string, variables?: Record<string, unknown>) => Promise<T>) & { secrets: string[] };

/**
 * GraphQL client on top of `createApi`: POST `{query, variables}` with the account/workspace token.
 * Railway answers authorization and domain failures with HTTP 200 and an `errors` array, so those
 * are raised as ProviderError too. Every message is redacted with the token and runtime variables.
 */
export function createGraphql(context: DeployContext): Graphql {
  const token = context.credentials.RAILWAY_API_TOKEN;
  if (!token) throw new ProviderError(PROVIDER, 0, "RAILWAY_API_TOKEN is required");
  const secrets = [token, ...Object.values(context.variables)];
  const api = createApi({
    provider: PROVIDER,
    baseUrl: API_ORIGIN,
    headers: { authorization: `Bearer ${token}` },
    fetch: context.fetch,
    secrets,
  });

  const call = async <T = any>(query: string, variables: Record<string, unknown> = {}) => {
    const operation = /^(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "operation";
    const response = await api.post<{ data?: T; errors?: Array<{ message?: string; extensions?: { code?: string } }> }>(API_PATH, {
      query,
      variables,
    });
    if (response?.errors?.length) {
      const detail = response.errors.map((e) => [e.extensions?.code, e.message].filter(Boolean).join(" ")).join("; ");
      throw new ProviderError(PROVIDER, 200, redact(`${operation} failed: ${detail}`.slice(0, 700), secrets));
    }
    if (!response?.data) throw new ProviderError(PROVIDER, 200, `${operation} returned no data`);
    return response.data;
  };
  return Object.assign(call, { secrets });
}

// ---------------------------------------------------------------------------
// Discovery (reads only)
// ---------------------------------------------------------------------------

interface Names {
  project: string;
  environment: string;
  service: string;
}

interface Found {
  projectId?: string;
  environmentId?: string;
  serviceId?: string;
  deploymentStatus?: string;
  domain?: string;
}

/** Remote names for a context: project `<app>-<env>`, environment `<env>`, service `<app>-<env>-<role>`. */
export function railwayNames(context: DeployContext): Names {
  return {
    project: resourceName(context.app, context.environment, ""),
    environment: context.environment,
    service: resourceName(context.app, context.environment, context.role),
  };
}

function nodes<T>(connection: { edges?: Array<{ node: T }> } | undefined): T[] {
  return (connection?.edges ?? []).map((edge) => edge.node);
}

/** Find the project, environment, service, latest deployment and public domain by name. */
async function discover(gql: Graphql, context: DeployContext, names: Names): Promise<Found> {
  const workspaceId = context.credentials.RAILWAY_WORKSPACE_ID;
  const list = workspaceId
    ? await gql(QUERIES.workspaceProjects, { workspaceId })
    : await gql(QUERIES.projects);
  const project = nodes<{ id: string; name: string }>(list.projects).find((p) => p.name === names.project);
  if (!project) return {};

  const { project: detail } = await gql(QUERIES.project, { id: project.id });
  const environment = nodes<{ id: string; name: string }>(detail?.environments).find((e) => e.name === names.environment);
  const service = nodes<{ id: string; name: string }>(detail?.services).find((s) => s.name === names.service);
  const found: Found = { projectId: project.id, environmentId: environment?.id, serviceId: service?.id };
  if (!environment || !service) return found;

  const { serviceInstance } = await gql(QUERIES.serviceInstance, { serviceId: service.id, environmentId: environment.id });
  found.deploymentStatus = serviceInstance?.latestDeployment?.status;
  if (context.role !== "database") found.domain = await findDomain(gql, found);
  return found;
}

async function findDomain(gql: Graphql, found: Found) {
  const { domains } = await gql(QUERIES.domains, {
    projectId: found.projectId,
    environmentId: found.environmentId,
    serviceId: found.serviceId,
  });
  return domains?.serviceDomains?.[0]?.domain as string | undefined;
}

function assertRole(context: DeployContext) {
  if (!ROLES.includes(context.role)) throw new ProviderError(PROVIDER, 0, `Railway does not support the ${context.role} role`);
}

function assertSource(context: DeployContext) {
  if (context.role !== "database" && !context.source.repository)
    throw new ProviderError(PROVIDER, 0, "Railway builds from GitHub: source.repository (owner/name) is required");
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

/** Read-only plan: which project, environment, service, variables, domain and deployment change. */
async function plan(context: DeployContext): Promise<DeployPlan> {
  assertRole(context);
  assertSource(context);
  const names = railwayNames(context);
  const found = await discover(createGraphql(context), context, names);
  const actions: PlannedAction[] = [];
  const database = context.role === "database";

  if (!found.projectId) actions.push({ action: "create", resource: `project ${names.project}`, detail: `Railway project with environment ${names.environment}` });
  else if (!found.environmentId) actions.push({ action: "create", resource: `environment ${names.environment}`, detail: `in project ${names.project}` });

  if (!found.serviceId) {
    const source = database ? `${POSTGRES_IMAGE}:${postgresVersion(context)} with a volume at ${POSTGRES_MOUNT}` : `${context.source.repository}@${context.source.branch}`;
    actions.push({ action: "create", resource: `service ${names.service}`, detail: source });
  } else if (database) {
    actions.push({ action: "noop", resource: `service ${names.service}`, detail: "Postgres already provisioned" });
  } else {
    actions.push({ action: "update", resource: `service ${names.service}`, detail: `root directory ${context.source.directory}` });
  }

  if (!database) {
    const keys = Object.keys(context.variables);
    if (keys.length) actions.push({ action: "update", resource: "variables", detail: keys.sort().join(", ") });
    if (!found.domain) actions.push({ action: "create", resource: "domain", detail: "Railway-provided *.up.railway.app domain" });
  }
  if (!database || !found.serviceId) actions.push({ action: "deploy", resource: `service ${names.service}`, detail: "serviceInstanceDeployV2" });

  return { provider: "railway", role: context.role, environment: context.environment, actions, state: { ...found } };
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

function postgresVersion(context: DeployContext) {
  return String(context.settings.postgresVersion ?? "17");
}

/** Service instance settings sent on every apply; unset values are left to Railway. */
function instanceInput(context: DeployContext) {
  const input: Record<string, unknown> = {};
  if (context.role !== "database") {
    input.rootDirectory = context.source.directory;
    if (context.source.buildCommand) input.buildCommand = context.source.buildCommand;
    if (context.source.startCommand) input.startCommand = context.source.startCommand;
    if (context.settings.healthcheckPath) input.healthcheckPath = String(context.settings.healthcheckPath);
  }
  if (context.settings.region) input.region = String(context.settings.region);
  return input;
}

/** Create the project (and its first environment) or the environment when missing. */
async function ensureProject(gql: Graphql, context: DeployContext, names: Names, found: Found, resources: DeployResult["resources"]) {
  let { projectId, environmentId } = found;
  if (!projectId) {
    const workspaceId = context.credentials.RAILWAY_WORKSPACE_ID;
    const input = { name: names.project, defaultEnvironmentName: names.environment, ...(workspaceId ? { workspaceId } : {}) };
    const { projectCreate } = await gql(QUERIES.projectCreate, { input });
    projectId = projectCreate.id as string;
    context.log(`Railway: created project ${names.project}`);
    const { project } = await gql(QUERIES.project, { id: projectId });
    environmentId = nodes<{ id: string; name: string }>(project?.environments).find((e) => e.name === names.environment)?.id;
  }
  if (!environmentId) {
    const { environmentCreate } = await gql(QUERIES.environmentCreate, { input: { projectId, name: names.environment } });
    environmentId = environmentCreate.id as string;
    context.log(`Railway: created environment ${names.environment}`);
  }
  resources.push({ kind: "project", id: projectId!, name: names.project });
  resources.push({ kind: "environment", id: environmentId!, name: names.environment });
  return { projectId: projectId!, environmentId: environmentId! };
}

/** API/SSR: GitHub service, instance settings, variables, domain and a deployment. */
async function applyApp(gql: Graphql, context: DeployContext, names: Names, found: Found): Promise<DeployResult> {
  const { repository, branch } = context.source;
  assertSource(context);
  const resources: DeployResult["resources"] = [];
  const { projectId, environmentId } = await ensureProject(gql, context, names, found, resources);

  let serviceId = found.serviceId;
  if (!serviceId) {
    const input = { projectId, name: names.service, source: { repo: repository }, branch };
    const { serviceCreate } = await gql(QUERIES.serviceCreate, { input });
    serviceId = serviceCreate.id as string;
    context.log(`Railway: created service ${names.service} from ${repository}@${branch}`);
  }
  resources.push({ kind: "service", id: serviceId, name: names.service });

  await gql(QUERIES.serviceInstanceUpdate, { serviceId, environmentId, input: instanceInput(context) });

  const keys = Object.keys(context.variables);
  if (keys.length) {
    // skipDeploys: the explicit deployment below picks every change up at once.
    const input = { projectId, environmentId, serviceId, variables: context.variables, skipDeploys: true };
    await gql(QUERIES.variableCollectionUpsert, { input });
    context.log(`Railway: set ${keys.length} variables (${keys.sort().join(", ")})`);
  }

  const ids = { projectId, environmentId, serviceId };
  let domain = found.serviceId ? await findDomain(gql, ids) : undefined;
  if (!domain) {
    const port = context.settings.port;
    const input = { serviceId, environmentId, ...(port ? { targetPort: Number(port) } : {}) };
    const { serviceDomainCreate } = await gql(QUERIES.serviceDomainCreate, { input });
    domain = serviceDomainCreate.domain as string;
    resources.push({ kind: "domain", id: serviceDomainCreate.id, name: domain });
  }

  const { serviceInstanceDeployV2 } = await gql(QUERIES.serviceInstanceDeployV2, { serviceId, environmentId });
  resources.push({ kind: "deployment", id: String(serviceInstanceDeployV2), name: names.service });
  context.log(`Railway: deployment ${serviceInstanceDeployV2} started`);

  return { provider: "railway", role: context.role, url: `https://${domain}`, resources };
}

/**
 * Database: Railway Postgres from the official postgres-ssl image with a volume, credentials
 * generated once on creation (never rotated by re-runs). Returns the private DATABASE_URL and,
 * when Public Access was enabled in Railway, DATABASE_PUBLIC_URL.
 */
async function applyDatabase(gql: Graphql, context: DeployContext, names: Names, found: Found): Promise<DeployResult> {
  const resources: DeployResult["resources"] = [];
  const { projectId, environmentId } = await ensureProject(gql, context, names, found, resources);

  let serviceId = found.serviceId;
  if (!serviceId) {
    const image = `${POSTGRES_IMAGE}:${postgresVersion(context)}`;
    const { serviceCreate } = await gql(QUERIES.serviceCreate, { input: { projectId, name: names.service, source: { image } } });
    serviceId = serviceCreate.id as string;
    resources.push({ kind: "service", id: serviceId, name: names.service });
    const { volumeCreate } = await gql(QUERIES.volumeCreate, { input: { projectId, environmentId, serviceId, mountPath: POSTGRES_MOUNT } });
    resources.push({ kind: "volume", id: volumeCreate.id, name: volumeCreate.name ?? POSTGRES_MOUNT });

    // Generated once; re-runs find the service and never rotate it. Hex keeps the URL unescaped.
    const password = randomBytes(24).toString("hex");
    gql.secrets.push(password);
    const variables = {
      POSTGRES_USER: "postgres",
      POSTGRES_PASSWORD: password,
      POSTGRES_DB: "railway",
      PGDATA: `${POSTGRES_MOUNT}/pgdata`,
      PGHOST: "${{RAILWAY_PRIVATE_DOMAIN}}",
      PGPORT: "5432",
      PGUSER: "${{POSTGRES_USER}}",
      PGPASSWORD: "${{POSTGRES_PASSWORD}}",
      PGDATABASE: "${{POSTGRES_DB}}",
      DATABASE_URL: "postgresql://${{PGUSER}}:${{POSTGRES_PASSWORD}}@${{RAILWAY_PRIVATE_DOMAIN}}:5432/${{PGDATABASE}}",
    };
    await gql(QUERIES.variableCollectionUpsert, { input: { projectId, environmentId, serviceId, variables, skipDeploys: true } });
    const input = instanceInput(context);
    if (Object.keys(input).length) await gql(QUERIES.serviceInstanceUpdate, { serviceId, environmentId, input });
    const { serviceInstanceDeployV2 } = await gql(QUERIES.serviceInstanceDeployV2, { serviceId, environmentId });
    resources.push({ kind: "deployment", id: String(serviceInstanceDeployV2), name: names.service });
    context.log(`Railway: created Postgres service ${names.service}`);
  } else {
    resources.push({ kind: "service", id: serviceId, name: names.service });
  }

  const { variables } = await gql<{ variables: Record<string, string> }>(QUERIES.variables, { projectId, environmentId, serviceId });
  gql.secrets.push(...Object.values(variables ?? {}));
  if (!variables?.DATABASE_URL) throw new ProviderError(PROVIDER, 0, `Service ${names.service} has no DATABASE_URL variable`);
  const outputs: Record<string, string> = { DATABASE_URL: variables.DATABASE_URL };
  if (variables.DATABASE_PUBLIC_URL) outputs.DATABASE_PUBLIC_URL = variables.DATABASE_PUBLIC_URL;
  return { provider: "railway", role: "database", outputs, resources };
}

/** Idempotent apply: find by name (or reuse the plan's ids), create what is missing, deploy. */
async function apply(context: DeployContext, deployPlan: DeployPlan): Promise<DeployResult> {
  assertRole(context);
  const names = railwayNames(context);
  const gql = createGraphql(context);
  const state = deployPlan.provider === "railway" && deployPlan.state ? (deployPlan.state as Found) : await discover(gql, context, names);
  if (context.role === "database") return applyDatabase(gql, context, names, state);
  return applyApp(gql, context, names, state);
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/** Map a Railway DeploymentStatus to the contract's state. */
export function mapDeploymentStatus(status: string | undefined): DeployStatus["state"] {
  switch (status) {
    case "SUCCESS":
    case "SLEEPING":
      return "live";
    case "BUILDING":
    case "DEPLOYING":
    case "INITIALIZING":
    case "QUEUED":
    case "WAITING":
      return "deploying";
    case "FAILED":
    case "CRASHED":
      return "failed";
    default:
      return "unknown";
  }
}

/** Current state of the role's service from its latest deployment. */
async function status(context: DeployContext): Promise<DeployStatus> {
  assertRole(context);
  const found = await discover(createGraphql(context), context, railwayNames(context));
  if (!found.serviceId || !found.environmentId) return { state: "missing" };
  const result: DeployStatus = {
    state: mapDeploymentStatus(found.deploymentStatus),
    detail: found.deploymentStatus ? `Latest deployment ${found.deploymentStatus}` : "No deployments yet",
  };
  if (found.domain) result.url = `https://${found.domain}`;
  return result;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const provider: DeployProvider = {
  id: "railway",
  name: "Railway",
  roles: ROLES,
  website: "https://railway.com",
  credentials: [
    { key: "RAILWAY_API_TOKEN", label: "Account or workspace token", url: "https://railway.com/account/tokens" },
    { key: "RAILWAY_WORKSPACE_ID", label: "Workspace ID (projects are listed and created there)", optional: true },
  ],
  settings: [
    { key: "region", label: "Region", type: "string", options: REGIONS, help: "Defaults to the workspace's preferred region" },
    { key: "healthcheckPath", label: "Health check path", type: "string", help: "e.g. /health (api/ssr)" },
    { key: "port", label: "Public domain target port", type: "number", help: "Only when the process does not listen on $PORT" },
    { key: "postgresVersion", label: "Postgres major version", type: "string", default: "17", options: ["14", "15", "16", "17", "18"] },
  ],
  notes:
    "One Railway project per environment. API/SSR build from GitHub (install the Railway GitHub app for the repository). " +
    "DATABASE_URL is private to the Railway project; enable Public Access on the Postgres service for other providers (DATABASE_PUBLIC_URL).",
  plan,
  apply,
  status,
};

export default provider;
