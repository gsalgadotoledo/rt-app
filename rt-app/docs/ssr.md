# SPA, SSR and shared environment configuration

`apps/spa` is the existing React/Vite application (formerly `apps/frontend`).
`apps/ssr` is a separate Next.js App Router application. Its Home title and description
are fetched from the API and rendered into the response HTML on each request, without
waiting for browser JavaScript. Both apps reuse the authentication UI and backend
contracts. The admin edits the same Home content for both.

## Local development

```sh
npm ci
npm run dev
```

The core CLI starts API `4010`, admin `5174`, SPA `5175`, SSR `5176`, and Mailpit `8025`.
Stop them together with Ctrl+C. `npm start` starts the same local development services.
No AWS or GitHub credentials are required. The existing Node HTTP server remains the
local API entrypoint; no second backend or database is introduced by Next.js.

## One public configuration contract

`@gsalgadotoledo/rt-app-config` owns local defaults, URL validation and the allowlist passed to apps:

| Variable | Purpose |
| --- | --- |
| `RT_APP_ENVIRONMENT` | `local`, `develop`, `stage`, `prod` |
| `RT_APP_API_URL` | Node API locally, API Gateway in AWS |
| `RT_APP_ADMIN_URL` | Admin URL |
| `RT_APP_SPA_URL` | React/Vite site URL |
| `RT_APP_SSR_URL` | Next.js site URL |

The dev CLI injects local values. Terraform supplies per-environment Amplify branch
variables; the installer supplies the same values when building the SPA and admin.
Missing cloud URLs fail validation instead of silently using localhost. Vite embeds
only this public configuration; Next.js reads it on the server and passes it explicitly
to client components. Local browser requests use `/api`; server rendering calls the
absolute API URL. Cloud browsers call API Gateway with the configured CORS origins.

These are public URLs, not a global bag of secrets. Never add AWS keys, passwords,
GitHub tokens or database credentials to this contract. Backend credentials stay in
server environment variables or the existing AWS secret mechanism.

Amplify does not automatically make its build environment available to Next.js SSR.
`rta prepare-ssr` writes **only the allowlisted public values** into an
ignored `apps/ssr/.env.production` during the cloud build. No settings file needs to be
maintained in either app. Deploy again to publish changed cloud configuration.

## AWS resources and deployment

`infra/aws` composes `rt-app/packages/infra/terraform/aws/ssr`: one Amplify `WEB_COMPUTE` app and branch per
environment, plus a bounded logging service role. Existing Lambda, API Gateway,
DynamoDB, Cognito and S3/CloudFront resources remain shared with the SPA/admin as before.
Amplify gets no database credentials: SSR consumes the existing API.

The generated `https://main.<app-id>.amplifyapp.com` URL works without buying a domain
or creating Route 53 records. `develop` and `stage` use their own apps, branches and API
URLs when multi-environment is enabled. A custom domain/Route 53 can be added later.

AWS keys alone cannot authorize GitHub. For the first SSR publication:

1. Push this project to the repository configured in setup, including `apps/ssr` and the lockfile.
2. [Install the regional Amplify GitHub App](https://docs.aws.amazon.com/amplify/latest/userguide/setting-up-GitHub-access.html)
   and grant it access to that repository. Follow AWS's token requirements for SDK-based connection.
3. Export `AMPLIFY_GITHUB_TOKEN` with the setup token, alongside your existing AWS
   credentials and `ADMIN_PASSWORD`, then run `npm run setup`.
4. The installer connects the Terraform-created app through the AWS SDK and waits for
   its first build. The GitHub token is not passed into Terraform or into the frontend.
   Remove it from your shell after the repository connection succeeds.

Without that token/connection, setup can create the infrastructure and publish the
admin/SPA, but reports SSR as `awaiting_repository`. Its URL is reserved, not yet live.
Rerun setup after granting access. This is separate from optional `GH_TOKEN`, which is
used to configure GitHub Actions variables. Existing installations must rerun setup to
update their bootstrap IAM boundaries and deployment permissions for Amplify.

On `main`, `develop` or `stage`, GitHub Actions checks the code, updates infrastructure,
publishes the API/admin/SPA and then starts the matching Amplify SSR build. Native
Amplify auto-build and PR previews are disabled so they cannot race the API deployment.
The build checks the commit against the expected release SHA and fails on mismatch.
A failed SSR build fails the workflow; it does not roll back an already published API.
Keep API changes backward compatible across releases.

Next.js is pinned to the patched 15.5 line supported by the documented Amplify Hosting
runtime. PostCSS is overridden to a patched compatible 8.x version. This setup does not
claim support for every Next.js feature; see [Amplify's feature support](https://docs.aws.amazon.com/amplify/latest/userguide/ssr-amplify-support.html).
Amplify builds and SSR requests add hosting charges beyond the existing static SPA.

Development writes to `apps/ssr/.next-dev`; production builds and Amplify keep `apps/ssr/.next`. This allows a build or test run while the local Next.js server is running without overwriting its modules.
