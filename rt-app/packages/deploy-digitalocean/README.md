# @gsalgadotoledo/rt-app-deploy-digitalocean

RT-App deploy provider for [DigitalOcean App Platform](https://www.digitalocean.com/products/app-platform).
Roles: `api`, `ssr`, `frontend`.

Each role is one app named `<app>-<environment>-<role>` (at most 32 characters) with one component
named after the role, built from GitHub (`github.repo`, `branch`, `source_dir`, `deploy_on_push: false`):

| Role | Component |
| --- | --- |
| `api`, `ssr` | `services[]` with `build_command`, `run_command`, `http_port`, `instance_size_slug` |
| `frontend` | `static_sites[]` with `output_dir` and `catchall_document: index.html` (SPA fallback) |

Every runtime variable becomes an env var with `type: SECRET` (`RUN_AND_BUILD_TIME` for services,
`BUILD_TIME` for static sites). App Platform adds `PORT` = `http_port` itself. An ingress rule routes `/`
to the component. `plan` only reads (`GET /v2/apps`, paginated). `apply` creates (`POST /v2/apps`) or
updates the spec (`PUT /v2/apps/{id}` with `update_all_source_versions: true`, preserving domains and
other components) and creates a deployment (`POST /v2/apps/{id}/deployments`) only when the update did
not queue one. `status` reads the app's in-progress/pending deployment, then the latest deployment phase.

## Credentials

| Key | Required | Notes |
| --- | --- | --- |
| `DIGITALOCEAN_TOKEN` | yes | Personal access token with app read/write scopes: <https://cloud.digitalocean.com/account/api/tokens> |

## Settings

| Key | Default | Options |
| --- | --- | --- |
| `region` | `nyc` | `nyc`, `sfo`, `tor`, `atl`, `ams`, `fra`, `lon`, `blr`, `sgp`, `syd` (kept from the existing app on update) |
| `instanceSize` | `apps-s-1vcpu-0.5gb` | App Platform instance size slugs (services only) |
| `port` | `8080` | Port the process listens on (services only) |

## Known limits

- DigitalOcean's GitHub app must be installed with access to the repository.
- The role's component env list is replaced on every apply; other components keep theirs.
- Static sites only receive variables at build time; anything referenced by the bundle becomes public.
- The build environment is auto-detected (no `environment_slug` is sent).
