import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {projectInsights,projectRecords,redact} from '../insights.mjs';

const now=Math.floor(Date.now()/1000);
async function fixture(t,{mode='json',rows}={}){
 const root=await mkdtemp(join(tmpdir(),'sm-insights-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const files={
  'package.json':{name:'shop',rtApp:{backend:'@x/server'}},
  'rt-app.settings.json':{version:1,runtime:{local:{mode}},backend:'node-ts',project:{template:'shopping-cart'}},
  'modules.json':{modules:['content','infra','users','auth','acl','orders'],generatedCrud:[{name:'orders'}]},
  'packages/orders/package.json':{name:'@app/orders',dependencies:{'@app/cart':'0.0.0'}},
  'packages/orders/src/index.js':"export const ORDERS_PK = 'ORDERS';\nconst key=id=>`CHECKOUT_KEY#${id}`;\nconst live=env.PAYMENTS_SIMULATION;\nconst secret=process.env.STRIPE_SECRET_KEY;\nconst currency='USD';\n",
  '.rt-app/services.json':{services:[{id:'api',env:{RT_APP_MODE:mode,RT_APP_MAIL_TRANSPORT:'smtp',RT_APP_MAIL_SMTP_PORT:'2025',PAYMENTS_SIMULATION:'on',STRIPE_SECRET_KEY:'sk_test_1234567890'}}]},
  'apps/server/.rt-app/local.json':{format:1,rows:rows??[
   {pk:'USERS',sk:'u1',version:1,data:{email:'a@b.test',passwordHash:'scrypt$abc',tokenVersion:3,updatedAt:'2026-01-02'}},
   {pk:'EMAIL',sk:'a@b.test',version:1,data:{id:'u1'}},
   {pk:'ORDERS',sk:'o1',version:1,data:{status:'paid',updatedAt:'2026-01-01'}},
   {pk:'ORDERS',sk:'o2',version:1,data:{status:'pending',updatedAt:'2026-01-03'}},
   {pk:'CHECKOUT_KEY#u1',sk:'k1',version:1,data:{orderId:'o1'}},
   {pk:'CRUD#orders',sk:'c1',version:1,data:{name:'crud row'}},
   {pk:'MIGRATIONS',sk:'orders:001',version:1,data:{appliedAt:'2026-01-01'}},
   {pk:'SEEDS',sk:'users:demo',version:1,data:{appliedAt:'2026-01-01',environment:'local'}},
   {pk:'RATE',sk:'r1',version:1,data:{count:1},ttl:now-10},
   {pk:'MYSTERY',sk:'m1',version:1,data:{}},
  ]},
 };
 for(const [path,content] of Object.entries(files)){await mkdir(join(root,path,'..'),{recursive:true});await writeFile(join(root,path),typeof content==='string'?content:JSON.stringify(content));}
 return root;
}

test('insights: modules with their initialization, records grouped by the module that owns them',async t=>{
 const root=await fixture(t);
 const r=await projectInsights(root);
 assert.equal(r.storage.kind,'json');
 assert.equal(r.storage.location,join(root,'apps/server/.rt-app/local.json'));
 assert.deepEqual(r.modules.map(m=>m.id),['content','infra','users','auth','acl','orders','observer','subscriptions','aws-monitor'],'framework-wired modules are listed too');
 const orders=r.modules.find(m=>m.id==='orders');
 assert.equal(orders.kind,'crud');
 assert.deepEqual(orders.prefixes,['ORDERS','CHECKOUT_KEY'],'declared constants and key templates; plain strings are not listed');
 assert.equal(orders.records,4,'ORDERS + CHECKOUT_KEY#… + CRUD#orders');
 assert.deepEqual(orders.migrations,[{id:'001',appliedAt:'2026-01-01'}]);
 assert.deepEqual(orders.init.find(i=>i.key==='PAYMENTS_SIMULATION'),{key:'PAYMENTS_SIMULATION',value:'on',source:'API environment'});
 assert.equal(orders.init.find(i=>i.key==='STRIPE_SECRET_KEY').value,'set (18 chars)','secrets are never returned');
 assert.deepEqual(orders.init.find(i=>i.key==='uses'),{key:'uses',value:'@app/cart',source:'package dependency'});
 assert.equal(r.modules.find(m=>m.id==='users').records,2);
 assert.equal(r.modules.find(m=>m.id==='auth').init.find(i=>i.key==='mailer').value,'SMTP · localhost:2025');
 assert.equal(r.modules.find(m=>m.id==='users').seeds.length,1);
 assert.equal(r.totals.records,9,'TTL-expired rows are excluded');
 assert.equal(r.totals.system,2);
 assert.equal(r.collections.find(c=>c.id==='MYSTERY').module,'other');
 assert.equal(r.totals.other,1);
});

test('insights: memory mode is reported as unreadable instead of failing',async t=>{
 const r=await projectInsights(await fixture(t,{mode:'memory'}));
 assert.equal(r.storage.readable,false);
 assert.match(r.storage.reason,/inside the running API/);
 assert.equal(r.totals.records,0);
 assert.equal(r.modules.length,9);
});

test('records: one collection, newest first, searchable, paged and redacted',async t=>{
 const root=await fixture(t);
 const orders=await projectRecords(root,{collection:'ORDERS'});
 assert.deepEqual(orders.rows.map(r=>r.sk),['o2','o1']);
 assert.equal((await projectRecords(root,{collection:'CHECKOUT_KEY'})).total,1,'a prefix includes its partitions');
 assert.equal((await projectRecords(root,{collection:'CRUD#orders'})).rows[0].sk,'c1','a full pk matches exactly');
 assert.deepEqual((await projectRecords(root,{collection:'ORDERS',search:'PENDING'})).rows.map(r=>r.sk),['o2']);
 const page=await projectRecords(root,{collection:'ORDERS',limit:1,offset:1});
 assert.deepEqual([page.total,page.rows.map(r=>r.sk)],[2,['o1']]);
 const user=(await projectRecords(root,{collection:'USERS'})).rows[0];
 assert.equal(user.data.passwordHash,'••••••');
 assert.equal(user.data.tokenVersion,3,'numbers are not secrets');
 await assert.rejects(projectRecords(root,{collection:''}),/Choose a collection/);
 await assert.rejects(projectRecords(await fixture(t,{mode:'memory'}),{collection:'USERS'}),/inside the running API/);
});

test('redact hides sensitive keys at any depth',()=>{
 assert.deepEqual(redact({a:{apiKey:'x',list:[{secret:'y',ok:1}]},password:null,enabled:true}),{a:{apiKey:'••••••',list:[{secret:'••••••',ok:1}]},password:null,enabled:true});
});
