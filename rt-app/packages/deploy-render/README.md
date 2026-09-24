# @gsalgadotoledo/rt-app-deploy-render

RT-App deploy provider for [Render](https://render.com). Roles: `api`, `ssr`, `frontend`.

| Role | Render resource |
| --- | --- |
| `api` | Web service (native runtime `node`, `python` or `go`) built from GitHub |
| `ssr` | Web service, `node` runtime |
| `frontend` | Static site (`buildCommand` + `publishPath` = `source.outputDirectory`, default `dist`) |

Resources are named `<app>-<environment>-<role>`. `plan` only reads (`GET /services?name=…&type=…`).
`apply` creates the service (`POST /services`, which also starts the first deploy) or updates it
(`PATCH /services/{id}`, `PUT /services/{id}/env-vars`, `POST /services/{id}/deploys`). Re-running is
safe: the service is found by name and never duplicated. `status` maps the latest deploy.

## Credentials

| Key | Required | Notes |
| --- | --- | --- |
| `RENDER_API_KEY` | yes | Create it in Account Settings → API Keys: <https://dashboard.render.com/u/settings?add-api-key> |
| `RENDER_OWNER_ID` | no | Workspace id (`tea-…`/`usr-…`). Required when the key can access more than one workspace. |

## Settings

| Key | Default | Options |
| --- | --- | --- |
| `region` | `oregon` | `oregon`, `ohio`, `virginia`, `frankfurt`, `singapore` (fixed at creation) |
| `plan` | `starter` | `free`, `starter`, `standard`, `pro`, `pro_plus`, `pro_max`, `pro_ultra` (web services) |
| `healthCheckPath` | none | e.g. `/health` |

## Known limits

- The GitHub repository must be connected to your Render account (Render's GitHub app).
- Free instances spin down after 15 minutes without traffic; the next request wakes them slowly.
- `PUT /env-vars` replaces the whole list: variables not provided by RT-App are removed.
- `autoDeploy` is set to `no`; RT-App triggers deploys. Region cannot be changed after creation.
- Static-site SPA rewrites (`/* → /index.html`) are not configured; add a rewrite rule in Render if needed.
- Default commands when the app does not provide them: node `npm install && npm run build --if-present` / `npm start`,
  python `pip install -r requirements.txt` / `python main.py`, go `go build -o app .` / `./app`.
