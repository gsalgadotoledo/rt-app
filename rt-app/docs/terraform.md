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
