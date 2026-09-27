// Subjects: deploy (@gsalgadotoledo/rt-app-deploy: registry, validation, credentials, redaction,
// orchestration and the provider API client) and deployments (@gsalgadotoledo/rt-app-deployments:
// project files, local credentials, GitHub sync, plan/apply/status, the /__dev/deploy handler and
// the rta deploy / rta github commands).
//
// Providers are FAKES built from data (init.providers), so every language builds the same provider
// from the same description and nothing reaches the network. The API client runs over a fake
// fetch built from init.api.routes. git and gh go through a fake runner (deployments). See
// spec/contracts/deploy*.contract.yaml and deployments*.contract.yaml for the data formats.
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ENVIRONMENTS,
  PUBLIC_VARIABLE,
  ProviderError,
  ProviderRegistry,
  ROLES,
  ROLE_LABELS,
  ROLE_ORDER,
  applyEnvironment,
  createApi,
  planEnvironment,
  redact,
  resolveCredentials,
  resourceName,
  secretValues,
  settingsFor,
  validateDeploySettings,
  variablesFor,
} from "@gsalgadotoledo/rt-app-deploy";
import {
  BRANCHES,
  RUNTIME_SECRETS,
  applyDeployment,
  awsProvider,
  connectGithub,
  credentialStatus,
  deploymentStatus,
  githubRepository,
  planDeployment,
  readCredentials,
  readDeploySettings,
  runtimeVariables,
  saveCredential,
  saveDeploySettings,
  sourceFor,
  syncGithub,
} from "@gsalgadotoledo/rt-app-deployments";
import { handleDeployRequest } from "@gsalgadotoledo/rt-app-deployments/server";
import { deployCommand, githubCommand, withCiSecrets } from "@gsalgadotoledo/rt-app-deployments/cli";

// Wire null means "not given": optional TypeScript arguments receive undefined, not null.
const given = (value) => (value === null ? undefined : value);

// ---------------------------------------------------------------------------
// Fake provider from data
// ---------------------------------------------------------------------------

/**
 * spec.fail[method] = message | {message, status?, roles?}. The message is redacted with every
 * secret of the call (like createApi does for real providers); with a status the provider throws
 * ProviderError(id, status, message) ("<id>: <message>"), otherwise Error(message).
 */
function failure(spec, method, context) {
  const raw = spec.fail?.[method];
  if (raw == null) return;
  const f = typeof raw === "string" ? { message: raw } : raw;
  if (f.roles && !f.roles.includes(context.role)) return;
  const message = redact(f.message, secretValues(context));
  throw f.status == null ? new Error(message) : new ProviderError(spec.id, f.status, message);
}

/**
 * A provider described by data: {id, name?, roles, website?, credentials?, settings?, notes?,
 * actions?, state?, urls?, outputs?, statuses?, fail?}. Every call is recorded in `calls`
 * (with the context it received) and logs "<id> <method> <role>" through context.log.
 */
export function fakeProvider(spec, calls) {
  const record = (call, context) =>
    calls.push({
      call,
      provider: spec.id,
      app: context.app,
      environment: context.environment,
      role: context.role,
      settings: { ...context.settings },
      credentials: { ...context.credentials },
      variables: { ...context.variables },
      source: context.source,
    });
  return {
    id: spec.id,
    name: spec.name ?? spec.id,
    roles: spec.roles,
    website: spec.website ?? `https://${spec.id}.example`,
    credentials: spec.credentials ?? [],
    settings: given(spec.settings),
    notes: given(spec.notes),
    async plan(context) {
      record("plan", context);
      context.log(`${spec.id} plan ${context.role}`);
      failure(spec, "plan", context);
      const resource = resourceName(context.app, context.environment, context.role);
      return {
        provider: spec.id,
        role: context.role,
        environment: context.environment,
        actions: (spec.actions ?? [{ action: "create", detail: "new" }]).map((a) => ({ action: a.action, resource, detail: a.detail })),
        ...(spec.state != null ? { state: spec.state } : {}),
      };
    },
    async apply(context) {
      record("apply", context);
      context.log(`${spec.id} apply ${context.role}`);
      failure(spec, "apply", context);
      const url = spec.urls?.[context.role];
      const outputs = spec.outputs?.[context.role];
      return {
        provider: spec.id,
        role: context.role,
        ...(url != null ? { url } : {}),
        ...(outputs != null ? { outputs } : {}),
        resources: [{ kind: "service", id: `${spec.id}-${context.role}`, name: resourceName(context.app, context.environment, context.role) }],
      };
    },
    async status(context) {
      record("status", context);
      failure(spec, "status", context);
      return spec.statuses?.[context.role] ?? { state: "live" };
    },
  };
}

