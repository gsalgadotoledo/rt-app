import test from 'node:test';
import assert from 'node:assert/strict';
import {SlackOutput} from '@gsalgadotoledo/rt-app-observer-slack';
import {DatadogOutput} from '@gsalgadotoledo/rt-app-observer-datadog';
import {SentryOutput} from '@gsalgadotoledo/rt-app-observer-sentry';
import {WebhookOutput} from '@gsalgadotoledo/rt-app-observer-webhook';
import {CloudWatchLogReader} from '@gsalgadotoledo/rt-app-observer-cloudwatch';
const event={id:'12345678-1234-1234-1234-123456789012',at:new Date().toISOString(),level:'error',kind:'log',source:'app',category:'payments',requestId:'request-1',message:'Declined',data:{}};

test('external transports encode provider payloads without network delivery',async()=>{
 const calls=[],transport=async(url,options)=>{calls.push({url:String(url),...options});return new Response('',{status:200});};
 await new SlackOutput('https://hooks.slack.com/services/test/test/test',transport).write(event);
 assert.match(JSON.parse(calls[0].body).text,/payments/);assert.equal(JSON.parse(calls[0].body).mrkdwn,false);
 await new DatadogOutput('test-key','datadoghq.eu','app',transport).write(event);
 assert.equal(calls[1].headers['DD-API-KEY'],'test-key');assert.equal(JSON.parse(calls[1].body)[0].requestId,'request-1');
 await new SentryOutput('https://public-key@sentry.example.test/42',transport).write(event);
 assert.equal(calls[2].url,'https://sentry.example.test/api/42/envelope/');assert.equal(JSON.parse(calls[2].body.split('\n')[2]).tags.category,'payments');
 await new WebhookOutput('custom','https://logs.example.test',{},transport).write(event);
 assert.equal(calls[3].redirect,'error');
 await assert.rejects(new WebhookOutput('bad','https://logs.example.test',{},async()=>new Response('',{status:429})).write(event),/HTTP 429/);
});

test('CloudWatch searches are bounded, scoped, correlated and preserve empty continuation',async()=>{
 let input;
 const reader=new CloudWatchLogReader('/app/observer',{send:async(command)=>{input=command.input;return {events:[{message:JSON.stringify(event)},{message:'invalid json'}],nextToken:'continue'};}});
 const page=await reader.search({day:event.at.slice(0,10),category:'payments',requestId:'request-1',text:'not found'});
 assert.equal(page.events.length,0);assert.equal(page.cursor,'continue');assert.equal(input.limit,100);assert.equal(input.logGroupName,'/app/observer');assert.match(input.filterPattern,/request-1/);
});
