import { createHash, randomUUID } from "node:crypto";
import { Umzug, type UmzugStorage } from "umzug";
import type {
  Environment,
  Feature,
  Migration,
  MigrationContext,
  MigrationStep,
  Row,
  Write,
  Seed,
  SeedContext,
  Store,
} from "@gsalgadotoledo/rt-app-contracts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type { Environment, Migration, MigrationContext, Seed, SeedContext };

export const ENVIRONMENTS: Environment[] = ["local", "develop", "stage", "prod"];

/** Seeds without an explicit list never reach production. */
export const DEFAULT_SEED_ENVIRONMENTS: Environment[] = ["local", "develop", "stage"];

export interface RunnerOptions {
  store: Store;
  features: Feature[];
  environment?: Environment;
  /** Identifies the process holding the lock in error messages. */
  owner?: string;
  /** A crashed runner's lock is taken over after this many milliseconds. */
  lockTtlMs?: number;
  clock?: () => Date;
  log?: (message: string) => void;
  /** Values seeds may read with `secret(name)`, e.g. DEMO_PASSWORD. */
  secrets?: Record<string, string | undefined>;
  /** Services seeds may read with `service(id)`. */
  services?: Record<string, unknown>;
}

export interface MigrationStatus {
  id: string;
  module: string;
  description?: string;
  state: "applied" | "pending" | "unknown";
  appliedAt?: string;
  reversible: boolean;
}

export interface SeedStatus {
  id: string;
  module: string;
  description?: string;
  state: "applied" | "pending" | "changed" | "skipped";
  appliedAt?: string;
  environments: Environment[];
}

export class MigrationLockedError extends Error {
  constructor(public holder: string, public expiresAt: string) {
    super(`Migrations are already running (${holder}, lock expires ${expiresAt})`);
  }
}

// ---------------------------------------------------------------------------
// Partitions. MIGRATIONS matches the pre-Umzug layout, so existing history is reused as-is.
// ---------------------------------------------------------------------------

const MIGRATIONS = "MIGRATIONS";
const SEEDS = "SEEDS";
const LOCKS = "MIGRATION_LOCKS";

/** Validate a migration or seed id: `module:name`, stable and safe as a sort key. */
function moduleOf(id: string, kind: string) {
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*$/i.test(id) || id.length > 200)
    throw new Error(`Invalid ${kind} id: ${String(id)} (expected module:name)`);
  return id.slice(0, id.indexOf(":"));
}

