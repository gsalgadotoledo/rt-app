# AWS monitoring and emergency controls

Open **Admin → AWS**. Credentials are read exclusively by the backend through the standard AWS credential chain (`AWS_PROFILE`, a temporary session, or the Lambda execution role). Never enter root access keys into the application.

The dashboard shows daily month-to-date costs, service totals, usage-type details, and available resource-level costs for the last 14 days. These are estimated AWS Cost Explorer reports, not a real-time meter: AWS normally updates billing at least daily. Enable Cost Explorer and resource-level data in AWS first; resource data may take 48 hours to become available. Cost Explorer API calls can themselves incur charges. Reports are cached for six hours; regional tagged-resource inventory is cached for five minutes. Untagged resources and resources in other regions are not a complete account inventory. A failed report is shown as an error, never as a zero bill.

## Emergency brake

Set `RT_APP_AWS_APP` to the application's Terraform name (for example `rt-app-hello`). Only resources with that exact `Application` tag, in the caller's account, are eligible. The operator must confirm the resource ARN before the backend performs an action. A persistent, single-use plan records the original state and prevents duplicate operations.

- Lambda: set reserved concurrency to zero; resume restores the recorded concurrency. In-flight work and other resources can still incur charges. Use the **local admin** to pause the Lambda hosting the remote admin: the remote admin refuses to disable itself.
- EC2: stop/start an instance. Attached storage still incurs charges.
- RDS: stop/start a standalone DB instance. Storage and backups remain billable; AWS automatically restarts it after seven days. Cluster databases are not supported.
- DynamoDB, S3, API Gateway and other services do not have a generic safe pause button. This module does not delete them.

An uncertain AWS response blocks subsequent changes to that resource. Verify its state in AWS before manually reconciling the `AWS_BRAKE` record; never blindly retry. Keep the local JSON store when restarting the admin so recorded concurrency can be restored. The default cloud execution role only includes the app's Lambda controls; EC2/RDS controls require the operator role below. This is an operational control, not a guaranteed spending cap.

## Generate policies and bootstrap roles

Use an administrative **non-root temporary session**, preferably AWS IAM Identity Center/SSO. This creates scoped roles, not a child account or permanent access keys. The initial caller needs permissions to provision the bootstrap IAM/OIDC/S3 resources. `--principal` is the existing IAM role or user allowed to assume the monitoring/operator role; an STS assumed-role session ARN is not accepted.

```sh
AWS_PROFILE=bootstrap node rt-app/cli/aws-access.mjs \
  --app rt-app-hello --repository YOUR_ORG/YOUR_REPO \
  --principal arn:aws:iam::123456789012:role/YourAdministrativeRole \
  --region us-east-1
```

This only writes `.rt-app/aws-access.tfvars.json`. Add `--apply` to provision roles and policies, and `--configure-github` to configure repository variables using an authenticated `gh` CLI. Set the application's verified SES `MAIL_FROM` repository variable separately. Outputs, including `operator_role` and the portable `monitor_policy` JSON, are written to `.rt-app/aws-access.outputs.json`. Configure an AWS profile that assumes this role for local monitoring. The installer preserves these optional roles on later runs.

Add `--multi-environment` for `develop`, `stage`, and production (`main`); production alone is the default. Existing multi-environment configuration is retained. Supply `--github-oidc-arn` or `--gitlab-oidc-arn` if that account already has the corresponding provider. Review the Terraform plan before operating against an existing account.

GitHub Actions already deploys after successful checks on those branches, using short-lived OIDC credentials. Add `--gitlab YOUR_NAMESPACE/YOUR_PROJECT` to generate equivalent GitLab.com roles. For GitLab, configure protected CI variables `AWS_REGION`, `RT_APP_NAME`, `MAIL_FROM`, `TF_STATE_BUCKET`, `AWS_ROLE_PROD` and, optionally, `AWS_ROLE_DEVELOP`, `AWS_ROLE_STAGE`, `RT_APP_MULTI_ENVIRONMENT=true` using the generated outputs. Protect the deployment branches. Neither CI system needs stored AWS access keys.

No AWS resources are provisioned just by opening the dashboard.
