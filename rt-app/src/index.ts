import { Choice, type ChoiceProvider } from "@gsalgadotoledo/rt-app-choice";
import { Queue, type QueueAdapter } from "@gsalgadotoledo/rt-app-queue";
import { createIdempotency } from "@gsalgadotoledo/rt-app-idempotency";
import {
  Cache,
  MemoryCache,
  type CacheAdapter,
} from "@gsalgadotoledo/rt-app-cache";
import { FeatureFlags } from "@gsalgadotoledo/rt-app-feature-flags";
import { Visits } from "@gsalgadotoledo/rt-app-visits";
import { HealthChecks, type HealthProbe } from "@gsalgadotoledo/rt-app-health";
import { Analytics } from "@gsalgadotoledo/rt-app-analytics";
import {
  Subscriptions,
  LocalBilling,
  type BillingProvider,
} from "@gsalgadotoledo/rt-app-subscriptions";
import {
  StripeBilling,
  StripeCatalog,
} from "@gsalgadotoledo/rt-app-subscriptions-stripe";
import {
  Observer,
  ObserverStore,
  observerFeature,
  type ObserverOutput,
} from "@gsalgadotoledo/rt-app-observer";
import { ConsoleOutput } from "@gsalgadotoledo/rt-app-observer-console";
import {
  EmailOutput,
  LocalEmailOutput,
} from "@gsalgadotoledo/rt-app-observer-email";
import { SmsOutput } from "@gsalgadotoledo/rt-app-observer-sms";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { JsonStore } from "@gsalgadotoledo/rt-app-json";
import { SlackOutput } from "@gsalgadotoledo/rt-app-observer-slack";
import { DatadogOutput } from "@gsalgadotoledo/rt-app-observer-datadog";
import { SentryOutput } from "@gsalgadotoledo/rt-app-observer-sentry";
import {
  CloudWatchOutput,
  CloudWatchLogReader,
} from "@gsalgadotoledo/rt-app-observer-cloudwatch";
function observerDestinations(local = false): ObserverOutput[] {
  const outputs: ObserverOutput[] = [];
  if (process.env.OBSERVER_EMAIL_TO)
    outputs.push({
      handler:
        local || process.env.OBSERVER_EMAIL_TRANSPORT === "local"
          ? new LocalEmailOutput(
              process.env.OBSERVER_EMAIL_FROM ?? "observer@localhost.test",
              process.env.OBSERVER_EMAIL_TO,
              Number(process.env.RT_APP_MAIL_SMTP_PORT ?? 1025),
            )
          : new EmailOutput(
              process.env.OBSERVER_EMAIL_FROM ?? "",
              process.env.OBSERVER_EMAIL_TO,
            ),
      levels: ["error"],
      categories: ["payment", "payments", "purchase", "purchases"],
      maxPerMinute: 1,
    });
  if (!local && process.env.OBSERVER_SLACK_WEBHOOK)
    outputs.push({
      handler: new SlackOutput(process.env.OBSERVER_SLACK_WEBHOOK),
      levels: ["error"],
      maxPerMinute: 5,
    });
  if (!local && process.env.OBSERVER_DATADOG_API_KEY)
    outputs.push({
      handler: new DatadogOutput(
        process.env.OBSERVER_DATADOG_API_KEY,
        process.env.OBSERVER_DATADOG_SITE,
      ),
      levels: ["info", "warn", "error"],
    });
  if (!local && process.env.OBSERVER_SENTRY_DSN)
    outputs.push({
      handler: new SentryOutput(process.env.OBSERVER_SENTRY_DSN),
      levels: ["error"],
      maxPerMinute: 60,
    });
  if (!local && process.env.OBSERVER_SMS_TO)
    outputs.push({
      handler: new SmsOutput(process.env.OBSERVER_SMS_TO),
      levels: ["error"],
      maxPerMinute: 1,
    });
  if (!local && process.env.OBSERVER_LOG_GROUP)
    outputs.push({
      handler: new CloudWatchOutput(
        process.env.OBSERVER_LOG_GROUP,
        process.env.OBSERVER_LOG_STREAM ?? "",
      ),
      maxPerMinute: 600,
    });
  return outputs;
}
import { CognitoIdentity } from "@gsalgadotoledo/rt-app-auth-cognito";
import type { IdentityProvider } from "@gsalgadotoledo/rt-app-auth";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { AdminIdentity } from "@gsalgadotoledo/rt-app-myadmin/backend";
import { NoSQLRegistry } from "@gsalgadotoledo/rt-app-nosql";
import {
  InfraRegistry,
  Infra,
  SimulatedInfraDriver,
  type InfraDriver,
} from "@gsalgadotoledo/rt-app-infra";
import { AwsMonitor, AwsInfraDriver } from "@gsalgadotoledo/rt-app-aws";
import {
  type Store,
  type Feature,
  type Endpoint,
  type Request,
  HttpError,
  migrate,
} from "@gsalgadotoledo/rt-app-contracts";
import { Users } from "@gsalgadotoledo/rt-app-users";
import { Auth, type Mailer, SesMailer } from "@gsalgadotoledo/rt-app-auth";
import { JwtTokens } from "@gsalgadotoledo/rt-app-jwt";
import { ACL } from "@gsalgadotoledo/rt-app-acl";
import { tasksFeature } from "@gsalgadotoledo/rt-app-tasks";
import { contentFeature } from "@gsalgadotoledo/rt-app-content";
import { DynamoStore } from "@gsalgadotoledo/rt-app-dynamodb";
export function createApplication(options: {
  cacheAdapter?: CacheAdapter;
  choiceProvider?: ChoiceProvider;
  queueAdapter?: QueueAdapter;
  healthProbes?: HealthProbe[];
  visitPages?: string[];
  billingProvider?: BillingProvider;
  /** Explicit outputs replace all defaults; [] means no capture or delivery. */
  observerOutputs?: ObserverOutput[];
  observerStore?: Store;
  identityProvider?: IdentityProvider;
  adminPasswordVerifier?: string;
  localAdminAccess?: boolean;
  modules?: string[];
  features?: Feature[];
  featureFactories?: Array<(store: Store) => Feature>;
  store: Store;
  mailer: Mailer;
  secret: string;
  tasks?: boolean;
  infraDriver?: InfraDriver;
  managedByTerraform?: boolean;
  awsConnected?: boolean;
}) {
  const billingMode =
    process.env.SUBSCRIPTIONS_PROVIDER ??
    (options.localAdminAccess ? "local" : "none");
  if (!["local", "none", "stripe"].includes(billingMode))
    throw new Error("Unknown subscriptions provider");
  if (
    (billingMode === "local" || options.billingProvider?.mode === "local") &&
    !options.localAdminAccess
  )
    throw new Error("Simulated billing requires explicit local development");
  const billing =
    options.billingProvider ??
    (billingMode === "stripe"
      ? new StripeBilling(
          process.env.STRIPE_SECRET_KEY ?? "",
          process.env.STRIPE_WEBHOOK_SECRET ?? "",
          process.env.STRIPE_PUBLISHABLE_KEY ?? "",
        )
      : billingMode === "local"
        ? new LocalBilling(options.store)
        : undefined);
  const subscriptions = new Subscriptions(
    options.store,
    billing,
    options.mailer.send?.bind(options.mailer),
    undefined,
    (secret) =>
      new StripeCatalog(secret ?? process.env.STRIPE_SECRET_KEY ?? ""),
  );
  const localObserverStore =
    options.store instanceof JsonStore
      ? new JsonStore(join(dirname(options.store.file), "observer.json"))
      : options.store;
  const observerStorage = new ObserverStore(
    options.observerStore ?? localObserverStore,
  );
  const observer = new Observer(
    options.observerOutputs ?? [
      { handler: observerStorage },
      { handler: new ConsoleOutput(), levels: ["info", "warn", "error"] },
      ...observerDestinations(options.localAdminAccess),
    ],
  );
  const observerLogs =
    !options.localAdminAccess && process.env.OBSERVER_LOG_GROUP
      ? new CloudWatchLogReader(process.env.OBSERVER_LOG_GROUP)
      : observerStorage;
  const choice = options.choiceProvider ? new Choice(options.choiceProvider) : undefined;
  const queue = options.queueAdapter ? new Queue(options.queueAdapter) : undefined;
  const idempotency = createIdempotency(options.store);
  const cache = new Cache(options.cacheAdapter ?? new MemoryCache());
  const flags = new FeatureFlags(options.store);
  const visits = new Visits(options.store, options.secret, options.visitPages);
  const health = new HealthChecks(
    options.healthProbes ?? [
      {
        id: "database",
        check: async () => {
          await options.store.get("SCHEMA", "users");
        },
      },
    ],
  );
  const analytics = new Analytics(observer);
  const users = new Users(options.store, options.identityProvider),
    tokens = new JwtTokens(options.secret),
    auth = new Auth(
      users,
      tokens,
      options.mailer,
      options.secret,
      options.identityProvider,
    );
  let endpoints: Endpoint[] = [];
  const acl = new ACL(options.store, () => endpoints);
  const registered: Feature[] = [
    flags.feature(),
    visits.feature(),
    health.feature(),
    subscriptions.feature(),
    observerFeature(observer, observerStorage, observerLogs),
    contentFeature(options.store),
    new Infra(
      options.store,
      options.infraDriver ?? new SimulatedInfraDriver(),
      options.managedByTerraform,
    ).feature(),
    new AwsMonitor(undefined, options.store).feature(),
    users.feature(),
    auth.feature(),
    acl.feature(),
    ...(options.tasks === false ? [] : [tasksFeature(options.store)]),
    ...(options.featureFactories ?? []).map((factory) =>
      factory(options.store),
    ),
    ...(choice ? [choice.feature()] : []),
    ...(queue ? [queue.feature()] : []),
    ...(options.features ?? []),
  ];
  if (new Set(registered.map((f) => f.id)).size !== registered.length)
    throw new Error("Duplicate module id");
  const requested = options.modules ?? registered.map((f) => f.id);
  for (const id of requested)
    if (
      !registered.some((f) => f.id === id) &&
      !(id === "tasks" && options.tasks === false)
    )
      throw new Error("Unknown module: " + id);
  for (const id of ["content", "users", "auth", "acl", "infra"])
    if (!requested.includes(id)) throw new Error("Required module: " + id);
  const features = registered.filter(
    (f) =>
      requested.includes(f.id) ||
      f.id === "observer" ||
      f.id === "subscriptions" ||
      (f.id === "aws-monitor" && requested.includes("infra")),
  );
  const admin = new AdminIdentity(
    options.adminPasswordVerifier,
    options.secret,
    options.localAdminAccess,
  );
  const appEndpoints = features.flatMap((f) => f.endpoints);
  const adminEndpoints = appEndpoints
    .filter((e) => e.access === "permission" || e.access === "owner")
    .map((e) => ({ ...e, path: "/admin/app" + e.path }));
  endpoints = [
    ...appEndpoints.filter(
      (e) =>
        !(
          (e.path.startsWith("/feature-flags") ||
            e.path.startsWith("/visits") ||
            e.path === "/health/report") &&
          e.access === "owner"
        ) &&
        !e.path.startsWith("/infra") &&
        !e.path.startsWith("/aws/") &&
        e.path !== "/observer/report" &&
        e.path !== "/observer/logs" &&
        !e.path.startsWith("/subscriptions/admin/"),
    ),
    ...adminEndpoints,
    ...admin.features.flatMap((f) => f.endpoints),
  ];

  endpoints.push({
    method: "GET",
    path: "/app/features",
    resource: "app.features",
    access: "authenticated",
    handle: async () => features.map((f) => f.id),
  });
  endpoints.push({
    method: "GET",
    path: "/admin/modules",
    resource: "admin.modules",
    access: "authenticated",
    handle: async (c) =>
      [...admin.features, ...features]
        .filter(
          (f) =>
            f.admin &&
            (f.id !== "aws-monitor" || options.awsConnected === true) &&
            (!f.admin.ownerOnly || c.actor?.role === "owner") &&
            admin.acl.allows(c.actor, f.admin.resource),
        )
        .map((f) => ({ ...f.admin, module: f.id })),
  });
  endpoints.push({
    method: "GET",
    path: "/admin/features",
    resource: "admin.features",
    access: "authenticated",
    handle: async () => features.map((f) => f.id),
  });
  // Discover only explicitly published admin actions; never expose arbitrary methods.
  const tools = adminEndpoints
    .filter((e) => e.tool)
    .map((e) => ({
      ...e.tool!,
      method: e.method,
      path: e.path,
    }));
  if (
    tools.some(
      (t) => !/^[a-z][a-z0-9_]{1,100}$/.test(t.name) || !t.description.trim(),
    )
  )
    throw new Error("Invalid module tool metadata");
  if (new Set(tools.map((t) => t.name)).size !== tools.length)
    throw new Error("Duplicate module tool name");
  endpoints.push({
    method: "GET",
    path: "/admin/tools",
    resource: "admin.tools",
    access: "owner",
    handle: async () => tools,
  });

  const signatures = new Set<string>();
  for (const e of endpoints) {
    const key = e.method + " " + e.path;
    if (signatures.has(key)) throw new Error(`Duplicate endpoint ${key}`);
    signatures.add(key);
  }
  // Literal routes take precedence over parameter routes.
  endpoints.sort(
    (a, b) => Number(a.path.includes(":")) - Number(b.path.includes(":")),
  );
  async function dispatch(request: Request, telemetry: { path: string }) {
    try {
      let route: Endpoint | undefined,
        params: Record<string, string> = {};
      for (const endpoint of endpoints) {
        if (endpoint.method !== request.method) continue;
        const names: string[] = [];
        const pattern = endpoint.path
          .split("/")
          .map((part) =>
            part.startsWith(":")
              ? (names.push(part.slice(1)), "([^/]+)")
              : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          )
          .join("/");
        const match = request.path.match(new RegExp(`^${pattern}/?$`));
        if (match) {
          route = endpoint;
          try {
            params = Object.fromEntries(
              names.map((n, i) => [n, decodeURIComponent(match[i + 1])]),
            );
          } catch {
            throw new HttpError(400, "Invalid URL");
          }
          break;
        }
      }
      if (!route) throw new HttpError(404, "Endpoint not found");
      telemetry.path = route.path;
      const actor =
        route.access === "guest"
          ? undefined
          : await (route.path.startsWith("/admin/") ? admin.auth : auth).actor(
              request.headers.authorization,
            );
      (route.path.startsWith("/admin/") ? admin.acl : acl).check(route, actor);
      if (route.subscription) {
        if (!actor) throw new HttpError(401, "Authentication required");
        const key = request.headers["idempotency-key"];
        if (!key)
          throw new HttpError(
            400,
            "Idempotency-Key is required for this operation",
          );
        const receipt = await subscriptions.consume(
          actor.id,
          route.subscription.product,
          route.subscription.credits,
          key,
        );
        if (receipt.replayed)
          throw new HttpError(
            409,
            "This operation was already charged. Do not repeat its side effects.",
          );
      }
      const result = await route.handle({ request, actor, params });
      return { status: 200, body: result };
    } catch (error) {
      if (error instanceof HttpError)
        return { status: error.status, body: { error: error.message } };

      return { status: 500, body: { error: "Internal error" } };
    }
  }
  async function handle(request: Request) {
    return observer.withContext(
      {
        requestId: randomUUID(),
        category: request.path.includes("/subscriptions") ? "payments" : "http",
      },
      async () => {
        const start = performance.now(),
          telemetry = { path: "unmatched" };
        const result = await dispatch(request, telemetry);
        // Exclude the observer itself to prevent refresh/ingestion feedback loops.
        if (
          !request.path.startsWith("/observer/") &&
          !request.path.startsWith("/admin/app/observer/")
        )
          await observer.recordRequest({
            method: request.method,
            url: telemetry.path === "unmatched" ? "/unmatched" : telemetry.path,
            status: result.status,
            durationMs: performance.now() - start,
          });
        return result;
      },
    );
  }
  return {
    observer,
    idempotency,
    choice,
    queue,
    cache,
    flags,
    visits,
    health,
    analytics,
    subscriptions,
    handle,
    features,
    endpoints,
    users,
    auth,
    admin,
    migrate: async () => {
      await migrate(options.store, features);
    },
  };
}
export type ComponentOptions = Pick<
  Parameters<typeof createApplication>[0],
  | "choiceProvider"
  | "queueAdapter"
  | "cacheAdapter"
  | "healthProbes"
  | "visitPages"
  | "observerOutputs"
  | "observerStore"
