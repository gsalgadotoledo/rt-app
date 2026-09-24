import test from 'node:test';import assert from 'node:assert/strict';import {HealthChecks} from '../dist/index.js';
test('health deduplicates, caches and redacts dependency failures',async()=>{
 let calls=0;const checks=new HealthChecks([{id:'db',check:async()=>{calls++;throw Error('secret password');}},{id:'optional',required:false,check:async()=>{}}]);
 const [a,b]=await Promise.all([checks.report(),checks.report()]);assert.equal(calls,1);assert.equal(a.ok,false);assert.deepEqual(a,b);await checks.report();assert.equal(calls,1);assert.doesNotMatch(JSON.stringify(a),/password/);
 const ready=checks.feature().endpoints.find(e=>e.path==='/health/ready');await assert.rejects(ready.handle(),error=>error.status===503);
 assert.equal(checks.feature().endpoints.find(e=>e.path==='/health/report').access,'owner');
});
test('timed out optional checks do not fail readiness and receive abort',async()=>{
 let signal;const health=new HealthChecks([{id:'optional',required:false,check:async value=>{signal=value;await new Promise(()=>{});}}],10);
 const report=await health.report();assert.equal(report.ok,true);assert.equal(report.checks[0].status,'down');assert.equal(signal.aborted,true);
});
