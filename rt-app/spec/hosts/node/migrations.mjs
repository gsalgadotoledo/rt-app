// Subjects: migrations (MemoryStore), migrations-postgres and migrations-dynamodb (optional).
// A facade over MigrationRunner, SeedRunner, createContext and the rta migrate / rta seed commands.
// Migrations and seeds are declared as data in init.features, so every language builds identical
// steps from the same description (migrations contract). Other languages expose the same method
// names with the same positional arguments.
import { MigrationRunner, SeedRunner, createContext } from "@gsalgadotoledo/rt-app-migrations";
import { migrateCommand, seedCommand } from "@gsalgadotoledo/rt-app-migrations/cli";
import { schemaMigration } from "@gsalgadotoledo/rt-app-contracts";
import { memoryStore, subjects as stores } from "./storage.mjs";
import { faultyStore } from "./cache.mjs";

const LOCKS = "MIGRATION_LOCKS";
const DEFAULT_NOW = "2026-09-24T10:00:00.000Z";

// Wire null means "not given": optional TypeScript fields receive undefined, not null.
const given = (value) => (value === null ? undefined : value);

/** Omit null/undefined fields, so TypeScript defaults apply. */
const defined = (object) => Object.fromEntries(Object.entries(object ?? {}).filter(([, v]) => v !== null && v !== undefined));

function parseIso(iso, what) {
  const ms = typeof iso === "string" ? Date.parse(iso) : NaN;
  if (Number.isNaN(ms)) throw new TypeError(`${what} must be an ISO 8601 date`);
  return ms;
}

