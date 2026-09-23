import test from 'node:test';
import assert from 'node:assert/strict';
import {createApplication} from '@gsalgadotoledo/rt-app-framework';
import {MemoryStore} from '@gsalgadotoledo/rt-app-dynamodb';
import {LocalMailbox} from '@gsalgadotoledo/rt-app-auth';
test('observer records canonical routes, protects reports, and avoids self-observation',async()=>{
 const store=new MemoryStore(),app=createApplication({store,mailer:new LocalMailbox(),secret:'a'.repeat(64),localAdminAccess:true,observerOutputs:[],modules:['content','users','auth','acl','infra']});
 const call=(method,path,body={})=>app.handle({method,path,body,headers:{},query:{},ip:'loopback'});
 assert.equal((await call('GET','/')).status,200);
 assert.equal((await call('POST','/observer/events',{source:'spa',path:'/'})).status,200);
 const report=await call('GET','/admin/app/observer/report');assert.equal(report.status,200);assert.equal(report.body.counts.requests,1);assert.equal(report.body.counts.spa,1);
 const again=await call('GET','/admin/app/observer/report');assert.deepEqual(again.body.counts,report.body.counts);
 assert.equal((await call('GET','/observer/report')).status,404);
 const remote=createApplication({store,mailer:new LocalMailbox(),secret:'a'.repeat(64),observerOutputs:[]});
 assert.equal((await remote.handle({method:'GET',path:'/admin/app/observer/report',body:{},headers:{},query:{},ip:'external'})).status,401);
});
