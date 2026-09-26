# infra/stripe — subscription plans in Stripe

Creates one Stripe product and one recurring price for each paid, enabled plan of the
subscriptions module. Free and disabled plans are skipped.

1. `npm run build && npm run stripe:plans` writes `plans.auto.tfvars.json` from the current plans.
2. Set the Stripe key: use `stripe_api_key` (Service Manager → Terraform → Variables) or
   `STRIPE_API_KEY` under Global variables. Start with a test key (`sk_test_…`).
   Get it from https://dashboard.stripe.com/apikeys.
3. Run Init, then Plan. Review the plan and run Apply.
4. `npm run stripe:link` stores the product and price ids in the plans. The app then charges with these prices.

Without the Service Manager, run the same steps in this folder:
`terraform init && terraform plan -out=stripe.tfplan && terraform apply stripe.tfplan`

- `periodDays` maps to Stripe intervals: 365 or more is yearly, 28–31 is monthly, a multiple of 30 is every N months, a multiple of 7 is every N weeks, and anything else is every N days.
- Prices are immutable in Stripe. A new amount, currency or period creates a new price. Run `stripe:link` again after that apply.
- State is kept locally in `terraform.tfstate`, which git ignores. For a team, add a remote backend such as the S3 backend used in `infra/aws`.
- To run the tests without Stripe, use `terraform test`. It uses a mock provider.