>;

export function createProductionApplication(
  modules?: string[],
  featureFactories: Array<(store: Store) => Feature> = [],
  components: ComponentOptions = {},
) {
  const table = process.env.TABLE_NAME,
    secret = process.env.JWT_SECRET,
    from = process.env.MAIL_FROM;
  if (!table || !secret || !from || !process.env.ADMIN_PASSWORD_VERIFIER)
    throw new Error(
      "TABLE_NAME, ADMIN_PASSWORD_VERIFIER, JWT_SECRET and MAIL_FROM are required",
    );
  const authProvider = process.env.AUTH_PROVIDER ?? "local";
  if (!["local", "cognito"].includes(authProvider))
    throw new Error("Unknown AUTH_PROVIDER");
  return createApplication({
    ...components,
    featureFactories,
    identityProvider:
      authProvider === "cognito"
        ? new CognitoIdentity(
            process.env.COGNITO_USER_POOL_ID ?? "",
            process.env.COGNITO_CLIENT_ID ?? "",
            process.env.AWS_REGION ?? "us-east-1",
          )
        : undefined,
    modules,
    managedByTerraform: true,
    awsConnected: true,
    adminPasswordVerifier: process.env.ADMIN_PASSWORD_VERIFIER,
    store: new NoSQLRegistry()
      .register(
        "dynamodb",
        (config) => new DynamoStore(config.table, { region: config.region }),
      )
      .connect(process.env.NOSQL_PROVIDER ?? "dynamodb", {
        table,
        region: process.env.AWS_REGION ?? "us-east-1",
      }),
    infraDriver: new InfraRegistry()
      .register(
        "aws",
        () => new AwsInfraDriver(process.env.AWS_CREDENTIALS_SECRET_ARN),
      )
      .connect(process.env.INFRA_PROVIDER ?? "aws"),
    mailer: new SesMailer(from),
    secret,
    tasks: process.env.ENABLE_TASKS !== "false",
  });
}
export async function seedDemo(
  app: ReturnType<typeof createApplication>,
  password: string,
) {
  const definitions = [
    { email: "owner@example.test", name: "Owner", role: "owner" as const },
    { email: "ana@example.test", name: "Ana", role: "user" as const },
    { email: "leo@example.test", name: "Leo", role: "user" as const },
  ];
  for (const def of definitions) {
    let user = await app.users.byEmail(def.email);
    if (!user) user = await app.users.create({ ...def, password }, def.role);
    if (app.features.some((f) => f.id === "tasks")) {
      const id = `welcome-${user.data.id}`;
      if (!(await app.users.store.get("TASKS", id)))
        await app.users.store.transact([
          {
            row: {
              pk: "TASKS",
              sk: id,
              version: 1,
              data: {
                id,
                title: "Explore my first task in RT-App",
                done: false,
                ownerId: user.data.id,
                createdAt: new Date().toISOString(),
              },
            },
            expected: null,
          },
        ]);
    }
  }
  return definitions.map((d) => d.email);
}

