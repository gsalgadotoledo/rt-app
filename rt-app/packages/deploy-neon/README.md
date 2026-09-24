# @gsalgadotoledo/rt-app-deploy-neon

RT-App deploy provider for [Neon](https://neon.com) serverless Postgres (`database` role).

One Neon project per `<app>-<environment>-database`. `apply` creates it when missing
(`POST /projects` with `name`, `region_id`, `pg_version`, optional `org_id`) and returns
`outputs.DATABASE_URL` from `GET /projects/{id}/connection_uri` for the default branch, its first
database and owner role.

**Which URL:** the **pooled** URI (PgBouncer, `-pooler` host, transaction mode) by default — right for
serverless and many short connections. Set `pooled: false` for the direct URI (session features,
some migration tools). The URL contains the password: it is a secret and is never logged.

`status`: missing project → `missing`; running/scheduled operations → `deploying`; otherwise `live`
(computes may be idle/scaled to zero and wake on connect).

## Credentials

| Key | Required | Where |
| --- | --- | --- |
| `NEON_API_KEY` | yes | https://console.neon.tech/app/settings/api-keys (personal or organization key) |
| `NEON_ORG_ID` | no | Organization settings (`org-…`); filters the search and owns new projects |

## Settings

| Key | Default | Options |
| --- | --- | --- |
| `region` | `aws-us-east-1` | aws-us-east-1, aws-us-east-2, aws-us-west-2, aws-eu-central-1, aws-eu-west-2, aws-ap-southeast-1, aws-ap-southeast-2, aws-sa-east-1 |
| `pgVersion` | `17` | 14–18 |
| `pooled` | `true` | pooled vs direct `DATABASE_URL` |

## Limits

- Region and Postgres version are fixed at creation; changing the settings later does not migrate.
- Free plan project limits apply; creation fails with a (redacted) provider error when exceeded.
- Existing projects are never modified (`plan` reports `noop`).

API reference: https://api-docs.neon.tech/reference/getting-started-with-neon-api
