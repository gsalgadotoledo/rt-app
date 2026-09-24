# @gsalgadotoledo/rt-app-migrations

Module-owned, engine-agnostic migrations and seeds for RT-App, built on [Umzug](https://github.com/sequelize/umzug).

```ts
import { MigrationRunner, SeedRunner } from "@gsalgadotoledo/rt-app-migrations";

await new MigrationRunner({ store, features, environment: "stage" }).up();
await new SeedRunner({ store, features, environment: "stage", secrets: { DEMO_PASSWORD } }).run();
```

Applications normally use `app.migrate()`, `app.migrations()`, `app.seeds()` and the `rta migrate` / `rta seed` commands. Guarantees, rules and examples: `docs/migrations.md` in `@gsalgadotoledo/rt-app-framework`.
