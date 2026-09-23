import type { NoSQL as Store } from "@gsalgadotoledo/rt-app-nosql";
import { randomUUID } from "node:crypto";
import {
  type Feature,
  type Actor,
  type Data,
  HttpError,
  Conflict,
  schemaMigration,
  text,
} from "@gsalgadotoledo/rt-app-contracts";
export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}
export interface AwsSettings {
  mode: "role" | "keys";
  region: string;
  secretVersion?: string;
}
export interface Identity {
  account: string;
  arn: string;
}
export interface ResourceSpec {
  kind: "queue" | "table";
  name: string;
}
export interface InfraDriver {
  readonly simulation: boolean;
  saveCredentials(credentials: Credentials): Promise<string>;
  identity(settings: AwsSettings): Promise<Identity>;
  create(
    settings: AwsSettings,
    spec: ResourceSpec,
    planId: string,
  ): Promise<{ id: string; status: string }>;
}
const defaults: AwsSettings = { mode: "role", region: "us-east-1" };
export class Infra {
  constructor(
    private store: Store,
    private driver: InfraDriver,
    private managedByTerraform = false,
  ) {}
  async settings() {
    const row = await this.store.get("SETTINGS", "infra");
    return {
      version: row?.version ?? 0,
      values: row?.data ?? defaults,
      simulation: this.driver.simulation,
      managedByTerraform: this.managedByTerraform,
      credentialsConfigured: !!row?.data.secretVersion,
    };
  }
  private owner(actor: Actor) {
    if (actor.role !== "owner")
      throw new HttpError(
        403,
        "Only the owner can manage infrastructure",
      );
  }
  async configure(actor: Actor, input: Data) {
    if(this.managedByTerraform) throw new HttpError(409,"Infrastructure is managed by Terraform: update the code and deploy through GitHub Actions");
    this.owner(actor);
    const { mode, region, version } = input;
    if (
      !["role", "keys"].includes(mode) ||
      typeof region !== "string" ||
      !/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region) ||
      !Number.isInteger(version)
    )
      throw new HttpError(400, "Invalid settings");
    const previous = await this.store.get("SETTINGS", "infra");
    if (version !== (previous?.version ?? 0)) throw new Conflict();
    let secretVersion =
      mode === "keys" ? previous?.data.secretVersion : undefined;
    if (mode === "keys" && input.credentials) {
      const { accessKeyId, secretAccessKey, sessionToken } = input.credentials;
      if (
        typeof accessKeyId !== "string" ||
        !/^[A-Z0-9]{16,128}$/.test(accessKeyId) ||
        typeof secretAccessKey !== "string" ||
        secretAccessKey.length < 20 ||
        secretAccessKey.length > 128 ||
        (sessionToken !== undefined &&
          (typeof sessionToken !== "string" || sessionToken.length > 4096))
      )
        throw new HttpError(400, "Invalid credentials");
      secretVersion = await this.driver.saveCredentials({
        accessKeyId,
        secretAccessKey,
        ...(sessionToken ? { sessionToken } : {}),
      });
    }
    if (mode === "keys" && !secretVersion)
      throw new HttpError(
        400,
        "Enter credentials or select the execution role",
      );
    const values = {
      mode,
      region,
      ...(secretVersion ? { secretVersion } : {}),
    };
    await this.store.transact([
      {
        row: {
          pk: "SETTINGS",
          sk: "infra",
          version: version + 1,
          data: values,
        },
        expected: previous?.version ?? null,
      },
      this.audit(actor, "settings.updated", { mode, region }),
    ]);
    return this.settings();
  }
  private audit(actor: Actor, action: string, details: Data) {
    return {
      row: {
        pk: "INFRA_AUDIT",
        sk: `${new Date().toISOString()}#${randomUUID()}`,
        version: 1,
        data: {
          actorId: actor.id,
          action,
          details,
          at: new Date().toISOString(),
        },
      },
      expected: null,
    };
  }
  async connection(actor: Actor) {
    this.owner(actor);
    const s = await this.settings();
    return {
      ...(await this.driver.identity(s.values as AwsSettings)),
      region: s.values.region,
      simulation: this.driver.simulation,
      managedByTerraform: this.managedByTerraform,
    };
  }
  async plan(actor: Actor, input: Data) {
    if(this.managedByTerraform) throw new HttpError(409,"Infrastructure is managed by Terraform: update the code and deploy through GitHub Actions");
    this.owner(actor);
    const name = text(input.name, "name", 80);
    if (
      !["queue", "table"].includes(input.kind) ||
      !/^rt-app-[a-z0-9-]{3,60}$/.test(name)
    )
      throw new HttpError(
        400,
        "Use queue/table and a name starting with rt-app- followed by letters, numbers or hyphens",
      );
    const settings = await this.settings(),
      identity = await this.driver.identity(settings.values as AwsSettings);
    if (identity.arn.endsWith(":root"))
      throw new HttpError(
        400,
        "Root credentials are not allowed; use a restricted IAM role or user",
      );
    const id = randomUUID(),
      spec: ResourceSpec = { kind: input.kind, name };
    const data = {
      id,
      spec,
      identity,
      region: settings.values.region,
      settingsVersion: settings.version,
      createdBy: actor.id,
      state: "planned",
      simulation: this.driver.simulation,
      managedByTerraform: this.managedByTerraform,
      expiresAt: Date.now() + 600000,
      summary:
        input.kind === "queue"
          ? "Standard SQS queue with SQS-managed encryption."
          : "DynamoDB pk/sk table with on-demand capacity and managed encryption.",
      costNotice:
        "AWS may charge for storage and usage. No resources have been created.",
    };
    await this.store.transact([
      { row: { pk: "INFRA_PLANS", sk: id, version: 1, data }, expected: null },
      this.audit(actor, "plan.created", { planId: id, spec }),
    ]);
    return data;
  }
  async apply(actor: Actor, id: string, confirmation: string) {
    if(this.managedByTerraform) throw new HttpError(409,"Infrastructure is managed by Terraform: update the code and deploy through GitHub Actions");
    this.owner(actor);
    const row = await this.store.get("INFRA_PLANS", id);
    if (!row) throw new HttpError(404, "Plan not found");
    if (row.data.createdBy !== actor.id)
      throw new HttpError(403, "The plan belongs to another owner");
    if (confirmation !== row.data.spec.name)
      throw new HttpError(400, "Confirm the exact resource name");
    if (row.data.state === "applied") return row.data;
    if (row.data.state !== "planned")
      throw new HttpError(
        409,
        "Operation in progress or outcome uncertain; check the resource in AWS before reconciling",
      );
    if (row.data.expiresAt < Date.now())
      throw new HttpError(409, "The plan has expired; generate another");
    const settings = await this.settings();
    if (
      settings.version !== row.data.settingsVersion ||
      this.driver.simulation !== row.data.simulation
    )
      throw new HttpError(409, "The configuration changed; generate another plan");
    const identity = await this.driver.identity(settings.values as AwsSettings);
    if (
      identity.account !== row.data.identity.account ||
      identity.arn !== row.data.identity.arn
    )
      throw new HttpError(409, "The AWS identity changed; generate another plan");
    const running = {
      ...row,
      version: row.version + 1,
      data: { ...row.data, state: "running" },
    };
    await this.store.transact([
      { row: running, expected: row.version },
      this.audit(actor, "plan.started", { planId: id }),
    ]);
    try {
      const result = await this.driver.create(
        settings.values as AwsSettings,
        row.data.spec,
        id,
      );
      const complete = {
        ...running,
        version: running.version + 1,
        data: { ...running.data, state: "applied", result },
      };
      await this.store.transact([
        { row: complete, expected: running.version },
        this.audit(actor, "plan.applied", { planId: id, result }),
      ]);
      return complete.data;
    } catch {
      try {
        await this.store.transact([
          {
            row: {
              ...running,
              version: running.version + 1,
              data: { ...running.data, state: "uncertain" },
            },
            expected: running.version,
          },
          this.audit(actor, "plan.uncertain", { planId: id }),
        ]);
      } catch {}
      throw new HttpError(
        502,
        "Outcome uncertain. Check AWS; resource creation will not be retried automatically.",
      );
    }
  }
  feature(): Feature {
    return {
      id: "infra",
      migrations: [schemaMigration("infra")],
      endpoints: [
        {
          method: "GET",
          path: "/infra/settings",
          resource: "infra.read",
          access: "owner",
          handle: () => this.settings(),
        },
        {
          method: "PUT",
          path: "/infra/settings",
          resource: "infra.settings",
          access: "owner",
          handle: (c) => this.configure(c.actor!, c.request.body),
        },
        {
          method: "POST",
          path: "/infra/test",
          resource: "infra.test",
          access: "owner",
          handle: (c) => this.connection(c.actor!),
        },
        {
          method: "GET",
          path: "/infra/plans",
          resource: "infra.read",
          access: "owner",
          handle: async (c) => {
            const page = await this.store.list(
              "INFRA_PLANS",
              c.request.query.cursor,
            );
            return {
              items: page.items.map((r) => r.data),
              cursor: page.cursor,
            };
          },
        },
        {
          method: "POST",
          path: "/infra/plans",
          resource: "infra.plan",
          access: "owner",
          handle: (c) => this.plan(c.actor!, c.request.body),
        },
        {
          method: "POST",
          path: "/infra/plans/:id/apply",
          resource: "infra.apply",
          access: "owner",
          handle: (c) =>
            this.apply(c.actor!, c.params.id, c.request.body.confirmation),
        },
        {
          method: "GET",
          path: "/infra/audit",
          resource: "infra.audit",
          access: "owner",
          handle: async (c) => {
            const p = await this.store.list(
              "INFRA_AUDIT",
              c.request.query.cursor,
            );
            return { items: p.items.map((r) => r.data), cursor: p.cursor };
          },
        },
      ],
    };
  }
}
/** Local development only: no AWS credentials are read and no cloud API is called. */
export class SimulatedInfraDriver implements InfraDriver {
  readonly simulation = true;
  async saveCredentials(_: Credentials): Promise<string> {
    throw new HttpError(
      400,
      "Simulation does not accept real keys. Use the simulated role mode.",
    );
  }
  async identity(_: AwsSettings) {
    return { account: "local-simulation", arn: "simulation:rt-app:owner" };
  }
  async create(settings: AwsSettings, spec: ResourceSpec, planId: string) {
    return {
      id: `simulation:${settings.region}:${spec.kind}:${spec.name}:${planId}`,
      status: "simulated",
    };
  }
}
export * from "./installation.js";

/** Explicit provider registration; unsupported providers fail before app startup. */
export class InfraRegistry {
  private providers = new Map<string, () => InfraDriver>();
  register(id: string, create: () => InfraDriver) {
    if (this.providers.has(id))
      throw new Error("Duplicate infrastructure provider: " + id);
    this.providers.set(id, create);
    return this;
  }
  connect(id: string) {
    const create = this.providers.get(id);
    if (!create) throw new Error("Unsupported infrastructure provider: " + id);
    return create();
  }
}
