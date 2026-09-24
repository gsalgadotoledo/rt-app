# Installation operations

Follow the environment-variable commands and IAM setup in [starter README](../../templates/hello-world/README.md).
The wizard reads AWS credentials from the standard SDK credential chain; it never
accepts access keys, an admin email or a new admin password in its settings forms.
`ADMIN_PASSWORD` is required to sign in to the local installer and publish the root verifier.

## Resources and persistence

`infra/aws/main.tf` defines the application table and composes the API, public site
and admin hosting. Reusable resource implementations remain in `rt-app/packages/infra/terraform/aws`
and `rt-app/packages/infra/terraform/aws/admin`. There is **one DynamoDB table per environment**, for
application data. The admin has no user table, migration or database connection.
The API uses the application table when the root views or changes application data.
Cognito owns cloud credentials/MFA; DynamoDB keeps profiles and permissions.
See [authentication adapters](authentication.md) before upgrading existing users.

Bootstrap creates a private, encrypted, versioned state bucket and branch-bound GitHub
OIDC deployment roles. Each environment gets Lambda/API Gateway, S3/CloudFront for both
frontends, logs and Secrets Manager. S3 stays private; use the returned CloudFront HTTPS
URL rather than a public S3 website endpoint. No domain configuration is needed.
SES sender verification remains a prerequisite; application email uses the Lambda role.

The installer checks STS identity, generates saved Terraform plans and applies them
only after the wizard confirmation. The wizard shows resource categories, not the full
Terraform diff. CloudFront deployment can take several minutes.

Installation writes `.rt-app/installation.json` with URLs and GitHub variables, never
passwords. `.rt-app/identity.json` binds this working copy to account, region, app and repo.
Preserve this file and `.rt-app/bootstrap.tfstate` securely. Environment states live in S3
with native locking. Do not commit state, plans, logs or secret values. An error log
may be written to `.rt-app/last-command.log` with restricted file permissions.

## Root password and sessions

The installer derives a salted scrypt verifier from `ADMIN_PASSWORD` and writes it to
Secrets Manager after Terraform creates the secret container. The verifier is not put
in Terraform state. The password and verifier are excluded from the published frontend assets; the installer also strips them from its child build environment.
Lambda reads secrets server-side. CI preserves the existing verifier without a root
password in GitHub. The same configured password initially protects all selected environments.

Root sessions are signed JWTs with a 15-minute lifetime and a distinct issuer/audience
from application users. Signing out removes the token from the browser; it does not
revoke an already copied token. Login throttling is per process and API Gateway adds
request throttling, not a distributed lockout. Use a strong, unique password.

There is no admin password-reset email or user-management feature. To change a lost/root
password, use authorized AWS installation credentials and rerun the terminal installer
with a new `ADMIN_PASSWORD` (same application configuration and state). Recycle/redeploy
Lambda execution environments after rotation: loaded signing material is cached for
the lifetime of each process. Do not assume existing warm environments have refreshed it.

For terminal installation, create a non-secret JSON config containing `provider: "aws"`,
`region`, `stack`, `mailFrom`, `repository`, and optional `multiEnvironment: true`, then run:

```sh
npm run setup:terminal -- config.json --confirm rt-app-hello
```

## Local and remote access

`rta dev` runs the local backend, admin and application frontend together. The default
NoSQL adapter persists application data in `.rt-app/local.json`. The local admin opens without a password and owns no database. Remote administration
requires a root password supplied through the environment. Local never switches to
production automatically. Use the published environment's CloudFront URL to work with
its remote data. JSON and DynamoDB implement the same storage contract; changing the
adapter does not transfer existing data.

`rta install` explicitly opens the installer, including on subsequent runs to expand
the installation. Default is production only. `--multi-environment` enables develop,
stage and prod. Rerunning with all three preserves production's state key. The host
rejects shrinking an already expanded installation to avoid deleting deployment roles.
If upgrading an older deployed `dev`/`prod` naming layout, plan a state/data migration;
`moved.tf` changes addresses but cannot rename DynamoDB tables. Never remove state files
to work around this check or Terraform's prevent-destroy protection.

The JSON adapter locks per file, checks transaction versions and atomically replaces
the snapshot. It loads the entire file for every operation: use only for small local
datasets, never Lambda, shared network storage or production. An interrupted process
can leave a `.lock` file; stop all writers before removing that stale lock. Local
application JWTs retain their normal 15-minute validity across restarts with the same key.
Admin sessions still use a verifier derived at startup and require signing in again. JSON files contain application data
and must stay outside Git. `RT_APP_JSON_FILE` can select an independent local dataset.
`RT_APP_MODE=memory` and `dynamodb-local` remain explicit test alternatives.

## CI/CD and upgrades

The optional `GH_TOKEN` needs Variables:write for the configured repository. Otherwise
copy `AWS_REGION`, `RT_APP_NAME`, `TF_STATE_BUCKET`, `MAIL_FROM`, `RT_APP_MULTI_ENVIRONMENT`, and
`AWS_ROLE_PROD` (plus `AWS_ROLE_DEVELOP` and `AWS_ROLE_STAGE` in multi-environment mode) from the saved installation result into repository Actions variables.
The installer does not create or push a GitHub repository.

PRs run checks only. Main deploys prod. Develop and stage deploy their respective environments only when
`RT_APP_MULTI_ENVIRONMENT=true`. Roles use OIDC
trust pinned to the exact repository and branch. Adding a GitHub job environment changes
that trust subject and requires updating IAM. Protect branches with required checks.

API Gateway/CloudFront provisioning permissions are broader than environment resource
names; use separate AWS accounts for strong isolation. Terraform locks protect apply,
not the entire publish sequence: do not run the wizard and CI concurrently.

Lambda versions and per-revision assets are retained. This is not automatic rollback.
The live alias changes before migrations, so changes must use compatible expand/contract
migrations. A failed publication can be retried. `moved.tf` preserves earlier resource
addresses. For the previous admin-table design, the removed block forgets the table
without deleting its data; review and remove that legacy table separately if applicable.
No real AWS deployment has been performed during this implementation.

The starter also provisions Amplify Hosting for `apps/ssr`. The installation identity
and bootstrap policies include Amplify app/branch/build permissions and a bounded
logging service role. See [SSR setup](ssr.md) for the one-time GitHub authorization,
environment URL injection and CI build ordering.
