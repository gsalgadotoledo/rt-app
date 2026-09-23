# AWS monitoring

The core AWS package provides a read-only admin module, enabled with the default infra module. Restart `npm run dev` after building to register its backend endpoints. Local JSON development remains available without AWS; no monitoring API calls occur until the root administrator clicks a query button.

Use `AWS_PROFILE` or `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, optional `AWS_SESSION_TOKEN`, and `AWS_REGION` in the **server process environment**. Deployed Lambda uses its execution role. Monitoring deliberately does not use keys entered in the legacy infrastructure settings form. Never send keys to the browser. The admin root session is required; application user tokens cannot access these endpoints.

## Read-only permissions

`tag:GetResources`, `ce:GetCostAndUsage`, and `ce:GetCostAndUsageWithResources`, with Resource `*` (these queries are account-level), plus STS GetCallerIdentity. The runtime policy and its bootstrap boundary include these permissions. Existing deployments must update bootstrap before deploying the runtime. No cloud changes are applied by opening the dashboard.

## Scope and limits

- Inventory: the configured region, resources supported by Resource Groups Tagging API that are currently or were previously tagged; not all resources, not all regions, and not health monitoring. Maximum 300 results, visibly marked partial when more exist. Five-minute process cache.
- Costs: current AWS account only (LINKED_ACCOUNT filter), all regions, not just this application. Current month by service through yesterday UTC. No completed-day data on the first of a month.
- Resource costs: one selected service for the last 14 completed UTC days. Enable daily resource-level data for that service in Cost Explorer first. Resource IDs are displayed exactly as returned; costs are not guessed from inventory or evenly distributed among resources.
- UnblendedCost is reported in AWS's returned currency and may include credits. It is delayed and may be estimated, not a final invoice. Empty or inaccessible reports are not treated as zero cost.
- Two Cost Explorer pages maximum per report; partial results are labeled. Manual refresh with six-hour cache and concurrent-request coalescing **per process**. Lambda cold starts and separate environments do not share caches, so they can incur additional requests. No scheduled polling or spend cap enforcement.
- AWS charges USD 0.01 per primary-billing-view Cost Explorer API request. Thus a cache miss costs up to USD 0.02 for the bounded report; there is no automatic billing query on page load.

Sources: [Cost Explorer API pricing](https://aws.amazon.com/aws-cost-management/aws-cost-explorer/pricing/), [daily resource data](https://docs.aws.amazon.com/cost-management/latest/userguide/ce-resource-daily.html), [GetResources inventory scope](https://docs.aws.amazon.com/resourcegroupstagging/latest/APIReference/API_GetResources.html).
