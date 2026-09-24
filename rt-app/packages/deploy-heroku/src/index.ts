/**
 * Heroku deploy provider (`@gsalgadotoledo/rt-app-deploy-heroku`).
 *
 * The api role becomes a Heroku app (personal, or in HEROKU_TEAM) built with the Build API from a
 * GitHub source tarball. Runtime variables are stored as config vars. Monorepo folders are built
 * with the monorepo buildpack (`APP_BASE` config var) followed by the language buildpack.
 *
 * API reference: https://devcenter.heroku.com/articles/platform-api-reference
 * (base URL https://api.heroku.com, `Accept: application/vnd.heroku+json; version=3`, Bearer auth).
 */
import { ProviderError, createApi, redact, resourceName } from "@gsalgadotoledo/rt-app-deploy";
import type { DeployContext, DeployPlan, DeployProvider, DeployResult, DeployStatus, PlannedAction, Role } from "@gsalgadotoledo/rt-app-deploy";

const API_URL = "https://api.heroku.com";
const GITHUB_API_URL = "https://api.github.com";
const ACCEPT = "application/vnd.heroku+json; version=3";
const ROLES: Role[] = ["api"];

export const REGIONS = ["us", "eu"];

/** Heroku app names: `^[a-z][a-z0-9-]{1,28}[a-z0-9]$` (30 characters at most). */
const NAME_LENGTH = 30;

/** Language buildpacks (Buildpack Registry names) used after the monorepo buildpack. */
const BUILDPACKS: Record<string, string> = {
  node: "heroku/nodejs",
  python: "heroku/python",
  go: "heroku/go",
};

const MONOREPO_BUILDPACK = "https://github.com/lstoll/heroku-buildpack-monorepo";

interface HerokuApp {
  id: string;
  name: string;
  web_url?: string | null;
}

interface HerokuBuild {
  id: string;
  status: "pending" | "succeeded" | "failed";
}

function assertRole(context: DeployContext) {
  if (!ROLES.includes(context.role)) throw new Error(`Heroku does not support the ${context.role} role (supported: ${ROLES.join(", ")})`);
}

function secrets(context: DeployContext, extra: string[] = []) {
  return [...Object.values(context.credentials), ...extra];
}

function client(context: DeployContext, extraHeaders: Record<string, string> = {}, extraSecrets: string[] = []) {
  const key = context.credentials.HEROKU_API_KEY;
  if (!key) throw new Error("Heroku: HEROKU_API_KEY is required");
  return createApi({
    provider: "Heroku",
    baseUrl: API_URL,
    headers: { accept: ACCEPT, authorization: `Bearer ${key}`, ...extraHeaders },
    fetch: context.fetch,
    secrets: secrets(context, extraSecrets),
  });
}

function nameFor(context: DeployContext) {
  return resourceName(context.app, context.environment, context.role, NAME_LENGTH);
}

function appBase(context: DeployContext) {
  const directory = context.source.directory.replace(/^\.?\/+|\/+$/g, "");
  return directory === "." ? "" : directory;
}

/** Config vars sent to Heroku: the runtime variables plus APP_BASE for monorepo folders. */
function configVars(context: DeployContext) {
  const base = appBase(context);
  return { ...context.variables, ...(base ? { APP_BASE: base } : {}) };
}

function buildpacks(context: DeployContext) {
  if (!appBase(context)) return undefined;
  const runtime = context.source.runtime ?? "node";
  const language = BUILDPACKS[runtime];
  if (!language) throw new Error(`Heroku: unsupported runtime "${runtime}"`);
  return [{ url: MONOREPO_BUILDPACK }, { url: language }];
}

/** Read-only: find the app by name and describe what apply will do. */
async function plan(context: DeployContext): Promise<DeployPlan> {
  assertRole(context);
  const api = client(context);
  const name = nameFor(context);
  const app = await api.find<HerokuApp>(`/apps/${name}`);
  const variables = Object.keys(context.variables).length;
  const build: PlannedAction = { action: "deploy", resource: name, detail: `build ${context.source.repository ?? "?"}@${context.source.branch} from its GitHub tarball` };
  const actions: PlannedAction[] = app
    ? [{ action: "update", resource: name, detail: `set ${variables} config vars` }, build]
    : [{ action: "create", resource: name, detail: `create app in ${context.settings.region ?? "us"}${context.credentials.HEROKU_TEAM ? " (team)" : ""} with ${variables} config vars` }, build];
  return {
    provider: "heroku",
    role: context.role,
    environment: context.environment,
    actions,
    state: app ? { appId: app.id } : {},
  };
}