// ---------------------------------------------------------------------------
// Fake fetch from data (API client)
// ---------------------------------------------------------------------------

/**
 * routes: {"METHOD url-prefix": response | [response, …]}; the longest matching prefix wins, a
 * list is consumed one response per call (the last one repeats). response: {status? = 200,
 * body? (string: raw text; else JSON), headers?, throw? (network error message)}. An unmatched
 * request throws "Unexpected request: METHOD url" (a network error for the client).
 */
function routedFetch(routes, fetches) {
  const used = {};
  return async (url, init = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    fetches.push({ method, url: String(url), headers, body: init.body == null ? null : JSON.parse(init.body) });
    const key = Object.keys(routes ?? {})
      .filter((route) => {
        const [m, prefix] = route.split(" ");
        return m === method && String(url).startsWith(prefix);
      })
      .sort((a, b) => b.length - a.length)[0];
    if (!key) throw new Error(`Unexpected request: ${method} ${url}`);
    let response = routes[key];
    if (Array.isArray(response)) {
      const index = used[key] ?? 0;
      used[key] = index + 1;
      response = response[Math.min(index, response.length - 1)];
    }
    if (response.throw != null) throw new Error(response.throw);
    const status = response.status ?? 200;
    const text = response.body == null ? "" : typeof response.body === "string" ? response.body : JSON.stringify(response.body);
    return new Response(status === 204 ? null : text, { status, headers: response.headers ?? {} });
  };
}

// ---------------------------------------------------------------------------
// Subject: deploy
// ---------------------------------------------------------------------------

