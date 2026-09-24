import test from 'node:test';
import {ObserverStore} from '@gsalgadotoledo/rt-app-observer';
import assert from 'node:assert/strict';
import {createApplication} from '@gsalgadotoledo/rt-app-framework';
import {MemoryStore} from '@gsalgadotoledo/rt-app-dynamodb';
import {LocalMailbox} from '@gsalgadotoledo/rt-app-auth';
test('observer records canonical routes, protects reports, and avoids self-observation',async()=>{
 const store=new MemoryStore(),app=createApplication({store,mailer:new LocalMailbox(),secret:'a'.repeat(64),localAdminAccess:true,observerOutputs:[{handler:new ObserverStore(store)}],modules:['content','users','auth','acl','infra']});
 const call=(method,path,body={})=>app.handle({method,path,body,headers:{},query:{},ip:'loopback'});
 assert.equal((await call('GET','/')).status,200);
 assert.equal((await call('POST','/observer/events',{source:'spa',path:'/'})).status,200);
 const report=await call('GET','/admin/app/observer/report');assert.equal(report.status,200);assert.equal(report.body.counts.requests,1);assert.equal(report.body.counts.spa,1);
 const again=await call('GET','/admin/app/observer/report');assert.deepEqual(again.body.counts,report.body.counts);
 assert.equal((await call('GET','/observer/report')).status,404);
 const remote=createApplication({store,mailer:new LocalMailbox(),secret:'a'.repeat(64),observerOutputs:[]});
 assert.equal((await remote.handle({method:'GET',path:'/admin/app/observer/report',body:{},headers:{},query:{},ip:'external'})).status,401);
});

test('local observer uses a separate persistent file and log search is admin-only',async()=>{
 const {mkdtemp,rm,readFile}=await import('node:fs/promises');
 const {join}=await import('node:path');const {tmpdir}=await import('node:os');
 const {JsonStore}=await import('@gsalgadotoledo/rt-app-json');
 const dir=await mkdtemp(join(tmpdir(),'rt-observer-'));
 try {
  const store=new JsonStore(join(dir,'app.json'));
  await store.transact([{row:{pk:'APP',sk:'1',version:1,data:{name:'kept'}},expected:null}]);
  const app=createApplication({store,mailer:new LocalMailbox(),secret:'a'.repeat(64),localAdminAccess:true});
  await app.observer.error('Declined',{category:'payments',requestId:'correlation-1'});
  const reloaded=createApplication({store,mailer:new LocalMailbox(),secret:'a'.repeat(64),localAdminAccess:true,observerOutputs:[]});
  const request={method:'GET',path:'/admin/app/observer/logs',body:{},headers:{},query:{category:'payments'},ip:'loopback'};
  const response=await reloaded.handle(request);
  assert.equal(response.status,200);assert.equal(response.body.events[0].requestId,'correlation-1');
  assert.equal((await reloaded.handle({...request,path:'/observer/logs'})).status,404);
  assert.doesNotMatch(await readFile(store.file,'utf8'),/OBSERVER#/);
  const remote=createApplication({store,mailer:new LocalMailbox(),secret:'a'.repeat(64),observerOutputs:[]});
  assert.equal((await remote.handle(request)).status,401);
 } finally {await rm(dir,{recursive:true,force:true});}
});
