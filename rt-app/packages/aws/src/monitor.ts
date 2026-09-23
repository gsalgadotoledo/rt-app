import {BudgetsClient,DescribeBudgetsCommand} from '@aws-sdk/client-budgets';
import {AwsBrake} from './brake.js';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { ResourceGroupsTaggingAPIClient, GetResourcesCommand } from '@aws-sdk/client-resource-groups-tagging-api';
import { CostExplorerClient, GetCostAndUsageCommand, GetCostAndUsageWithResourcesCommand } from '@aws-sdk/client-cost-explorer';
import { HttpError, type Feature, type Store } from '@gsalgadotoledo/rt-app-contracts';

/** Read-only monitoring; credentials always come from the server's AWS credential chain. */
export class AwsMonitor {
  private cache = new Map<string, { expires: number; value: unknown }>();
  private pending = new Map<string, Promise<unknown>>();
  private brake?:AwsBrake;
  constructor(private region = process.env.AWS_REGION ?? 'us-east-1',store?:Store) {if(store)this.brake=new AwsBrake(store);}
  private async cached(key: string, ttl: number, run: () => Promise<unknown>) {
    const hit = this.cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    if (this.pending.has(key)) return this.pending.get(key);
    const task = run().then(value => {
      this.cache.set(key, { expires: Date.now() + ttl, value });
      return value;
    }).catch((error: any) => {
      // Never echo SDK messages, credential details or arbitrary response bodies.
      throw new HttpError(502, error?.name === 'CredentialsProviderError'
        ? "Set AWS_PROFILE or the AWS environment variables in the server process."
        : "AWS could not return the report. Check IAM permissions, the region, and whether Cost Explorer and resource-level data are enabled.");
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, task);
    return task;
  }
  private config(region = this.region) {
    return { region, maxAttempts: 1, requestHandler: { connectionTimeout: 1500, requestTimeout: 5000 } };
  }
  inventory() {
    return this.cached('inventory', 300_000, async () => {
      const sts = new STSClient(this.config());
      const tags = new ResourceGroupsTaggingAPIClient(this.config());
      try {
        const identity = await sts.send(new GetCallerIdentityCommand({}));
        const items: any[] = [];
        let token: string | undefined;
        // Bound response size and runtime; explicitly report truncation.
        for (let page = 0; page < 3; page++) {
          const result = await tags.send(new GetResourcesCommand({ ResourcesPerPage: 100, PaginationToken: token }));
          for (const resource of result.ResourceTagMappingList ?? []) {
            const arn = resource.ResourceARN ?? '';
            items.push({ arn, service: arn.split(':')[2], region: arn.split(':')[3] || 'global',
              tags: Object.fromEntries((resource.Tags ?? []).map(t => [t.Key!, t.Value ?? ''])) });
          }
          token = result.PaginationToken;
          if (!token) break;
        }
        return { account: identity.Account, region: this.region, items, truncated: !!token, fetchedAt: new Date().toISOString() };
      } finally { sts.destroy(); tags.destroy(); }
    });
  }
  costs(service?: string,detail='resource') {
    if(service!==undefined&&(typeof service!=='string'||!service.trim()||service.length>150||/[\x00-\x1f]/.test(service)))throw new HttpError(400,'Invalid service');
    if(!['resource','usage'].includes(detail))throw new HttpError(400,'Invalid cost detail');
    return this.cached('cost:' + detail + ':' + (service ?? 'monthly'), 21_600_000, async () => {
      const client = new CostExplorerClient(this.config('us-east-1'));
      const end = new Date(); end.setUTCHours(0, 0, 0, 0);
      const start = new Date(end);
      if (service) start.setUTCDate(start.getUTCDate() - 14);
      else start.setUTCDate(1);
      const date = (d: Date) => d.toISOString().slice(0, 10);
      const period = { Start: date(start), End: date(end) };
      // On day one there are no completed days in this month yet.
      if (period.Start === period.End) { client.destroy(); return { period, items: [], estimated: true, truncated: false, fetchedAt: new Date().toISOString(), noCompletedDays: true }; }
      try {
        const identityClient = new STSClient(this.config());
        let account: string;
        try { account = (await identityClient.send(new GetCallerIdentityCommand({}))).Account!; }
        finally { identityClient.destroy(); }
        if (!account) throw new Error('Missing account');
        const items = new Map<string, { name: string; amount: number; unit: string }>();
        const daily=new Map<string,{date:string;amount:number;unit:string}>();
        let token: string | undefined, estimated = false;
        const deadline=Date.now()+12000;
        for (let page = 0; page < 50; page++) {
          const common = { TimePeriod: period, Granularity: 'DAILY' as const, Metrics: ['UnblendedCost'], NextPageToken: token };
          const accountFilter = { Dimensions: { Key: 'LINKED_ACCOUNT' as const, Values: [account] } };
          const result = service && detail==='resource'
            ? await client.send(new GetCostAndUsageWithResourcesCommand({ ...common, GroupBy: [{ Type: 'DIMENSION', Key: 'RESOURCE_ID' }], Filter: { And: [accountFilter, { Dimensions: { Key: 'SERVICE', Values: [service] } }] } }))
            : await client.send(new GetCostAndUsageCommand({ ...common, GroupBy: [{ Type: 'DIMENSION', Key: service?'USAGE_TYPE':'SERVICE' }], Filter: service?{And:[accountFilter,{Dimensions:{Key:'SERVICE',Values:[service]}}]}:accountFilter }));
          for (const day of result.ResultsByTime ?? []) {
            estimated ||= !!day.Estimated;
            for (const group of day.Groups ?? []) {
              const metric = group.Metrics?.UnblendedCost;
              const name = group.Keys?.[0] || "Not attributed to a resource";
              const unit = metric?.Unit ?? 'USD';
              const key = name + ':' + unit;
              const old = items.get(key) ?? { name, amount: 0, unit };
              const amount=Number(metric?.Amount??0);old.amount += amount; items.set(key, old);
              const date=day.TimePeriod?.Start;if(date){const key=date+':'+unit,point=daily.get(key)??{date,amount:0,unit};point.amount+=amount;daily.set(key,point);}
            }
          }
          token = result.NextPageToken;
          if (!token || Date.now()>=deadline) break;
        }
        return { account, period, service,detail,daily:[...daily.values()].sort((a,b)=>a.date.localeCompare(b.date)), items: [...items.values()].sort((a,b) => a.unit.localeCompare(b.unit) || b.amount - a.amount || a.name.localeCompare(b.name)), estimated, truncated: !!token, fetchedAt: new Date().toISOString() };
      } finally { client.destroy(); }
    });
  }
  budgets() {
    return this.cached('budgets',300000,async()=>{
      const sts=new STSClient(this.config()),client=new BudgetsClient(this.config('us-east-1'));
      try {
        const account=(await sts.send(new GetCallerIdentityCommand({}))).Account;
        if(!account)throw new Error('Missing account');
        const items:any[]=[];let token:string|undefined;
        for(let page=0;page<10;page++){
          const result=await client.send(new DescribeBudgetsCommand({AccountId:account,MaxResults:100,NextToken:token}));
          for(const b of result.Budgets??[])items.push({name:b.BudgetName,limit:b.BudgetLimit?.Amount,unit:b.BudgetLimit?.Unit,spent:b.CalculatedSpend?.ActualSpend?.Amount??null,services:b.CostFilters?.Service??[],updatedAt:b.LastUpdatedTime?.toISOString()});
          token=result.NextToken;if(!token)break;
        }
        return {account,items,truncated:!!token};
      }finally{sts.destroy();client.destroy();}
    });
  }
  feature(): Feature {
    return { id: 'aws-monitor', migrations: [], admin: { id: 'aws-monitor', group: 'infra', title: "AWS · Monitoring", resource: 'aws.monitor', path: '/aws/inventory', component: 'aws-monitor', ownerOnly: true, fields: [], actions: [] }, endpoints: [
      { method:'GET',path:'/aws/budgets',resource:'aws.monitor',access:'owner',handle:()=>this.budgets() },
      { method: 'GET', path: '/aws/inventory', resource: 'aws.monitor', access: 'owner', handle: () => this.inventory() },
      { method: 'GET', path: '/aws/costs', resource: 'aws.monitor', access: 'owner', handle: c => this.costs(c.request.query.service,c.request.query.detail) },
      ...(this.brake?[{method:'POST',path:'/aws/brake/plan',resource:'aws.brake',access:'owner' as const,handle:(c:any)=>this.brake!.plan(c.request.body.arn,c.request.body.action,c.actor.id)},
      {method:'POST',path:'/aws/brake/execute',resource:'aws.brake',access:'owner' as const,handle:(c:any)=>this.brake!.execute(c.request.body.id,c.request.body.confirmation,c.actor.id)}]:[]),
    ] };
  }
}