/**
 * Temporary download URL of the GitHub tarball for `repository@branch`. GitHub answers 302 with a
 * `Location` (for private repositories it embeds a short-lived token, so it is treated as a secret).
 */
async function tarballUrl(context: DeployContext) {
  const repository = context.source.repository;
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw new Error("Heroku: source.repository must be a GitHub repository in the form owner/name");
  const ref = context.source.branch.split("/").map(encodeURIComponent).join("/");
  const path = `/repos/${repository}/tarball/${ref}`;
  const token = context.credentials.GITHUB_TOKEN;
  let response: Response;
  try {
    response = await context.fetch(GITHUB_API_URL + path, {
      method: "GET",
      redirect: "manual",
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new ProviderError("GitHub", 0, redact(`GET ${path} failed: ${(error as Error).message}`, secrets(context)));
  }
  const location = response.headers.get("location");
  if (response.status >= 300 && response.status < 400 && location) return location;
  const hint = response.status === 404 ? " (private repository? set GITHUB_TOKEN with contents:read)" : "";
  throw new ProviderError("GitHub", response.status, redact(`GET ${path} → ${response.status}${hint}`, secrets(context)));
}

/** Create the app when missing, set config vars and start a build of the branch. Safe to re-run. */
async function apply(context: DeployContext, planned: DeployPlan): Promise<DeployResult> {
  assertRole(context);
  const api = client(context);
  const name = nameFor(context);
  const packs = buildpacks(context);
  // Resolve the source first so a bad repository or token fails before any remote change.
  const sourceUrl = await tarballUrl(context);
  let app = planned.state?.appId ? await api.get<HerokuApp>(`/apps/${planned.state.appId}`) : await api.find<HerokuApp>(`/apps/${name}`);
  if (!app) {
    const region = String(context.settings.region ?? "us");
    const team = context.credentials.HEROKU_TEAM;
    context.log(`Heroku: creating app ${name}${team ? " in team" : ""}`);
    app = team ? await api.post<HerokuApp>("/teams/apps", { name, region, team }) : await api.post<HerokuApp>("/apps", { name, region });
  }
  await api.patch(`/apps/${app.id}/config-vars`, configVars(context));
  const builder = client(context, {}, [sourceUrl]);
  const build = await builder.post<HerokuBuild>(`/apps/${app.id}/builds`, {
    source_blob: { url: sourceUrl, version: context.source.branch },
    ...(packs ? { buildpacks: packs } : {}),
  });
  context.log(`Heroku: build ${build.id} ${build.status}`);
  return {
    provider: "heroku",
    role: context.role,
    url: app.web_url ?? undefined,
    resources: [
      { kind: "app", id: app.id, name: app.name },
      { kind: "build", id: build.id, name: `${app.name} ${context.source.branch}` },
    ],
  };
}

/** Map the latest build of the app (newest first by started_at) to the shared status vocabulary. */
async function status(context: DeployContext): Promise<DeployStatus> {
  assertRole(context);
  const api = client(context);
  const app = await api.find<HerokuApp>(`/apps/${nameFor(context)}`);
  if (!app) return { state: "missing" };
  const url = app.web_url ?? undefined;
  const ranged = client(context, { range: "started_at ..; order=desc,max=1;" });
  const [latest] = (await ranged.get<HerokuBuild[]>(`/apps/${app.id}/builds`)) ?? [];
  if (!latest) return { state: "unknown", url, detail: "no builds yet" };
  if (latest.status === "succeeded") return { state: "live", url };
  if (latest.status === "pending") return { state: "deploying", url, detail: "build pending" };
  if (latest.status === "failed") return { state: "failed", url, detail: "build failed" };
  return { state: "unknown", url, detail: String(latest.status) };
}

export const provider: DeployProvider = {
  id: "heroku",
  name: "Heroku",
  roles: ROLES,
  website: "https://www.heroku.com",
  credentials: [
    { key: "HEROKU_API_KEY", label: "Heroku API key (or an authorization token)", url: "https://dashboard.heroku.com/account/applications" },
    { key: "HEROKU_TEAM", label: "Team name (apps are personal when absent)", optional: true },
    { key: "GITHUB_TOKEN", label: "GitHub token with contents:read, for private repositories", url: "https://github.com/settings/personal-access-tokens", optional: true },
  ],
  settings: [{ key: "region", label: "Region", type: "string", default: "us", options: REGIONS, help: "Common Runtime region, fixed at creation." }],
  notes: "Builds from the GitHub tarball of the branch; the app needs a Procfile (or a buildpack default such as npm start). Monorepo folders use the community monorepo buildpack. Eco dynos sleep after 30 minutes without traffic.",
  plan,
  apply,
  status,
};

export default provider;
