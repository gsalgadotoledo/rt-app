# Migrations and seeds: contract and ports

Contract: `spec/contracts/migrations.contract.yaml`. It covers `MigrationRunner`, `SeedRunner`,
`createContext().ensureRows` and the `rta migrate` / `rta seed` helpers of
`packages/migrations/src/cli.ts`. The module has no HTTP endpoints, so there is no `kind: http`
contract. Hosts: `spec/hosts/node/migrations.mjs`, `spec/hosts/python/migrations.py`,
`core-go/cmd/contract-host/migrations.go`. The contract description holds the full algorithm; this
page lists what a port exposes and the rules it must copy.

| | TypeScript | Python (`rt_app.migrations`) | Go (`rt.local/core-go/migrations`) |
| --- | --- | --- | --- |
| Declarations | `Migration`, `Seed` on a feature | `Migration(id, checksum, description, up, down, run, providers)`, `MigrationStep`, `Seed(id, run, …)`, `Module(id, migrations, seeds)` | `Migration{ID, Checksum, Description *string, Up, Down, Run, Providers}`, `Step`, `Seed`, `Module` |
| Migrations | `new MigrationRunner({store, features, …})` | `MigrationRunner(store, modules, environment=, owner=, lock_ttl_ms=, clock=, log=, provider=)` | `NewRunner(Options{Store, Modules, Environment, Owner, LockTTL, Clock, Log, Provider})` |
| Methods | `status()`, `up({to, step})`, `down({to, step})` | `status()`, `up(to=, step=)`, `down(to=, step=)` | `Status(ctx)`, `Up(ctx, Target{To, Step *int})`, `Down(ctx, Target)` |
| Seeds | `new SeedRunner(…)`: `status()`, `run({modules, rerun})` | `SeedRunner(…)`: `status()`, `run(modules=, rerun=)` | `NewSeedRunner(Options)`: `Status`, `Run(ctx, RunOptions{Modules, Rerun})` |
| Helpers | `schemaMigration`, `createContext`, `migrate` | `schema_migration`, `create_context`, `migrate` | `SchemaMigration`, `NewContext`, `Migrate` |
| Errors | `MigrationLockedError`, Umzug `MigrationError` | `MigrationLockedError`, `MigrationError` | `*LockedError`, `*StepError` (`Unwrap`) |

The provider is the store's `provider` (Python stores have it). Go stores have none: pass
`Options.Provider`, or use a store with a `Provider() string` method; `*nosql.MemoryStore` is
`memory`. Clocks are injectable everywhere (`clock` in TypeScript and Python, `Options.Clock` in Go).

## Declaring migrations as values

TypeScript modules return `{id, endpoints, migrations, seeds}` from their feature. Python and Go
modules declare the same values next to their code:

- A migration is `{id, checksum, description?, up?, down?, run?, providers?}`. `run(store)` is the
  legacy form of `up`. `providers[<engine>]` replaces the generic step on that engine only (it
  never falls back to the generic step).
- A seed is `{id, description?, version? = "1", environments? = [local, develop, stage], run}`.
- `schemaMigration(module)` / `schema_migration` / `SchemaMigration` is the first migration of every
  document module: id `<module>:001`, checksum `<module>-document-v1`.

## Subjects

`migrations` (MemoryStore) plus `migrations-postgres` and `migrations-dynamodb` when
`RT_APP_TEST_POSTGRES_URL` / `RT_APP_TEST_DYNAMODB_ENDPOINT` are set (`npm run contracts:stores`).
Every case runs on the three stores.

`init`: `{now, environment?, owner? ("runner-a"), lockTtlMs?, provider? ("memory"), secrets?,
services?, rows?, features}`. Migrations and seeds are **data**, so every language builds identical
steps: a step is a list of operations, and each step first appends `"<id> up|down|run|seed"`
(`"up@<provider>"` for overrides) to `trace()`.

| Operation | Effect |
| --- | --- |
| `{ensure: rows}` | `ensureRows(rows)`; traces `{ensured}` |
| `{delete: {pk, sk}}` | deletes the row if present |
| `{fail: message}` | throws `Error(message)` |
| `{advance: ms}` | moves the clock (a runner that sleeps past its lease) |
| `{steal: {lock, owner, ttlMs?}}` | another runner rewrites the lock row (version + 1) |
| `{release: lock}` | deletes the lock row |
| `{faults: [kind…]}` | next transactions: `ok`, `conflict`, `error`, `lostAck` |
| `{peek: [pk, sk]}` | traces `{peek: row}` (lock and history rows mid-run) |
| `{log}`, `{context: true}`, `{secret}`, `{service}` | context helpers |
| `{nested: {runner, owner, call, options?, features?}}` | another runner on the same store and clock |

Methods: `status()`, `up(target)`, `down(target)`, `seedStatus()`, `seed(options)`,
`ensureRows(rows)`, `migrateCommand(argv)`, `seedCommand(argv, secrets)`, `output()`; helpers
`trace()`, `logs()`, `row(pk, sk)`, `rows(pk)`, `setNow`, `setFeatures`, `setEnvironment`,
`setOwner` (null: the default random owner), `injectFaults`. Every call builds new runners, like
the application and the CLI do.

## Stored formats (shared database)

Rows written by one language are read by the others, so they are pinned byte for byte.

- **History:** `MIGRATIONS/<id>` `{version: 1, data: {checksum, provider, appliedAt}}`;
  `SEEDS/<id>` `{version: n, data: {version, environment, appliedAt}}` (the row version grows on
  each run, `data.version` is the seed version string). Rows written before Umzug, with more
  fields or other versions, are read as they are.
