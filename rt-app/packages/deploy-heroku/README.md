# @gsalgadotoledo/rt-app-deploy-heroku

RT-App deploy provider for [Heroku](https://www.heroku.com). Role: `api`.

The app `<app>-<environment>-api` (at most 30 characters) is created personally, or in `HEROKU_TEAM`
(`POST /teams/apps`). Runtime variables are set as config vars (`PATCH /apps/{app}/config-vars`, which
merges). The source is built with the Build API (`POST /apps/{app}/builds`) from the GitHub tarball of
the branch: RT-App asks `https://api.github.com/repos/{owner}/{repo}/tarball/{branch}` with
`redirect: "manual"` and hands the temporary `Location` URL to Heroku. `plan` only reads
(`GET /apps/{name}`); `status` maps the latest build (`Range: started_at ..; order=desc,max=1;`).

## Credentials

| Key | Required | Notes |
| --- | --- | --- |
| `HEROKU_API_KEY` | yes | Account → API Key, or a long-lived token from `heroku authorizations:create`: <https://dashboard.heroku.com/account/applications> |
| `HEROKU_TEAM` | no | Team name; apps are personal when absent. |
| `GITHUB_TOKEN` | no | Fine-grained token with *Contents: read* for private repositories: <https://github.com/settings/personal-access-tokens> |

## Settings

| Key | Default | Options |
| --- | --- | --- |
| `region` | `us` | `us`, `eu` (Common Runtime, fixed at creation) |

## Known limits

- Only the `api` role. The start command comes from a `Procfile` in the app folder (or the buildpack
  default, e.g. `npm start`); `source.startCommand` cannot be set through the API.
- Monorepo folders (`source.directory` other than `.`) use the community buildpack
  `lstoll/heroku-buildpack-monorepo` with the `APP_BASE` config var, followed by `heroku/nodejs`,
  `heroku/python` or `heroku/go`.
- Dyno size and count are not managed; change them in Heroku. Eco dynos sleep after 30 minutes without traffic.
- Config vars are merged, never removed. The temporary tarball URL of a private repository is treated as a secret.
