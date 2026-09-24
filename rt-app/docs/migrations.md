# Migrations and seeds

`@gsalgadotoledo/rt-app-migrations` runs module-owned migrations and seeds on top of [Umzug](https://github.com/sequelize/umzug) (the runner behind Sequelize). RT-App provides what Umzug leaves to its host: history stored in the application's own NoSQL store, a lease lock, immutable checksums, per-engine steps and environment-gated seeds.

## Where migrations live

Each module declares them next to its code and commits them with it:

```
packages/catalog/src/
  index.js         feature(store) → { id, endpoints, migrations, seeds }
  migrations.js    export const migrations = [...]
  seeds.js         export const seeds = [...]
```

The framework collects `migrations` and `seeds` from every **enabled** module in registration order (core modules first, then generated CRUDs, in `modules.json` order). There is no separate folder or registry to maintain.

## Writing a migration

```js
export const migrations = [
  schemaMigration("catalog"),                 // catalog:001, generated
  {
    id: "catalog:002",                        // permanent: module:NNN
    checksum: "catalog-currencies-v1",        // change the id, never the checksum
    description: "Add supported currencies",
    up: async ({ ensureRows }) => {
      await ensureRows([{ pk: "CURRENCY", sk: "USD", data: { code: "USD" } }]);
    },
    down: async ({ store }) => { /* optional; without it the migration is irreversible */ },
  },
];
```

The context (`MigrationContext`) exposes `store`, `provider`, `environment`, `log` and `ensureRows` (insert only if missing, safe under concurrency). Write through `store` — the NoSQL contract — so **the same step runs on DynamoDB in AWS, the JSON file locally and memory in tests**.

For an engine-specific step, add an override. It replaces the generic step on that engine only:

```js
{ id: "catalog:003", checksum: "generic-v1", up: genericUp,
  providers: { dynamodb: { checksum: "dynamo-v1", up: dynamoUp } } }
```

A future SQL adapter follows the same shape: one generic step through the store contract, provider overrides where dialects differ. Migrating data between SQL and NoSQL engines is out of scope.

### Rules

- Append only. Never edit, reorder or delete an applied migration: a changed checksum stops the run with `Migration changed: <id>`.
- Steps must be idempotent. History is written after the step, so a crash in between re-runs that step.
- Prefer expand/contract changes: the new Lambda version is live before migrations finish.
- `down` is refused (`Irreversible migrations: …`) if any target lacks it. Nothing is reverted in that case.

## Seeds

Seeds are example or reference data owned by a module:

```js
export const seeds = [{
  id: "catalog:examples",
  description: "12 example products",
  version: "1",                                // bump to apply a changed seed again
  environments: ["local", "develop", "stage"], // default; prod only when listed explicitly
  run: async ({ ensureRows, faker, secret, service }) => {
    const f = await faker();                   // deterministic @faker-js/faker (devDependency)
    await ensureRows([{ pk: "CRUD#catalog", sk: "example-001", data: { name: f.commerce.productName() } }]);
  },
}];
```

- `secret("DEMO_PASSWORD")` reads a secret passed by the command and fails if it is missing.
- `service("users")` accesses a shared module service. The users module exposes `byEmail` and `demoUsers()`.
- A seed runs once per version per database. `--rerun` forces idempotent seeds again.
- Built-in seeds: `users:demo-identities` (owner, ana, leo) and `tasks:welcome`. Both are declared for local, develop and stage only.

## Commands

```sh
rta migrate                 # status: applied / pending / unknown (history of disabled modules)
rta migrate up [--to id | --step n]
rta migrate down [--to id | --step n]    # default: last one
rta seed [run] [--module catalog] [--rerun]
rta seed status
# add --json for machine-readable output
```

The commands use the database selected by `RT_APP_MODE`: `json` (default local file), `dynamodb-local` or `aws`. `memory` data only lives inside the running server. Seeding a deployed environment from a terminal also requires `CONFIRM_DEMO_SEED=yes`.

## Deployments

`rta deploy` applies pending migrations for every environment before publishing. Seeding after migrations is opt-in per repository:

- variable `RT_APP_SEED_ENABLED=true`
- secret `DEMO_PASSWORD`

The environment (`develop`, `stage`, `prod`) comes from the branch. Only seeds that declare that environment run, so demo identities reach stage but never production.

## Guarantees

- The whole plan (ids, duplicates, engine support, checksums) is validated before any write.
- One runner at a time per database: a lease row (`MIGRATION_LOCKS`) with a conditional write. A crashed runner's lease expires (15 min by default) and is taken over. The lease is renewed before each step, and history is written in the same transaction as the renewal. A runner that lost its lease therefore stops without recording anything.
- History lives in `MIGRATIONS` and `SEEDS` partitions of the application store. Records written before Umzug are read as-is.