- **Checksums** are the declared strings, compared with `===`. Nothing is hashed, so there is no
  algorithm to reproduce: `"3"` and `3` differ, and `"v1 "` is not `"v1"`.
- **Lock:** `MIGRATION_LOCKS/migrations` (seeds: `MIGRATION_LOCKS/seeds`) with
  `{owner, acquiredAt, expiresAt}` in `toISOString` format. Each renewal rewrites the row with
  version + 1 and a new `acquiredAt`.

## Semantics ports must copy

- **Plan first:** environments, ids (`/^[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*$/i`, ASCII only,
  no trailing newline, at most 200 UTF-16 units), duplicates, engine support and checksums are
  checked when a runner is created, in declaration order, before any read or write. Messages print
  `String(id)`, so a missing id prints `undefined`.
- **Umzug behavior, reimplemented:** pending = plan minus history; `to` (when truthy) must be
  pending (`Couldn't find migration to apply with name "<JSON>"`) and wins over `step`; `step` uses
  JavaScript `slice` (negative counts from the end). Step failures are wrapped as
  `Migration <id> (up|down) failed: Original error: <message>`; history write failures are not.
- **Lock:** a row whose `expiresAt` parses to a time strictly after now blocks the run with
  `Migrations are already running (<owner>, lock expires <expiresAt>)`; an unparsable or missing
  expiry is expired. A failed acquisition write (any error) reads again and reports the winner or
  `unknown`. `up`/`down` lock even when nothing is pending; seeds with nothing selected do not.
- **Lease:** renewal happens before every step and in the same transaction as every history write.
  A runner that lost its lease records nothing more (409 `Conflict: refresh and try again`, or the
  wrapped message when the renewal before a step fails). Expiry is only checked on acquisition, so a
  slow runner still records while nobody took over. Release deletes the row only while version and
  owner are still ours; after a lost acknowledgement the row stays until it expires.
- **Idempotency:** steps must be idempotent: a failed history write re-runs the step next time.
  `ensureRows` never overwrites and swallows an error only when the row exists afterwards.
- **Down:** targets without `down` fail the whole call before anything runs
  (`Irreversible migrations: a, b`, latest first). A failing `down` stops the rollback; migrations
  already reverted stay reverted. History of undeclared modules is `unknown` and never reverted.
- **Seeds:** environment filter (production only runs seeds that list `prod`), module filter by id
  prefix with every listed module declared (`Unknown module: <m>`), version change → `changed`,
  `rerun` runs every selected seed. `secret(name)` needs a non-empty value.

## CLI

TypeScript: `rta migrate [status|up|down] [--to <id>] [--step <n>] [--json]` and
`rta seed [status|run] [--module <id>[,<id>]] [--rerun] [--json]`.

| TypeScript | Python | Go |
| --- | --- | --- |
| `migrateCommand(app, argv, out)`, `seedCommand(app, argv, secrets, out)` (`/cli`) | `rt_app.migrations.cli.migrate_command`, `seed_command`, `Migratable(store, modules, environment)` | `MigrateCommand(ctx, app, argv, out)`, `SeedCommand(…)`, `NewApp(Options)`, `RunCLI(ctx, app, args, stdout, stderr)` |
| `rta migrate …`, `rta seed …` | `python -m rt_app.migrations module:attr migrate …` / `seed …` | `RunCLI(ctx, app, os.Args[1:], os.Stdout, os.Stderr)` from the app's `main` |

Errors print the message on stderr with exit code 1; seeds read `DEMO_PASSWORD` from the
environment.

- Arguments: the action comes first; `--to`/`--step`/`--module` take a value that does not start
  with `--`; unknown flags, stray words and flags that do not apply to `status` throw the usage
  line. The runner is built before the action is checked, so a bad plan wins over a bad action.
- `--step` is JavaScript `Number()`: `""` is 0, `" 2 "` is 2, `0x1`, `0b10`, `0o7`, `1e0` and
  `.5e1` are accepted, `-0x1` and `1_0` are not; it must be an integer ≥ 0.
- Output: `Migrations (<env>):`, then `  <state padded to 8> <id>[ — description][ (appliedAt)]`,
  then `<n> pending. Run: rta migrate up` or `Up to date.`; `Applied: a, b` / `Nothing to apply.`,
  `Reverted: …` / `Nothing to revert.`; `Seeded: …` / `No pending seeds for <env>.`. Runner log
  lines are printed indented by two spaces. `--json` prints compact JSON for actions and
  `JSON.stringify(value, null, 2)` for status (fields in the TypeScript order, no escaping of
  non-ASCII, `<`, `>` or U+2028), and silences log lines.

## Known differences (outside the contract)

- A lock `expiresAt` without an offset is read as UTC in Python (JavaScript uses local time); Go
  reads RFC 3339 and date-only strings. Runners always write `Z` timestamps.
- An empty or `None`/`""` environment means `local` in Python and Go; TypeScript throws
  `Unknown environment: undefined` when `environment: undefined` is passed explicitly.
- Go's `*StepError` unwraps its cause, so a wrapped 409 renewal conflict still carries status 409
  through `apperr.As`; the TypeScript wrapper has no status.
- A Go provider override with an empty checksum inherits the migration checksum (TypeScript fails
  only for an explicit `checksum: ""`).

## Not in the contract

- `faker()` in seed contexts is TypeScript only (`@faker-js/faker`).
- The CLI guard `CONFIRM_DEMO_SEED=yes` for deployed environments belongs to the starter scripts.
