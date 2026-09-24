# @gsalgadotoledo/rt-app-deploy-supabase

RT-App deploy provider for [Supabase](https://supabase.com) Postgres (`database` role).

One Supabase project per `<app>-<environment>-database` in your organization. `apply` creates it
when missing (`POST /v1/projects` with `name`, `organization_slug`, `db_pass`, `region_selection`),
polls `GET /v1/projects/{ref}` until `ACTIVE_HEALTHY` (new projects take a few minutes), then returns
`outputs.DATABASE_URL`.

**Which URL:** by default the shared pooler (Supavisor) URL built from
`GET /v1/projects/{ref}/config/database/pooler` (primary database, transaction mode preferred →
`postgresql://postgres.<ref>:<password>@<pooler-host>:6543/postgres`). It is IPv4 and recommended for
serverless; transaction mode does not support prepared statements. With `connection: "direct"` (or
when no pooler config is returned) it is `postgresql://postgres:<password>@db.<ref>.supabase.co:5432/postgres`
(IPv6 unless the IPv4 add-on is enabled). The URL is a secret and is never logged.

`status`: `ACTIVE_HEALTHY` → live; `COMING_UP/RESTORING/UPGRADING/RESTARTING/RESIZING` → deploying;
`*_FAILED/ACTIVE_UNHEALTHY` → failed; paused or other → unknown; not found → missing.

## Credentials

| Key | Where |
| --- | --- |
| `SUPABASE_ACCESS_TOKEN` | https://supabase.com/dashboard/account/tokens |
| `SUPABASE_ORG_ID` | Organization **slug**: Organization settings → General (the API's `organization_slug`) |
| `SUPABASE_DB_PASSWORD` | You choose it. Supabase cannot return an existing password, so it must match the project's password |

## Settings

| Key | Default | Notes |
| --- | --- | --- |
| `region` | `us-east-1` | Any Supabase region code (us-east-1 … ap-northeast-2) |
| `connection` | `pooler` | `pooler` or `direct` |
| `waitTimeoutSeconds` | `600` | Max total wait for a healthy project |
| `pollIntervalSeconds` | `10` | Delay between status checks |

## Limits

- Free organizations allow two active projects; free projects pause after inactivity — `apply` fails
  fast on paused projects (restore them in the dashboard).
- Rotating the password in the dashboard requires updating `SUPABASE_DB_PASSWORD`.
- Region is fixed at creation. Existing projects are never modified (`plan` reports `noop`).

API reference: https://supabase.com/docs/reference/api
