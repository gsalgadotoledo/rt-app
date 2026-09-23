import test from 'node:test';
import assert from 'node:assert/strict';
import { AwsMonitor } from '@gsalgadotoledo/rt-app-aws';
import { STSClient } from '@aws-sdk/client-sts';
import { CostExplorerClient } from '@aws-sdk/client-cost-explorer';
import { ResourceGroupsTaggingAPIClient } from '@aws-sdk/client-resource-groups-tagging-api';

test('inventory paginates, reports truncation and caches without sending credentials to browser', async t => {
  t.mock.method(STSClient.prototype, 'send', async () => ({Account:'123'}));
  let calls=0;
  t.mock.method(ResourceGroupsTaggingAPIClient.prototype, 'send', async () => {
    calls++; return {ResourceTagMappingList:[{ResourceARN:`arn:aws:lambda:us-east-1:123:function:${calls}`, Tags:[{Key:'Application',Value:'starter'}]}],PaginationToken:'more'};
  });
  const monitor=new AwsMonitor();
  const result=await monitor.inventory();
  assert.equal(result.items.length,3); assert.equal(result.truncated,true);
  assert.equal(result.items[0].service,'lambda');
  assert.deepEqual(await monitor.inventory(),result); assert.equal(calls,3);
});
test('resource costs aggregate daily data, scope account and coalesce concurrent requests',async t=>{
  t.mock.method(STSClient.prototype,'send',async()=>({Account:'123'}));
  let calls=0;
  t.mock.method(CostExplorerClient.prototype,'send',async command=>{
    calls++; assert.equal(command.constructor.name,'GetCostAndUsageWithResourcesCommand');
    assert.deepEqual(command.input.Filter.And[0].Dimensions.Values,['123']);
    return {ResultsByTime:[{TimePeriod:{Start:'2026-09-01'},Estimated:true,Groups:[{Keys:['arn:test'],Metrics:{UnblendedCost:{Amount:'0.12',Unit:'USD'}}}]},{TimePeriod:{Start:'2026-09-02'},Groups:[{Keys:['arn:test'],Metrics:{UnblendedCost:{Amount:'0.08',Unit:'USD'}}}]}]};
  });
  const monitor=new AwsMonitor(); const [a,b]=await Promise.all([monitor.costs('AWS Lambda'),monitor.costs('AWS Lambda')]);
  assert.equal(calls,1); assert.deepEqual(a,b);assert.equal(a.items[0].amount,0.2);assert.equal(a.estimated,true);assert.deepEqual(a.daily.map(d=>d.amount),[0.12,0.08]);
  assert.throws(()=>monitor.costs('invalid\nservice'),e=>e.status===400);
});
test('failed AWS requests do not leak messages or become zero-dollar reports',async t=>{
  t.mock.method(STSClient.prototype,'send',async()=>{throw new Error('SECRET RESPONSE');});
  await assert.rejects(new AwsMonitor().inventory(),e=>e.status===502&&!e.message.includes('SECRET'));
});
test('service report follows more than two pages and ranks accumulated charges',async t=>{
 t.mock.method(STSClient.prototype,'send',async()=>({Account:'123'}));
 let calls=0;
 t.mock.method(CostExplorerClient.prototype,'send',async command=>{
  assert.equal(command.constructor.name,'GetCostAndUsageCommand');
  assert.equal(command.input.GroupBy[0].Key,'SERVICE');
  assert.deepEqual(command.input.Filter.Dimensions.Values,['123']);
  const page=calls++;
  assert.equal(command.input.NextPageToken,page?String(page):undefined);
  const rows=[['Lambda','2'],['DynamoDB','8'],['Lambda','9'],['Credits','-1']];
  return {NextPageToken:page<3?String(page+1):undefined,ResultsByTime:[{TimePeriod:{Start:'2026-09-01'},Groups:[{Keys:[rows[page][0]],Metrics:{UnblendedCost:{Amount:rows[page][1],Unit:'USD'}}}]}]};
 });
 const report=await new AwsMonitor().costs();
 assert.equal(calls,4);assert.equal(report.truncated,false);
 assert.deepEqual(report.items.map(x=>[x.name,x.amount]),[['Lambda',11],['DynamoDB',8],['Credits',-1]]);
});
