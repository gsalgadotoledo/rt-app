import test from 'node:test';import assert from 'node:assert/strict';import {SlackOutput} from '../dist/index.js';
const event={id:'12345678-1234-1234-1234-123456789012',at:new Date().toISOString(),level:'error',kind:'log',source:'app',category:'payments',requestId:'request-1',message:'Declined',data:{}};
test('provider payload, abort propagation and rejection handling without network calls',async()=>{
 const calls=[];let status=200;
 const transport=async(url,options)=>{calls.push({url:String(url),...options});return new Response('',{status});};
 const handler=new SlackOutput('https://hooks.slack.com/services/test/test/test',transport),signal=new AbortController().signal;
 await handler.write(event,signal);assert.equal(calls[0].signal,signal);assert.equal(calls[0].redirect,'error');assert.match(JSON.parse(calls[0].body).text,/payments/);assert.equal(JSON.parse(calls[0].body).mrkdwn,false);
 status=429;await assert.rejects(handler.write(event),/HTTP 429/);
});
