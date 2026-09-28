# Terraform

Projects keep infrastructure as Terraform stacks. A stack is any folder with `.tf` files. By
convention these live under `infra/`, for example `infra/aws` (the AWS deployment) and
`infra/stripe` (subscription plans in Stripe).

## Service Manager → Terraform

The panel scans every project you know (the ones you opened and the ones in your workspace folder)
and lists their stacks, with `infra/` stacks first. For each stack you can do the following:

| Button | Runs | Use |
| --- | --- | --- |
| Init | `terraform init -input=false` | Downloads providers. Run it first, and again after changing versions. |
| Format check | `terraform fmt -check -recursive -diff` | Lint. |
| Validate | `terraform validate` | Checks syntax and references. |
| Test | `terraform test` | Runs the unit tests in `*.tftest.hcl` (mock providers). |
| Plan | `terraform plan -out=<saved plan>` | Shows what would change. |
| Apply… | `terraform apply <saved plan>` | Applies exactly the last successful plan, after you confirm. The plan is used up. |

- **Variables:** a modal lists every `variable` of the stack. Each one shows its description, type,
  and whether it is required or secret. Links in the description open in the browser, so write
  descriptions such as `Find it at https://…`. Values go to Terraform as `TF_VAR_<name>`.
- **Global variables:** these are shared by every run. Examples are `AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `STRIPE_API_KEY` and `CLOUDFLARE_API_TOKEN`, and you can
  add your own names. Each one has a link to where you get it.
- **Where values live:** only on your computer, in `~/.rt-app/service-manager/terraform` (mode
  0600), and never in the project. Secrets are never shown again, and they are replaced with
  `[redacted]` in the output.
- **History:** the last 50 runs of each stack are kept with their output. Errors are listed with
  their file and line.
- **Saved plans:** kept in the manager folder, not in the project, because plans can contain secret
  values.

Terraform itself (1.11 or newer) can be installed from **Add tools & services → Terraform**. It is
the official HashiCorp release, checked against its SHA256SUMS.

## Stripe plans

`infra/stripe` turns the plans of the subscriptions module into Stripe products and recurring prices:

```
npm run build && npm run stripe:plans   # plans → infra/stripe/plans.auto.tfvars.json
# Service Manager → Terraform → infra/stripe: Variables (Stripe key) → Init → Plan → Apply…
npm run stripe:link                     # store the product/price ids in the plans
```

`stripe:link` calls `subscriptions.linkStripePrices()`, which records the ids without changing the
plan versions and writes an entry to the audit log. See `infra/stripe/README.md`.

## AWS environments: create, protect, destroy

Each environment (`develop`, `stage`, `prod`) is one state (`<environment>/terraform.tfstate` in
the bootstrap's state bucket) of `infra/aws`. Terraform cannot parametrize `prevent_destroy`, so
the modules use the AWS protections instead, driven by one variable, **`protect`** (default
`true`):

| Resource | `protect = true` | `protect = false` |
| --- | --- | --- |
| DynamoDB application table | `deletion_protection_enabled = true` | off |
| Cognito user pool | `deletion_protection = "ACTIVE"` | `"INACTIVE"` |
| S3 site buckets (admin, public) | kept on destroy (a non-empty bucket cannot be deleted) | `force_destroy`: emptied, all versions |
| Secrets (JWT, admin password, AWS, Stripe) | 30-day recovery window | deleted immediately, so the names can be reused |
| Destroy guard (`terraform_data.protect`) | `terraform destroy` fails **before deleting anything** | passes |

Point-in-time recovery, encryption and bucket versioning stay on either way. The bootstrap's
state bucket keeps `prevent_destroy`: it belongs to the account, not to an environment.

`protect` and the custom domains below can be set per environment in a committed file,
`infra/aws/environments/<environment>.json` (see `prod.json.example`); a variable that is set
(`TF_VAR_protect`, `-var`) wins over the file. Unknown keys fail the plan.

**Create** an environment: push its branch, or `gh workflow run deploy.yml --ref <branch>`
(`main` = prod, `develop`, `stage`; the latter two need `RT_APP_MULTI_ENVIRONMENT=true`).

**Destroy** an environment, prod included, with one command:

```sh
gh workflow run destroy.yml --ref develop -f confirm=<RT_APP_NAME>-develop
gh workflow run destroy.yml --ref main    -f confirm=<RT_APP_NAME>        # production
```

The workflow checks the confirmation, applies with `protect = false` (lifting the protections
above) and then runs `terraform destroy`. It deletes the environment's data: take a DynamoDB
backup first if you need one (point-in-time recovery ends with the table). By hand it is the same
two steps, with the environment's backend configured as in `deploy.yml`:

```sh
export TF_VAR_protect=false
terraform -chdir=infra/aws apply     # lift the protections (the guard now passes)
terraform -chdir=infra/aws destroy
```

`terraform destroy -var protect=false` alone is not enough: the protections live in AWS and in
state, so they must be applied first. A protected environment answers `This environment is
protected` and nothing is deleted. After a destroy, deploying again creates a fresh environment
(new Cognito pool, empty table, new CloudFront and Amplify URLs unless custom domains are set).
GitLab has no destroy job: run the two commands above with the environment's role.

## The app's own variables for the API (optional)

The `runtime` module passes `extra_environment` (a map) to the API Lambda, and lets it read the
Secrets Manager ARNs in `extra_secret_arns`: an app module that calls a service of its own gets its
URL and its key that way. A secret never goes in `extra_environment` (a name ending in `KEY`,
`SECRET`, `PASSWORD` or `TOKEN` is refused): pass `<NAME>_SECRET_ARN` and list the ARN. The core's
own variables win on a clash. Both default to empty.

## Custom domains (optional)

Unset, every role keeps its AWS URL. Each variable is optional and can live in
`environments/<environment>.json`:

| Starter variable | Module input | Effect |
| --- | --- | --- |
| `public_domain`, `admin_domain` | `site`/`admin`: `domain` | CloudFront `aliases`, TLS 1.2 SNI certificate; output `url` becomes `https://<domain>` |
| `certificate_arn` | `site`/`admin`: `certificate_arn` | ACM certificate **in us-east-1** covering both site domains (CloudFront reads only that region) |
| `api_domain` | `runtime`: `domain` | API Gateway regional custom domain + mapping to the `$default` stage; `ApiUrl` becomes `https://<domain>` |
| `api_certificate_arn` | `runtime`: `certificate_arn` | ACM certificate **in the deployment region** |
| `ssr_domain`, `ssr_domain_prefix` | `ssr`: `domain`, `domain_prefix` | `aws_amplify_domain_association`; Amplify issues the certificate; URL `https://[prefix.]domain` |
| `zone_id` | all: `zone_id` | Route53 zone in this account: A/AAAA aliases for the sites, A alias for the API, Amplify writes its own records (Terraform waits for verification) |

Without `zone_id`, create the DNS records at your provider: a CNAME from each site domain to the
host of its `cloudfront_url` (an apex domain needs your provider's ALIAS/flattening), from the API
domain to `api.dns_target` (runtime output), and the SSR records in the `ssr` module's
`dns_records` output (Amplify then verifies on its own). CORS accepts both the
custom and the AWS URLs. A domain can belong to one Amplify app only: give each environment its
own (`example.com` for prod, `stage.example.com` for stage). ACM certificates are not created by
these modules: request and validate them once per account.

The deploy roles can read ACM certificates and manage Amplify domain associations. For Route53,
list the zones in the bootstrap variable `route53_zone_ids` (the deploy roles get record access to
those zones only): `TF_VAR_route53_zone_ids='["Z0123…"]'` when rerunning the installer, or
`"route53_zone_ids": [...]` in `.rt-app/aws-access.tfvars.json` before `aws-access --apply`. The
installer policy (`terraform/aws/data/installer-policy.json`) already includes these actions.
