# Deploying an application

Each part of an application is a **role**. Each role can run on a different provider, per environment:

| Role | Providers |
| --- | --- |
| api (the starter server, portable mode) | AWS Lambda, Render, Railway, Fly.io, DigitalOcean App Platform, Heroku |
| ssr (Next.js) | AWS Amplify, Vercel, Render, Railway, DigitalOcean |
| frontend (static SPA) | AWS S3 + CloudFront, Vercel, Render, DigitalOcean |
| files | AWS S3 |
| database | DynamoDB (AWS), Postgres on Neon, Supabase or Railway |

The choice lives in `rt-app.settings.json → deploy` (committed, no secrets):

```json
"deploy": { "environments": {
  "stage": { "database": { "provider": "neon" }, "api": { "provider": "render", "settings": { "region": "oregon" } }, "ssr": { "provider": "vercel" } },
  "prod":  { "api": { "provider": "aws" }, "frontend": { "provider": "aws" } }
} }
```

## Configure

**Admin → Deployments.** Available while the project runs locally (`npm run dev`). From there you:
- choose a provider per role;
- paste the API keys each provider needs (with links to create them);
- generate `JWT_SECRET`;
- set the admin password (stored as a hash), `MAIL_FROM` and `SMTP_URL`;
- plan, apply, check status and sync to GitHub.

The same from a terminal:

```sh
rta deploy providers
pbpaste | rta deploy credentials set --env stage RENDER_API_KEY
rta deploy plan --env stage          # read-only: what would be created or updated
rta deploy apply --env stage         # database → files → api → ssr → frontend
rta deploy status --env stage
rta github connect                   # create the private repo and push
rta github sync                      # environments develop/stage/prod + secrets
```

Keys are kept in `.rt-app/credentials.json` (mode 0600, never committed) and pushed as **GitHub environment secrets**. On every merge into `develop`, `stage` or `main`, the workflow deploys that environment:
- provider roles run when the repository variable `RT_APP_PROVIDERS_ENABLED=true` is set;
- AWS roles run through Terraform as before (`RT_APP_DEPLOY_ENABLED=true`).

## Guarantees

- **Order and inputs.** Roles deploy in order. Outputs feed later roles: the database's `DATABASE_URL` goes to the API, and the API URL goes to the SSR and the frontend.
- **Secrets stay in the API.** Only the API receives secrets. The SSR and the static frontend only receive public values (URLs, environment name), so a secret can never end up in a browser bundle.
- **Safe plans.** `plan` only reads. `apply` looks up resources by name (`<app>-<environment>-<role>`) and is safe to run again.
- **No leaks.** Errors never include credentials or runtime secrets. The admin never returns their values; it only shows whether they are set.
- **Migrations in portable mode.** The portable API applies pending migrations before it starts serving. The migration lock allows several instances.

## Portable runtime

Outside AWS, the API runs as `RT_APP_TARGET=portable` and needs these variables, which the providers set from GitHub secrets and the database role:
- `DATABASE_URL`: Postgres, TLS verified;
- `JWT_SECRET`;
- `ADMIN_PASSWORD_VERIFIER`;
- `MAIL_FROM`;
- `SMTP_URL`: `smtps://` or `smtp://` with STARTTLS required.

Locally, `RT_APP_MODE=postgres` with a loopback `DATABASE_URL` uses the Postgres the Service Manager installs.

## Known limits (need a live check with your accounts)

- **Railway.** Its Postgres URL is private to the Railway project. An API on another provider needs Public Access enabled in Railway.
- **Fly.io.** Deploys with `flyctl` (the Service Manager installs it) and needs a Dockerfile, or the `builder` setting for buildpacks.
- **Heroku.** Builds from the GitHub tarball. The start command comes from a `Procfile`.
- **Vercel, Render, DigitalOcean.** Their GitHub apps must already have access to the repository.
- Every provider is tested against recorded API requests verified with the official documentation. Run `rta deploy plan` against a real account before relying on it in production.
