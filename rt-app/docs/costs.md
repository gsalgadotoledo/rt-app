# Initial monthly AWS budget

Reference: 2026-09-22, US East (N. Virginia), USD, on-demand/pay-as-you-go.
This is an estimate for this starter, not a quote or a bill from the user's account.

| Configuration | Secrets baseline, almost idle | Suggested low-traffic monthly budget |
| --- | ---: | ---: |
| Production only (default) | $1.20 + storage/requests | $3–5 |
| Develop + stage + production | $3.60 + storage/requests | $8–15 |

The baseline comes from **three secrets per environment × $0.40/month**: application
JWT, root-password verifier and the infra module's secret container. Empty secret
containers also remain billable. API retrievals add $0.05 per 10,000 calls.
[Secrets Manager pricing](https://aws.amazon.com/secrets-manager/pricing/).

A worked low-traffic example **per environment**, excluding credits and free allowances:

| Item and monthly assumption | Approximate USD |
| --- | ---: |
| Three secrets + 2,000 secret API calls | 1.210 |
| 10,000 Lambda requests, 512 MB, 200 ms billed average | 0.019 |
| 10,000 HTTP API Gateway calls | 0.010 |
| DynamoDB: 1 GB standard storage + point-in-time recovery | 0.450 |
| DynamoDB: 20,000 billed write units + 20,000 billed read units | 0.015 |
| Allowance for S3, CDN transfer/requests, logs, email and state | 1–3 |
| **Total rounded** | **3–5** |

Lambda calculation: 10,000 × 0.5 GB × 0.2 s × $0.0000166667 +
10,000 / 1,000,000 × $0.20 = $0.01867. Cold starts and actual billed duration change it.
[Lambda pricing](https://aws.amazon.com/lambda/pricing/).
HTTP API starts at $1 per million calls; response transfer is additional.
[API Gateway pricing](https://aws.amazon.com/api-gateway/pricing/).

DynamoDB example uses $0.25/GB-month standard storage, $0.20/GB-month PITR,
$0.625/million write units and $0.125/million read units. These are billed units,
not business operations: transaction writes, item size and extra reads matter.
[DynamoDB pricing](https://aws.amazon.com/dynamodb/pricing/).

The final allowance assumes tiny static bundles, no more than roughly 10 GB frontend
transfer/month, around 100,000 static requests, 0.1 GB logs and 1,000 small emails.
It is a budgeting allowance, not a fixed AWS fee. SES alone is $0.10/1,000 outgoing
emails before attachment data and optional features.
[SES pricing](https://aws.amazon.com/ses/pricing/).
CloudFront's pay-as-you-go free allowances may reduce the bill; they are shared at
account level, not multiplied by adding environments. Do not confuse them with a
separate flat-rate plan. Viewer geography also changes CDN transfer prices.
[CloudFront FAQ](https://aws.amazon.com/cloudfront/faqs/).

Three environments do not require three times the production traffic. If develop and
stage are mostly idle, their principal extra recurring cost here is their secrets
and stored data. There is no NAT Gateway, load balancer, container cluster, provisioned
Lambda concurrency or always-running database server in this deployment.

Excluded: tax, purchased domains, paid support, GitHub Actions minutes/storage, large
uploads, abuse spikes, larger datasets, growing S3 versions/release artifacts and
additional modules. Deployments also generate requests and invalidations. Free tiers
and new-account credits can lower initial bills, but are not the basis of this budget.
Use actual usage and regional rates to revise it after the first deployment.

## Cognito addition

The AWS adapter uses Cognito Essentials with direct user-pool authentication and optional
TOTP, without SMS. Its current free tier is 10,000 direct/social MAUs per account or
organization (shared across pools), outside GovCloud. Ten users should fit if other
workloads have not consumed that allowance. SES email delivery remains separately billed.
[Cognito pricing](https://aws.amazon.com/cognito/pricing/).

The quoted $0.60–$0.80/month architecture is not exactly this deployment: this starter
has no Route 53 zone/custom domain, includes two S3/CloudFront frontends, and still has
three Secrets Manager secrets ($1.20/environment/month before calls). SSM Parameter
Store has not replaced them. Therefore $1/month is not a guaranteed total; keep the
above $3–5 low-traffic budget until measuring the deployed application.