/** Load once per Lambda environment; no plaintext secret in Terraform state or function configuration. */
export async function loadProductionApplication(
  modules?: string[],
  featureFactories: Array<(store: Store) => Feature> = [],
  components: ComponentOptions = {},
) {
  if (process.env.STRIPE_SECRET_ARN) {
    const client = new SecretsManagerClient({});
    try {
      const value = await client.send(
        new GetSecretValueCommand({ SecretId: process.env.STRIPE_SECRET_ARN }),
      );
      const keys = JSON.parse(value.SecretString ?? "{}");
      if (!keys.secretKey || !keys.webhookSecret || !keys.publishableKey)
        throw new Error("Stripe secret is incomplete");
      process.env.STRIPE_SECRET_KEY = keys.secretKey;
      process.env.STRIPE_WEBHOOK_SECRET = keys.webhookSecret;
      process.env.STRIPE_PUBLISHABLE_KEY = keys.publishableKey;
    } finally {
      client.destroy();
    }
  }
  if (!process.env.JWT_SECRET) {
    if (!process.env.JWT_SECRET_ARN)
      throw new Error("JWT_SECRET_ARN is required");
    const client = new SecretsManagerClient({});
    try {
      const value = await client.send(
        new GetSecretValueCommand({ SecretId: process.env.JWT_SECRET_ARN }),
      );
      if (!value.SecretString) throw new Error("JWT secret is not initialized");
      process.env.JWT_SECRET = value.SecretString;
    } finally {
      client.destroy();
    }
  }
  if (!process.env.ADMIN_PASSWORD_VERIFIER) {
    if (!process.env.ADMIN_PASSWORD_SECRET_ARN)
      throw new Error("ADMIN_PASSWORD_SECRET_ARN is required");
    const client = new SecretsManagerClient({});
    try {
      const value = await client.send(
        new GetSecretValueCommand({
          SecretId: process.env.ADMIN_PASSWORD_SECRET_ARN,
        }),
      );
      if (!value.SecretString)
        throw new Error("Admin password has not been initialized");
      process.env.ADMIN_PASSWORD_VERIFIER = value.SecretString;
    } finally {
      client.destroy();
    }
  }
  return createProductionApplication(modules, featureFactories, components);
}