async function readAll(store, pk) {
  const rows = [];
  let cursor;
  do {
    const page = await store.list(pk, cursor);
    rows.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return rows;
}

/**
 * Build the facade over `backing` (a NoSQL store). State shared by every runner the facade creates:
 * the store (with fault injection), the clock, the trace of steps and the log lines.
 */
function facade(backing, init) {
  init = init ?? {};
  let now = parseIso(init.now ?? DEFAULT_NOW, "init.now");
  const faulty = faultyStore(backing);
  // The provider name the runners see (history rows record it), "memory" unless init.provider says
  // otherwise, so every backing engine (memory, PostgreSQL, DynamoDB) produces the same rows.
  const provider = init.provider ?? "memory";
  const store = {
    provider,
    get: (pk, sk) => faulty.get(pk, sk),
    list: (pk, cursor) => faulty.list(pk, cursor),
    transact: (writes) => faulty.transact(writes),
  };
  const state = {
    features: init.features ?? [],
    environment: given(init.environment),
    owner: init.owner === undefined ? "runner-a" : given(init.owner),
    lockTtlMs: given(init.lockTtlMs),
    secrets: given(init.secrets),
    services: given(init.services),
  };
  const trace = [];
  const logs = [];
  let output = [];
  const clock = () => new Date(now);
  const log = (line) => logs.push(line);

  /** Runner options as the application passes them; `extra` wins (CLI log, nested owner). */
  const options = (extra = {}) => defined({
    environment: state.environment,
    owner: state.owner,
    lockTtlMs: state.lockTtlMs,
    clock,
    log,
    secrets: state.secrets,
    services: state.services,
    ...extra,
    store,
  });

  /** Run a list of data operations inside a step. `context` is null for legacy run(store) steps. */
  async function perform(ops, context) {
    for (const op of ops ?? []) {
      const [kind, value] = Object.entries(op)[0] ?? [];
      const needContext = () => {
        if (!context) throw new Error(`Operation ${kind} needs a migration context`);
        return context;
      };
      switch (kind) {
        case "ensure": trace.push({ ensured: await needContext().ensureRows(value) }); break;
        case "delete": {
          const row = await store.get(value.pk, value.sk);
          if (row) await store.transact([{ row, expected: row.version, delete: true }]);
          break;
        }
        case "fail": throw new Error(value);
        case "advance": now += value; break;
        case "steal": {
          // Another runner takes the lease (as after an expiry): version + 1, its owner and TTL.
          const current = await store.get(LOCKS, value.lock);
          const at = new Date(now);
          await store.transact([{
            row: { pk: LOCKS, sk: value.lock, version: current ? current.version + 1 : 1, data: { owner: value.owner, acquiredAt: at.toISOString(), expiresAt: new Date(now + (value.ttlMs ?? 900000)).toISOString() } },
            expected: current ? current.version : null,
          }]);
          break;
        }
        case "release": {
          const current = await store.get(LOCKS, value);
          if (current) await store.transact([{ row: current, expected: current.version, delete: true }]);
          break;
        }
        case "faults": for (const fault of value) faulty.inject(fault, 1); break;
        case "peek": trace.push({ peek: (await store.get(value[0], value[1])) ?? null }); break;
        case "log": needContext().log(value); break;
        case "context": { const c = needContext(); trace.push({ context: { provider: c.provider, environment: c.environment } }); break; }
        case "secret": trace.push({ secret: needContext().secret(value) }); break;
        case "service": trace.push({ service: needContext().service(value) ?? null }); break;
        case "nested": {
          // Another runner on the same store and clock (by default with no modules of its own).
          const runner = value.runner === "seeds"
            ? new SeedRunner(options({ owner: value.owner, features: build(value.features ?? []) }))
            : new MigrationRunner(options({ owner: value.owner, features: build(value.features ?? []) }));
          try {
            trace.push({ nested: { value: (await runner[value.call](defined(value.options))) ?? null } });
          } catch (error) {
            trace.push({ nested: { error: error.message } });
          }
          break;
        }
        default: throw new TypeError("Unknown operation " + JSON.stringify(op));
      }
    }
  }

  /** A step function from ops, or undefined when the declaration has none. */
  const step = (id, name, ops) => ops == null ? undefined : async (context) => {
    trace.push(`${id} ${name}`);
    await perform(ops, context);
  };

  function migration(declaration) {
    if (declaration.schema !== undefined) return schemaMigration(declaration.schema);
    const { id, checksum, description, up, down, run, providers } = declaration;
    const legacy = run == null ? undefined : async (s) => {
      trace.push(`${id} run`);
      await perform(run, null);
    };
    return defined({
      id,
      checksum,
      description,
      up: step(id, "up", up),
      down: step(id, "down", down),
      run: legacy,
      providers: providers == null ? undefined : Object.fromEntries(Object.entries(providers).map(([name, p]) => [name, defined({
        checksum: p.checksum,
        up: step(id, "up@" + name, p.up),
        down: step(id, "down@" + name, p.down),
        run: p.run == null ? undefined : async () => { trace.push(`${id} run@${name}`); await perform(p.run, null); },
      })])),
    });
  }

  const seed = (declaration) => defined({
    id: declaration.id,
    description: declaration.description,
    version: declaration.version,
    environments: declaration.environments,
    run: step(declaration.id, "seed", declaration.run ?? []),
  });

  /** Features from their data description: {id, migrations: [...], seeds: [...]}. */
  function build(features) {
    return features.map((f) => ({ id: f.id, endpoints: [], migrations: (f.migrations ?? []).map(migration), seeds: (f.seeds ?? []).map(seed) }));
  }

  const migrations = (extra) => new MigrationRunner(options({ features: build(state.features), ...extra }));
  const seeds = (extra) => new SeedRunner(options({ features: build(state.features), ...extra }));
  // The application surface the CLI commands need (MigratableApplication).
  const application = () => ({
    environment: state.environment ?? "local",
    migrations: (o) => new MigrationRunner(options({ features: build(state.features), log: o.log })),
    seeds: (o) => new SeedRunner(options({ features: build(state.features), log: o.log, secrets: o.secrets })),
  });

  return {
    // MigrationRunner (a new runner per call, as the application builds them).
    status: () => migrations().status(),
    up: (target) => migrations().up(defined(target)),
    down: (target) => migrations().down(defined(target)),
    // SeedRunner.
    seedStatus: () => seeds().status(),
    seed: (options) => seeds().run(defined(options)),
    // createContext(store, environment, log).ensureRows(rows) → inserted "pk/sk" keys.
    ensureRows: (rows) => createContext(store, state.environment ?? "local", log).ensureRows(rows),
    // rta migrate / rta seed: the printed lines; output() keeps the lines of a failed command.
    migrateCommand: async (argv) => {
      output = [];
      await migrateCommand(application(), argv ?? [], (line) => output.push(line));
      return output;
    },
    seedCommand: async (argv, secrets) => {
      output = [];
      await seedCommand(application(), argv ?? [], secrets ?? {}, (line) => output.push(line));
      return output;
    },
    output: () => output,
    // Helpers.
    trace: () => trace,
    logs: () => logs,
    row: async (pk, sk) => (await store.get(pk, sk)) ?? null,
    rows: (pk) => readAll(store, pk),
    setNow: (iso) => ((now = parseIso(iso, "setNow")), null),
    setFeatures: (features) => ((state.features = features ?? []), null),
    setEnvironment: (environment) => ((state.environment = given(environment)), null),
    setOwner: (owner) => ((state.owner = given(owner)), null),
    injectFaults: (kind, count) => faulty.inject(kind, given(count)),
    close: () => backing.close?.(),
  };
}

const withStore = (open) => async (init) => facade(await open(init?.rows ?? []), init);

export const subjects = {
  migrations: withStore((rows) => memoryStore(rows)),
  ...(stores["nosql-postgres"] ? { "migrations-postgres": withStore((rows) => stores["nosql-postgres"]({ rows })) } : {}),
  ...(stores["nosql-dynamodb"] ? { "migrations-dynamodb": withStore((rows) => stores["nosql-dynamodb"]({ rows })) } : {}),
};
