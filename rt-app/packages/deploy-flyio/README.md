# @gsalgadotoledo/rt-app-deploy-flyio

RT-App deploy provider for [Fly.io](https://fly.io). Role: `api`.

```ts
import { ProviderRegistry } from "@gsalgadotoledo/rt-app-deploy";
import flyio, { createFlyProvider } from "@gsalgadotoledo/rt-app-deploy-flyio";

const registry = new ProviderRegistry().register(flyio);
// or: createFlyProvider({ root: "/path/to/checkout", run: customRunner })
```

## How it deploys

1. `flyctl version`: fails early with "Install flyctl: https://fly.io/docs/flyctl/install/".
2. Machines API `GET /v1/apps/{app}` and, if missing, `POST /v1/apps {app_name, org_slug}`
   (`https://api.machines.dev`).
3. `flyctl secrets import --app <app> --stage` sets every `context.variables` entry. Values are
   written to stdin, never to argv.
4. `flyctl deploy <source.directory> --app <app> --config <tmp>/fly.toml --remote-only --yes
   [--dockerfile <dir>/Dockerfile] [--ha=false]`. The image is built on Fly's remote builder, and
   first deploys allocate public IPs.
5. The result `url` is `https://<app>.fly.dev`.

`FLY_API_TOKEN` is only passed in the child process environment (`NO_COLOR=1` is also set). It is
never passed on the command line. Errors and logs are redacted.

The generated `fly.toml` sets `app`, `primary_region`, `[env] PORT` (unless `PORT` is already a
variable) and `[http_service]` with `internal_port`, `force_https = true`, `auto_stop_machines`,
`auto_start_machines` and `min_machines_running = 0`. It lives in a temporary folder that is
removed afterwards.

`status` lists Machines (`GET /v1/apps/{app}/machines`):

- `started`: live
- `stopped` or `suspended`: live, because Fly starts them on the next request
- transitions: deploying
- all `failed` or `launch_failed`: failed
- no app: missing

## Credentials

| Variable | Where |
| --- | --- |
| `FLY_API_TOKEN` | Org token: `fly tokens create org` (see <https://fly.io/docs/security/tokens/>). A deploy token can't create apps. |

## Settings

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `org` | string | `personal` | Organization slug |
| `region` | string | `iad` | Fly region ID (`ams`, `fra`, `lhr`, `ord`, `sjc`, `sin`, `syd`…) |
| `appName` | string | `<app>-<environment>-api` | Fly app names are global; set this if the default is taken (422) |
| `port` | number | `PORT` variable or `8080` | `internal_port` |
| `autoStop` | string | `stop` | `off`, `stop` or `suspend` |
| `ha` | boolean | `true` | `false` passes `--ha=false` (one Machine) |
| `builder` | string | none | Cloud Native Buildpacks builder, e.g. `paketobuildpacks/builder-jammy-base`, for folders without a Dockerfile |

## Prerequisites and limits

- Install [flyctl](https://fly.io/docs/flyctl/install/) on the machine that deploys (CI:
  `superfly/flyctl-actions/setup-flyctl`).
- `source.directory` is resolved against the local checkout: `process.cwd()` by default, or the
  `root` factory option.
- The service folder needs a `Dockerfile`, or the `builder` setting for buildpacks. When a
  Dockerfile is used, `source.buildCommand` and `source.startCommand` are ignored because the
  Dockerfile defines them.
- Some secret values can't be passed safely through `flyctl secrets import`: values containing
  `"""` or `\r`, lines over 60k characters, or a `#` that flyctl would read as a comment. The
  provider rejects them by name. Set those secrets in the dashboard.
