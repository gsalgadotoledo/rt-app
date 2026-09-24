import test from 'node:test';import assert from 'node:assert/strict';import {Analytics} from '../dist/index.js';import {Observer} from '@gsalgadotoledo/rt-app-observer';
test('analytics is a filtered observer category without duplicate request events',async()=>{
 const events=[],analytics=new Analytics(new Observer([{handler:{id:'capture',write:event=>events.push(event)},categories:['analytics']}]));
 await analytics.track('checkout.completed',{password:'hidden'});await analytics.pageView('Home',{url:'/'});
 assert.deepEqual(events.map(event=>event.kind),['analytics','pageview']);assert.equal(events[0].category,'analytics');assert.doesNotMatch(JSON.stringify(events),/hidden/);assert.throws(()=>analytics.track('bad name'));
});
