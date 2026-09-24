# @gsalgadotoledo/rt-app-deploy-railway

RT-App deploy provider for [Railway](https://railway.com). Roles: `api`, `ssr`, `database`.

```ts
import { ProviderRegistry } from "@gsalgadotoledo/rt-app-deploy";
import railway from "@gsalgadotoledo/rt-app-deploy-railway";

const registry = new ProviderRegistry().register(railway);
```

## What it creates

Everything goes through Railway's public GraphQL API (`https://backboard.railway.com/graphql/v2`).

| Remote resource | Name | Notes |
| --- | --- | --- |
| Project | `<app>-<environment>` | One project per environment, created with `defaultEnvironmentName` = the environment |
| Environment | `develop` / `stage` / `prod` | Created with `environmentCreate` if the project exists without it |
| Service (api/ssr) | `<app>-<environment>-<role>` | `serviceCreate` from `source.repository` and `source.branch`; `rootDirectory` = `source.directory` |
| Variables (api/ssr) | all `context.variables` | `variableCollectionUpsert` with `skipDeploys: true`, then one explicit deploy |
| Domain (api/ssr) | `*.up.railway.app` | `serviceDomainCreate` once; later runs reuse it and return it as `url` |
| Postgres (database) | `<app>-<environment>-database` | `ghcr.io/railwayapp-templates/postgres-ssl:<version>` (the image the Railway Postgres template uses) with a volume at `/var/lib/postgresql/data` |

Each environment has its own project, so every service has exactly one instance: branches, root
directories and variables never leak between environments.

`plan` only reads. `apply` finds resources by name and creates what is missing, so re-runs are
safe. Each run updates the service settings, upserts variables and starts a new deployment
(`serviceInstanceDeployV2`).

### Database outputs

On creation the provider generates a random password and sets `POSTGRES_*`, `PG*` and
`DATABASE_URL` (Railway reference variables). Re-runs never rotate the password. `apply` reads the
rendered service variables and returns:

- `DATABASE_URL`: private network URL (`*.railway.internal`). Only services in the same Railway
  project can reach it, which means the Railway `api`/`ssr` roles of the same environment.
- `DATABASE_PUBLIC_URL`: only when Public Access (TCP proxy) was enabled on the Postgres service in
  the Railway dashboard. Use it when the API runs on another provider.

## Credentials

| Variable | Required | Where |
| --- | --- | --- |
| `RAILWAY_API_TOKEN` | yes | Account or workspace token from <https://railway.com/account/tokens>. Project tokens don't work because they can't create projects. |
| `RAILWAY_WORKSPACE_ID` | no | Required with a workspace token. Projects are listed and created in that workspace. Without it, the provider uses your personal projects. |

## Settings

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `region` | string | workspace preference | `us-west2`, `us-east4-eqdc4a`, `europe-west4-drams3a`, `asia-southeast1-eqsg3a` |
| `healthcheckPath` | string | none | For example `/health` (api/ssr) |
| `port` | number | none | Target port of the public domain, only needed when the process doesn't listen on `$PORT` |
| `postgresVersion` | string | `17` | Major tag of the postgres-ssl image: `14` to `18` |

## Prerequisites and limits

- Install the Railway GitHub app with access to the repository. Railway builds from GitHub, so
  `source.repository` is required for api/ssr.
- A service's branch is set when the service is created. Later changes to `source.branch` are not
  synced, so change the branch in the Railway dashboard.
- The first deployment can start twice, once from `serviceCreate` and once explicitly.
- Project discovery reads the first page of `projects` as the API returns it.
- API rate limits depend on the plan (100 requests/hour on Free).