/** Read a whole partition through the paginated NoSQL contract. */
async function listAll(store: Store, pk: string) {
  const rows: Row[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list(pk, cursor);
    rows.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return rows;
}

/** Shared context: every helper goes through the NoSQL contract, never an engine SDK. */
export function createContext(
  store: Store,
  environment: Environment,
  log: (message: string) => void,
): MigrationContext {
  return {
    store,
    provider: store.provider,
    environment,
    log,
    async ensureRows(rows) {
      const inserted: string[] = [];
      for (const row of rows) {
        if (await store.get(row.pk, row.sk)) continue;
        try {
          // expected:null is a conditional create, so concurrent runners cannot overwrite each other.
          await store.transact([{ row: { ...row, version: 1 }, expected: null }]);
          inserted.push(row.pk + "/" + row.sk);
        } catch (error) {
          if (!(await store.get(row.pk, row.sk))) throw error;
        }
      }
      return inserted;
    },
  };
}

// ---------------------------------------------------------------------------
// Distributed lock: one conditional row, valid on every engine that satisfies the NoSQL contract.
// ---------------------------------------------------------------------------

class Lock {
  private version = 0;

  constructor(
    private store: Store,
    private name: string,
    private owner: string,
    private ttlMs: number,
    private clock: () => Date,
  ) {}

  /** Acquire, or take over an expired lock. Throws MigrationLockedError while another runner holds it. */
  async acquire() {
    const current = await this.store.get(LOCKS, this.name);
    const now = this.clock();
    if (current && new Date(current.data.expiresAt) > now)
      throw new MigrationLockedError(current.data.owner, current.data.expiresAt);
    const row = this.row(current ? current.version + 1 : 1, now);
    try {
      await this.store.transact([{ row, expected: current ? current.version : null }]);
    } catch {
      const winner = await this.store.get(LOCKS, this.name);
      throw new MigrationLockedError(winner?.data.owner ?? "unknown", winner?.data.expiresAt ?? "unknown");
    }
    this.version = row.version;
  }

  /** Extend the lease before each step so a runner that lost it stops instead of racing. */
  async renew() {
    await this.commit([]);
  }

  /**
   * Write history in the same atomic transaction as the lease renewal: if another runner took the
   * lease, the conditional lock write fails and nothing is recorded.
   */
  async commit(writes: Write[]) {
    const row = this.row(this.version + 1, this.clock());
    await this.store.transact([...writes, { row, expected: this.version }]);
    this.version = row.version;
  }

  /** Release only our own lease; a lost lease is left for its new holder. */
  async release() {
    const current = await this.store.get(LOCKS, this.name);
    if (!current || current.version !== this.version || current.data.owner !== this.owner) return;
    await this.store.transact([{ row: current, expected: current.version, delete: true }]);
  }

  private row(version: number, now: Date): Row {
    return {
      pk: LOCKS,
      sk: this.name,
      version,
      data: {
        owner: this.owner,
        acquiredAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
      },
    };
  }
}

async function withLock<T>(options: Required<Pick<RunnerOptions, "store" | "owner" | "lockTtlMs" | "clock">>, name: string, work: (lock: Lock) => Promise<T>) {
  const lock = new Lock(options.store, name, options.owner, options.lockTtlMs, options.clock);
  await lock.acquire();
  try {
    return await work(lock);
  } finally {
    await lock.release();
  }
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

interface PlannedMigration {
  migration: Migration;
  module: string;
  step: MigrationStep & { up: (context: MigrationContext) => Promise<void> };
  providerSpecific: boolean;
}

/** Choose the provider override or the generic steps; legacy `run(store)` maps to `up`. */
function selectStep(migration: Migration, provider: string): PlannedMigration["step"] | undefined {
  const specific = migration.providers?.[provider];
  const source = specific ?? (migration.up || migration.run ? migration : undefined);
  if (!source) return undefined;
  const up = source.up ?? (source.run ? (context: MigrationContext) => source.run!(context.store) : undefined);
  if (!up) return undefined;
  return { checksum: specific?.checksum ?? migration.checksum, up, down: source.down };
}

/**
 * Module migrations run in feature order through Umzug, with history in the application store.
 *
 * Guarantees: the whole plan is validated before any write; one runner at a time (lease lock);
 * applied checksums are immutable; `down` refuses irreversible migrations instead of skipping them.
 * Steps must still be idempotent: a crash between a step and its history record re-runs that step.
 */
export class MigrationRunner {
  private options: Required<Omit<RunnerOptions, "secrets" | "services">> & Pick<RunnerOptions, "secrets" | "services">;
  private plan: PlannedMigration[];

  constructor(options: RunnerOptions) {
    this.options = {
      environment: "local",
      owner: "rt-app-" + randomUUID(),
      lockTtlMs: 15 * 60_000,
      clock: () => new Date(),
      log: () => {},
      ...options,
    };
    if (!ENVIRONMENTS.includes(this.options.environment))
      throw new Error("Unknown environment: " + this.options.environment);
    this.plan = this.buildPlan();
  }

  /** Every declared migration with its applied/pending state. Does not write. */
  async status(): Promise<MigrationStatus[]> {
    const history = await this.history();
    const known = new Set(this.plan.map(p => p.migration.id));
    return [
      ...this.plan.map(({ migration, module, step }) => ({
        id: migration.id,
        module,
        description: migration.description,
        state: history.has(migration.id) ? ("applied" as const) : ("pending" as const),
        appliedAt: history.get(migration.id)?.data.appliedAt,
        reversible: Boolean(step.down),
      })),
      // History for modules that are no longer enabled is reported, never reverted.
      ...[...history.values()]
        .filter(row => !known.has(row.sk))
        .map(row => ({ id: row.sk, module: row.sk.split(":")[0], state: "unknown" as const, appliedAt: row.data.appliedAt, reversible: false })),
    ];
  }

  /** Apply pending migrations (all, up to `to`, or `step` of them). Returns applied ids. */
  async up(options: { to?: string; step?: number } = {}) {
    return withLock(this.options, "migrations", async lock => {
      await this.verifyHistory();
      const umzug = this.umzug(lock);
      const applied = await umzug.up(options.to ? { to: options.to } : options.step !== undefined ? { step: options.step } : {});
      return applied.map(m => m.name);
    });
  }

  /** Revert the last `step` (default 1) applied migrations, or down to and including `to`. */
  async down(options: { to?: string; step?: number } = {}) {
    return withLock(this.options, "migrations", async lock => {
      await this.verifyHistory();
      const history = await this.history();
      const applied = this.plan.filter(p => history.has(p.migration.id)).reverse();
      let targets = applied.slice(0, options.step ?? 1);
      if (options.to) {
        const index = applied.findIndex(p => p.migration.id === options.to);
        if (index < 0) throw new Error("Migration is not applied: " + options.to);
        targets = applied.slice(0, index + 1);
      }
      const irreversible = targets.filter(p => !p.step.down).map(p => p.migration.id);
      // Umzug would silently unlog a migration without `down`; refuse before touching anything.
      if (irreversible.length) throw new Error("Irreversible migrations: " + irreversible.join(", "));
      if (!targets.length) return [];
      const reverted = await this.umzug(lock).down({ step: targets.length });
      return reverted.map(m => m.name);
    });
  }

  private buildPlan(): PlannedMigration[] {
    const provider = this.options.store.provider;
    const plan: PlannedMigration[] = [];
    const ids = new Set<string>();
    for (const feature of this.options.features)
      for (const migration of feature.migrations ?? []) {
        const module = moduleOf(migration.id, "migration");
        if (ids.has(migration.id)) throw new Error("Duplicate migration id: " + migration.id);
        ids.add(migration.id);
        const step = selectStep(migration, provider);
        if (!step) throw new Error("Unsupported migration " + migration.id + " for " + provider);
        if (!step.checksum) throw new Error("Migration without checksum: " + migration.id);
        plan.push({ migration, module, step, providerSpecific: Boolean(migration.providers?.[provider]) });
      }
    return plan;
  }

  private async history() {
    return new Map((await listAll(this.options.store, MIGRATIONS)).map(row => [row.sk, row]));
  }

  /** Applied migrations are immutable: a changed checksum or engine-specific step fails the run. */
  private async verifyHistory() {
    const history = await this.history();
    for (const { migration, step, providerSpecific } of this.plan) {
      const record = history.get(migration.id);
      if (!record) continue;
      const engineChanged = providerSpecific && record.data.provider && record.data.provider !== this.options.store.provider;
      if (record.data.checksum !== step.checksum || engineChanged)
        throw new Error("Migration changed: " + migration.id);
    }
  }

  private umzug(lock: Lock) {
    const { store, environment, log } = this.options;
    const context = createContext(store, environment, log);
    const plan = this.plan;
    const clock = this.options.clock;
    const storage: UmzugStorage<MigrationContext> = {
      async executed() {
        const history = new Map((await listAll(store, MIGRATIONS)).map(row => [row.sk, row]));
        // Plan order is application order, which Umzug reverses for `down`.
        return plan.filter(p => history.has(p.migration.id)).map(p => p.migration.id);
      },
      async logMigration({ name }) {
        const planned = plan.find(p => p.migration.id === name)!;
        await lock.commit([{
          row: { pk: MIGRATIONS, sk: name, version: 1, data: { checksum: planned.step.checksum, provider: store.provider, appliedAt: clock().toISOString() } },
          expected: null,
        }]);
      },
      async unlogMigration({ name }) {
        const record = await store.get(MIGRATIONS, name);
        await lock.commit(record ? [{ row: record, expected: record.version, delete: true }] : []);
      },
    };
    const umzug = new Umzug<MigrationContext>({
      migrations: plan.map(p => ({
        name: p.migration.id,
        up: async ({ context }) => {
          await lock.renew();
          await p.step.up(context);
        },
        down: p.step.down
          ? async ({ context }) => {
              await lock.renew();
              await p.step.down!(context);
            }
          : undefined,
      })),
      context,
      storage,
      logger: undefined,
    });
    umzug.on("migrating", ({ name }) => log("migrating " + name));
    umzug.on("reverting", ({ name }) => log("reverting " + name));
    return umzug;
  }
}

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

interface PlannedSeed {
  seed: Seed;
  module: string;
  version: string;
  environments: Environment[];
}

/**
 * Module seeds (demo or reference data) through a second Umzug instance with its own history.
 * A seed runs once per version and environment; `rerun` forces idempotent seeds again.
 */
export class SeedRunner {
  private options: Required<Omit<RunnerOptions, "secrets" | "services">> & Pick<RunnerOptions, "secrets" | "services">;
  private plan: PlannedSeed[];

  constructor(options: RunnerOptions) {
    this.options = {
      environment: "local",
      owner: "rt-app-" + randomUUID(),
      lockTtlMs: 15 * 60_000,
      clock: () => new Date(),
      log: () => {},
      ...options,
    };
    if (!ENVIRONMENTS.includes(this.options.environment))
      throw new Error("Unknown environment: " + this.options.environment);
    const ids = new Set<string>();
    this.plan = this.options.features.flatMap(feature =>
      (feature.seeds ?? []).map(seed => {
        const module = moduleOf(seed.id, "seed");
        if (ids.has(seed.id)) throw new Error("Duplicate seed id: " + seed.id);
        ids.add(seed.id);
        const environments = seed.environments ?? DEFAULT_SEED_ENVIRONMENTS;
        if (!environments.length || environments.some(e => !ENVIRONMENTS.includes(e)))
          throw new Error("Invalid environments for seed " + seed.id);
        return { seed, module, version: seed.version ?? "1", environments };
      }),
    );
  }

  /** Every declared seed and whether it would run in this environment. Does not write. */
  async status(): Promise<SeedStatus[]> {
    const history = await this.history();
    return this.plan.map(({ seed, module, version, environments }) => {
      const record = history.get(seed.id);
      return {
        id: seed.id,
        module,
        description: seed.description,
        environments,
        appliedAt: record?.data.appliedAt,
        state: !environments.includes(this.options.environment)
          ? "skipped"
          : !record
            ? "pending"
            : record.data.version !== version
              ? "changed"
              : "applied",
      };
    });
  }

  /**
   * Run pending or changed seeds allowed in this environment, optionally limited to modules.
   * `rerun` also runs seeds already applied. Returns the ids that ran.
   */
  async run(options: { modules?: string[]; rerun?: boolean } = {}) {
    for (const module of options.modules ?? [])
      if (!this.options.features.some(f => f.id === module)) throw new Error("Unknown module: " + module);
    const selected = this.plan.filter(
      p => p.environments.includes(this.options.environment) && (!options.modules || options.modules.includes(p.module)),
    );
    if (!selected.length) return [];
    return withLock(this.options, "seeds", async lock => {
      const umzug = this.umzug(lock, selected);
      const ran = await umzug.up(
        options.rerun
          ? { migrations: selected.map(p => p.seed.id), rerun: "ALLOW" }
          : {},
      );
      return ran.map(m => m.name);
    });
  }

  private async history() {
    return new Map((await listAll(this.options.store, SEEDS)).map(row => [row.sk, row]));
  }

  private context(seedId: string): SeedContext {
    const { store, environment, log, secrets = {}, services = {} } = this.options;
    return {
      ...createContext(store, environment, log),
      secret(name) {
        const value = secrets[name];
        if (!value) throw new Error(`Seed ${seedId} requires ${name}`);
        return value;
      },
      service<T>(id: string) {
        if (!(id in services)) throw new Error(`Seed ${seedId} requires the ${id} service`);
        return services[id] as T;
      },
      async faker() {
        let module: any;
        try {
          module = await import("@faker-js/faker" as string);
        } catch {
          throw new Error("Install @faker-js/faker as a devDependency to generate example data");
        }
        const faker = module.faker;
        // Same seed id → same example data on every machine and environment.
        faker.seed(createHash("sha256").update(seedId).digest().readUInt32BE(0));
        return faker;
      },
    };
  }

  private umzug(lock: Lock, selected: PlannedSeed[]) {
    const { store, clock, log, environment } = this.options;
    const storage: UmzugStorage = {
      async executed() {
        const history = new Map((await listAll(store, SEEDS)).map(row => [row.sk, row]));
        // A seed whose version changed is pending again.
        return selected.filter(p => history.get(p.seed.id)?.data.version === p.version).map(p => p.seed.id);
      },
      async logMigration({ name }) {
        const planned = selected.find(p => p.seed.id === name)!;
        const current = await store.get(SEEDS, name);
        await lock.commit([{
          row: {
            pk: SEEDS,
            sk: name,
            version: (current?.version ?? 0) + 1,
            data: { version: planned.version, environment, appliedAt: clock().toISOString() },
          },
          expected: current ? current.version : null,
        }]);
      },
      async unlogMigration() {
        throw new Error("Seeds cannot be reverted; write a migration or a new seed version instead");
      },
    };
    const umzug = new Umzug({
      migrations: selected.map(p => ({
        name: p.seed.id,
        up: async () => {
          await lock.renew();
          await p.seed.run(this.context(p.seed.id));
        },
      })),
      storage,
      logger: undefined,
    });
    umzug.on("migrating", ({ name }) => log("seeding " + name));
    return umzug;
  }
}

/** Apply all pending migrations. Kept for callers of the pre-Umzug contracts `migrate`. */
export async function migrate(store: Store, features: Feature[], options: Omit<RunnerOptions, "store" | "features"> = {}) {
  return new MigrationRunner({ ...options, store, features }).up();
}