async function deploySubject(init) {
  init = init ?? {};
  const calls = [];
  const logs = [];
  const fetches = [];
  const sleeps = [];
  const registry = new ProviderRegistry();
  for (const spec of init.providers ?? []) registry.register(fakeProvider(spec, calls));
  const api = init.api ?? {};
  const client = createApi({
    provider: api.provider ?? "Example",
    baseUrl: api.baseUrl ?? "https://api.example/v1",
    headers: api.headers ?? {},
    secrets: api.secrets ?? [],
    retries: given(api.retries),
    fetch: routedFetch(api.routes, fetches),
    sleep: async (ms) => void sleeps.push(ms),
  });

  /** OrchestratorOptions from data; sources[role] or {branch: "main", directory: "."}. */
  const orchestration = (options) => ({
    registry,
    settings: options.settings ?? { environments: {} },
    app: options.app ?? "shop",
    environment: options.environment,
    env: options.env ?? {},
    variables: given(options.variables),
    roles: given(options.roles),
    source: (role) => options.sources?.[role] ?? { branch: "main", directory: "." },
    log: (line) => logs.push(line),
  });

  return {
    register: (spec) => (registry.register(fakeProvider(spec, calls)), null),
    ids: () => registry.list().map((p) => p.id),
    catalog: () => registry.catalog(),
    get: (id) => registry.catalog().find((p) => p.id === registry.get(id).id),
    validate: (input) => validateDeploySettings(given(input), registry),
    resolveCredentials: (id, env) => resolveCredentials(registry.get(id), env ?? {}),
    settingsFor: (id, target) => settingsFor(registry.get(id), target),
    resourceName: (app, environment, role, max) => resourceName(app, environment, role, given(max)),
    variablesFor: (role, variables) => variablesFor(role, variables ?? {}),
    publicVariable: (name) => PUBLIC_VARIABLE.test(name),
    secretValues: (context) => secretValues({ credentials: context?.credentials ?? {}, variables: context?.variables ?? {} }),
    redact: (text, secrets) => redact(text, secrets ?? []),
    constants: () => ({ roles: ROLES, environments: ENVIRONMENTS, roleLabels: ROLE_LABELS, roleOrder: ROLE_ORDER }),
    plan: (options) => planEnvironment(orchestration(options ?? {})),
    apply: (options) => applyEnvironment(orchestration(options ?? {})),
    providerError: (provider, status, message) => {
      const error = new ProviderError(provider, status, message);
      return { provider: error.provider, status: error.status, message: error.message };
    },
    // createApi: request(method, path, body?) with method get|find|post|put|patch|delete.
    // A ProviderError becomes the value {error: {provider, status, message}} (status 0 included).
    request: async (method, path, body) => {
      if (!["get", "find", "post", "put", "patch", "delete"].includes(method)) throw new TypeError("Unknown client method " + method);
      try {
        const value = await (body == null ? client[method](path) : client[method](path, body));
        return { value: value ?? null };
      } catch (error) {
        if (error instanceof ProviderError) return { error: { provider: error.provider, status: error.status, message: error.message } };
        throw error;
      }
    },
    fetches: () => fetches,
    sleeps: () => sleeps,
    calls: () => calls,
    logs: () => logs,
  };
}

// ---------------------------------------------------------------------------
// Subject: deployments
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS = { version: 1, project: { name: "shop" } };
const DEFAULT_ORIGIN = "git@github.com:acme/shop.git";

