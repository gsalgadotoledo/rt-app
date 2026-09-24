import test from 'node:test';import assert from 'node:assert/strict';import {SentryOutput} from '../dist/index.js';
const event={id:'12345678-1234-1234-1234-123456789012',at:new Date().toISOString(),level:'error',kind:'log',source:'app',category:'payments',requestId:'request-1',message:'Declined',data:{}};
test('provider payload, abort propagation and rejection handling without network calls',async()=>{
 const calls=[];let status=200;
 const transport=async(url,options)=>{calls.push({url:String(url),...options});return new Response('',{status});};
 const handler=new SentryOutput('https://public-key@sentry.example.test/42',transport),signal=new AbortController().signal;
 await handler.write(event,signal);assert.equal(calls[0].signal,signal);assert.equal(calls[0].redirect,'error');assert.equal(calls[0].url,'https://sentry.example.test/api/42/envelope/');assert.equal(JSON.parse(calls[0].body.split('\n')[2]).tags.category,'payments');
 status=429;await assert.rejects(handler.write(event),/HTTP 429/);
});
