# @gsalgadotoledo/rt-app-deploy-vercel

RT-App deploy provider for [Vercel](https://vercel.com). Roles:

- `ssr` — Next.js project (`framework: "nextjs"`).
- `frontend` — static SPA/admin (no framework preset, `outputDirectory` = `source.outputDirectory`).

One Vercel project per `<app>-<environment>-<role>`, connected to `source.repository` (GitHub,
`owner/name`) with `rootDirectory` = `source.directory`.

`apply`:
1. finds the project by name (`GET /v9/projects/{name}`), creates it (`POST /v11/projects`) or updates its build settings (`PATCH /v9/projects/{id}`);
2. upserts every runtime variable as an **encrypted** env var (`POST /v10/projects/{id}/env?upsert=true`):
   `prod` → `production`; `stage`/`develop` → `preview` scoped to `source.branch` (`gitBranch`);
3. creates a git deployment of `source.branch` (`POST /v13/deployments`, `target: "production"` for prod) and returns its URL.

`status` reads the latest deployment (`GET /v7/deployments`, production target for prod, branch otherwise):
`READY` → live, `QUEUED/INITIALIZING/BUILDING` → deploying, `ERROR/CANCELED/BLOCKED` → failed.

## Credentials

| Key | Required | Where |
| --- | --- | --- |
| `VERCEL_TOKEN` | yes | https://vercel.com/account/settings/tokens |
| `VERCEL_TEAM_ID` | team projects | Team settings → General (sent as `?teamId=`) |

## Settings

| Key | Default | Notes |
| --- | --- | --- |
| `functionRegion` | `iad1` | SSR function region (`serverlessFunctionRegion`); put it next to the database. |
| `sensitiveVariables` | `false` | Store variables as `sensitive` (not readable in the dashboard) instead of `encrypted`. |

## Limits

- The Vercel GitHub app must have access to the repository, otherwise project creation fails.
- Preview variables cannot use the project's production branch as `gitBranch`; use a separate branch for stage/develop.
- Variables that exist in Vercel but not in RT-App are left untouched (never deleted).
- The returned URL is the deployment URL; production custom domains are managed in Vercel.

API reference: https://vercel.com/docs/rest-api