const missing = async (read) => {
  try {
    return await read();
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};

async function deploymentsSubject(init) {
  init = init ?? {};
  const root = await mkdtemp(join(tmpdir(), "rt-contract-deployments-"));
  const settingsFile = join(root, "rt-app.settings.json");
  if (typeof init.settingsText === "string") await writeFile(settingsFile, init.settingsText);
  else if (!init.noSettings) await writeFile(settingsFile, JSON.stringify(init.settings ?? DEFAULT_SETTINGS, null, 2) + "\n");
  if (init.credentials != null || typeof init.credentialsText === "string") {
    await mkdir(join(root, ".rt-app"), { recursive: true });
    const text = typeof init.credentialsText === "string" ? init.credentialsText : JSON.stringify(init.credentials, null, 2) + "\n";
    await writeFile(join(root, ".rt-app/credentials.json"), text, { mode: 0o600 });
  }

  const calls = [];
  const logs = [];
  const runs = [];
  let output = [];
  let origin = init.origin ?? DEFAULT_ORIGIN;
  const env = init.env ?? {};
  const registry = new ProviderRegistry().register(awsProvider);
  for (const spec of init.providers ?? []) registry.register(fakeProvider(spec, calls));

  /** Fake git/gh: records {command, args, input, cwd}; secrets must only arrive through input. */
  const run = (command, args, options = {}) => {
    runs.push({ command, args, input: options.input ?? null, cwd: options.cwd === root ? "." : options.cwd ?? null });
    const key = command + " " + args.join(" ");
    if (init.failOn && key.includes(init.failOn)) return { status: 1, stdout: "", stderr: "boom\n" };
    if (key === "git remote get-url origin")
      return origin ? { status: 0, stdout: origin + "\n", stderr: "" } : { status: 2, stdout: "", stderr: "error: No such remote 'origin'\n" };
    if (key === "gh auth status") return { status: init.ghAuthenticated === false ? 1 : 0, stdout: "", stderr: "" };
    if (command === "gh" && args[0] === "repo") origin = `https://github.com/${args[2] && !args[2].startsWith("--") ? args[2] : "acme/shop"}.git`;
    return { status: 0, stdout: "", stderr: "" };
  };

  const passwordVerifier = init.passwordVerifier === false ? undefined : async (password) => `fake-verifier:${password.length}`;
  const log = (line) => logs.push(line);
  const runOptions = (options) => ({
    root,
    environment: options?.environment,
    roles: given(options?.roles),
    env: options?.env ?? env,
    registry,
    run,
    log,
  });
  const path = (name) => join(root, name ?? "rt-app.settings.json");
  const io = (stdin) => ({
    root,
    env,
    registry,
    run,
    out: (line) => output.push(line),
    stdin: stdin == null ? undefined : async () => stdin,
  });

  return {
    // Project layout and runtime variables.
    sourceFor: (role, repository, branch) => sourceFor(role, given(repository), branch),
    runtimeVariables: (environment, variables) => runtimeVariables(environment, variables ?? {}),
    constants: () => ({ branches: BRANCHES, runtimeSecrets: RUNTIME_SECRETS }),
    aws: (call, context) => awsProvider[call](context),
    // rt-app.settings.json → deploy.
    readDeploySettings: () => readDeploySettings(root, registry),
    saveDeploySettings: (deploy) => saveDeploySettings(root, registry, given(deploy)),
    // .rt-app/credentials.json.
    readCredentials: () => readCredentials(root),
    saveCredential: async (environment, key, value) => (await saveCredential(root, environment, key, value), null),
    credentialStatus: async (variables) => {
      const { deploy } = await readDeploySettings(root, registry);
      return credentialStatus(root, registry, deploy, variables ?? {});
    },
    // GitHub through the fake runner.
    githubRepository: () => githubRepository(root, run) ?? null,
    syncGithub: (options) => syncGithub(root, { run, environments: given(options?.environments), secrets: given(options?.secrets) }),
    connectGithub: async (options) => connectGithub(root, { run, visibility: given(options?.visibility), name: given(options?.name) }),
    // Plan / apply / status of an environment.
    planDeployment: (options) => planDeployment(runOptions(options)),
    applyDeployment: (options) => applyDeployment(runOptions(options)),
    deploymentStatus: (options) => deploymentStatus(runOptions(options)),
    // The /__dev/deploy handler.
    handle: (method, requestPath, body, query) =>
      handleDeployRequest({ method, path: requestPath, body: body ?? {}, query: query ?? {} }, { root, env, run, registry, passwordVerifier }),
    // rta deploy / rta github: the printed lines; output() keeps the lines of a failed command.
    deployCommand: async (argv, stdin) => {
      output = [];
      await deployCommand(argv ?? [], io(stdin));
      return output;
    },
    githubCommand: async (argv) => {
      output = [];
      await githubCommand(argv ?? [], io(null));
      return output;
    },
    withCiSecrets: (variables) => withCiSecrets(variables ?? {}),
    output: () => output,
    // Files of the project directory (names relative to it).
    text: (name) => missing(() => readFile(path(name), "utf8")),
    writeText: async (name, text) => (await writeFile(path(name), text), null),
    remove: async (name) => (await unlink(path(name)), null),
    mode: (name) => missing(async () => ((await stat(path(name))).mode & 0o777).toString(8)),
    chmod: async (name, mode) => (await chmod(path(name), parseInt(mode, 8)), null),
    files: (dir) => missing(async () => (await readdir(dir == null ? root : join(root, dir))).sort()),
    // Helpers.
    runs: () => runs,
    calls: () => calls,
    logs: () => logs,
    setOrigin: (value) => ((origin = value ?? ""), null),
    close: () => rm(root, { recursive: true, force: true }),
  };
}

export const subjects = { deploy: deploySubject, deployments: deploymentsSubject };
