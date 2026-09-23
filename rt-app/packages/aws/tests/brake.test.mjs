import {test} from 'node:test';
import assert from 'node:assert/strict';
import {STSClient} from '@aws-sdk/client-sts';
import {LambdaClient} from '@aws-sdk/client-lambda';
import {AwsBrake} from '../dist/brake.js';
import {MemoryStore} from '@gsalgadotoledo/rt-app-dynamodb';
const arn='arn:aws:lambda:us-east-1:123456789012:function:rt-app-test';
test('brake verifies scope, requires one-use confirmation and persists original concurrency for resume',async t=>{
 t.mock.method(STSClient.prototype,'send',async()=>({Account:'123456789012',Arn:'arn:aws:iam::123456789012:role/operator'}));let concurrency=5,mutations=0;
 t.mock.method(LambdaClient.prototype,'send',async command=>{switch(command.constructor.name){case 'ListTagsCommand':return {Tags:{Application:'rt-app-test'}};case 'GetFunctionConcurrencyCommand':return {ReservedConcurrentExecutions:concurrency};case 'PutFunctionConcurrencyCommand':mutations++;concurrency=command.input.ReservedConcurrentExecutions;return {};default:throw new Error('Unexpected AWS operation');}});
 const store=new MemoryStore(),brake=new AwsBrake(store,'rt-app-test');const plan=await brake.plan(arn,'pause','owner');assert.equal(mutations,0);
 await assert.rejects(()=>brake.execute(plan.id,'wrong','owner'));assert.equal(mutations,0);
 await assert.rejects(()=>brake.execute(plan.id,arn,'other'));assert.equal(mutations,0);
 await brake.execute(plan.id,arn,'owner');assert.equal(concurrency,0);await assert.rejects(()=>brake.execute(plan.id,arn,'owner'));assert.equal(mutations,1);
 const rebuilt=new AwsBrake(store,'rt-app-test'),resume=await rebuilt.plan(arn,'resume','owner');await rebuilt.execute(resume.id,arn,'owner');assert.equal(concurrency,5);assert.equal(mutations,2);
 await assert.rejects(()=>new AwsBrake(store,'rt-app-other').plan(arn,'pause','owner'),e=>e.status===403);
});
test('root identity and unknown outcomes fail closed without retrying AWS mutations',async t=>{
 t.mock.method(STSClient.prototype,'send',async()=>({Account:'123456789012',Arn:'arn:aws:iam::123456789012:root'}));const store=new MemoryStore(),brake=new AwsBrake(store,'rt-app-test');await assert.rejects(()=>brake.plan(arn,'pause','owner'),e=>e.status===403);
 t.mock.method(STSClient.prototype,'send',async()=>({Account:'123456789012',Arn:'arn:aws:iam::123456789012:role/operator'}));
 t.mock.method(LambdaClient.prototype,'send',async c=>{if(c.constructor.name==='ListTagsCommand')return {Tags:{Application:'rt-app-test'}};if(c.constructor.name==='GetFunctionConcurrencyCommand')return {ReservedConcurrentExecutions:5};throw new Error('Sensitive timeout detail');});
 const plan=await brake.plan(arn,'pause','owner');await assert.rejects(()=>brake.execute(plan.id,arn,'owner'),e=>e.status===502&&!e.message.includes('Sensitive'));await assert.rejects(()=>brake.plan(arn,'pause','owner'),e=>e.status===409);
});
