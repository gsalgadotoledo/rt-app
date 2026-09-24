import { randomBytes } from "node:crypto";
import { ENVIRONMENTS, ROLES, ROLE_LABELS, type DeployEnvironment } from "@gsalgadotoledo/rt-app-deploy";
import {
  BRANCHES,
  RUNTIME_SECRETS,
  applyDeployment,
  credentialStatus,
  deploymentStatus,
  githubRepository,
  loadRegistry,
  planDeployment,
  readCredentials,
  readDeploySettings,
  saveCredential,
  saveDeploySettings,
  syncGithub,
  type Runner,
} from "./index.js";

/**
 * Local admin API for the Deployments page (`/__dev/deploy…`). The starter server calls it only
 * on loopback, for the application owner. Responses never contain credential values: the page
 * sees which keys are present, plans, results and URLs.
 */
export interface DeployRequest {
  method: string;
  path: string;
  body: any;
  query: Record<string, string>;
}

export interface DeployServerOptions {
  root: string;
  env?: Record<string, string | undefined>;
  run?: Runner;
  fetch?: typeof fetch;
  registry?: Awaited<ReturnType<typeof loadRegistry>>;
  /** Hashes an admin password into ADMIN_PASSWORD_VERIFIER (from the admin package). */
  passwordVerifier?: (password: string) => Promise<string>;
}

const environmentOf = (value: unknown) => {
  if (!ENVIRONMENTS.includes(value as DeployEnvironment)) throw Object.assign(new Error("Unknown environment"), { status: 400 });
  return value as DeployEnvironment;
};

/** Handle one request; returns `{status, body}`. Unknown paths return 404. */
export async function handleDeployRequest(request: DeployRequest, options: DeployServerOptions) {
  const registry = options.registry ?? (await loadRegistry());
  const env = options.env ?? {};
  const base = { root: options.root, env, registry, run: options.run, fetch: options.fetch };
  try {
    const { method, path, body } = request;
    if (method === "GET" && path === "/__dev/deploy") {
      const { deploy } = await readDeploySettings(options.root, registry);
      return {
        status: 200,
        body: {
          providers: registry.catalog(),
          roles: ROLES.map((id) => ({ id, label: ROLE_LABELS[id] })),
          environments: ENVIRONMENTS.map((id) => ({ id, branch: BRANCHES[id] })),
          runtimeSecrets: RUNTIME_SECRETS,
          deploy,
          credentials: await credentialStatus(options.root, registry, deploy, {}),
          runtime: await runtimeSecretStatus(options.root),
          repository: githubRepository(options.root, options.run) ?? null,
        },
      };
    }
    if (method === "PUT" && path === "/__dev/deploy") {
      return { status: 200, body: { deploy: await saveDeploySettings(options.root, registry, body?.deploy) } };
    }
    if (method === "PUT" && path === "/__dev/deploy/credentials") {
      const environment = environmentOf(body?.environment);
      await saveCredential(options.root, environment, String(body?.key ?? ""), String(body?.value ?? ""));
      return { status: 200, body: { ok: true } };
    }
    if (method === "POST" && path === "/__dev/deploy/generate") {
      // Generated secrets for an environment: JWT signing key, or the admin password verifier.
      const environment = environmentOf(body?.environment);
      if (body?.key === "JWT_SECRET") await saveCredential(options.root, environment, "JWT_SECRET", randomBytes(48).toString("hex"));
      else if (body?.key === "ADMIN_PASSWORD_VERIFIER") {
        const password = String(body?.password ?? "");
        if (password.length < 12 || password.length > 128) throw Object.assign(new Error("The admin password needs 12 to 128 characters"), { status: 400 });
        if (!options.passwordVerifier) throw new Error("Password hashing is not available");
        await saveCredential(options.root, environment, "ADMIN_PASSWORD_VERIFIER", await options.passwordVerifier(password));
      } else throw Object.assign(new Error("Only JWT_SECRET and ADMIN_PASSWORD_VERIFIER can be generated"), { status: 400 });
      return { status: 200, body: { ok: true } };
    }
    if (method === "POST" && path === "/__dev/deploy/plan") {
      return { status: 200, body: { plans: await planDeployment({ ...base, environment: environmentOf(body?.environment) }) } };
    }
    if (method === "POST" && path === "/__dev/deploy/apply") {
      const { results } = await applyDeployment({ ...base, environment: environmentOf(body?.environment) });
      // Outputs (DATABASE_URL…) are secrets: only URLs and resource ids leave the server.
      return { status: 200, body: { results: results.map(({ provider, role, url, resources }) => ({ provider, role, url, resources })) } };
    }
    if (method === "GET" && path === "/__dev/deploy/status") {
      return { status: 200, body: { statuses: await deploymentStatus({ ...base, environment: environmentOf(request.query.environment) }) } };
    }
    if (method === "POST" && path === "/__dev/deploy/github") {
      const environments = body?.environment ? [environmentOf(body.environment)] : undefined;
      return { status: 200, body: await syncGithub(options.root, { run: options.run, environments }) };
    }
    return { status: 404, body: { error: "Not found" } };
  } catch (error: any) {
    return { status: error.status ?? 400, body: { error: error.message } };
  }
}

/** Which runtime secrets each environment has locally (names only). */
async function runtimeSecretStatus(root: string) {
  const local = await readCredentials(root);
  return Object.fromEntries(ENVIRONMENTS.map((environment) => [environment, RUNTIME_SECRETS.map((key) => ({ key, present: Boolean(local[environment]?.[key]) }))]));
}
