import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonStore } from "@gsalgadotoledo/rt-app-json";
import {
  Subscriptions,
  LocalBilling,
  defaults,
  validateSettings,
} from "../dist/index.js";
const user = { id: "alice", email: "alice@example.test", role: "user" };
async function fixture(t, paid = false) {
  const dir = await mkdtemp(join(tmpdir(), "rt-sub-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new JsonStore(join(dir, "db.json"));
  let now = Date.now();
  const sent = [];
  const service = new Subscriptions(
    store,
    paid ? new LocalBilling(store) : undefined,
    async (m) => sent.push(m),
    () => now,
  );
  return { store, service, sent, advance: (ms) => (now += ms) };
}
test("atomic concurrent consumption never exceeds limits and replay never charges twice", async (t) => {
  const { service, store } = await fixture(t);
  await service.change(user, "starter", "plan");
  const results = await Promise.allSettled(
    Array.from({ length: 4 }, (_, i) =>
      service.consume(user.id, "api", 40, "request" + i),
    ),
  );
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 2);
  const me = await service.me(user.id);
  assert.equal(me.usage[0].used, 80);
  const ledger = await store.list("SUB_USAGE#alice");
  const key = ledger.items[0].sk;
  assert.equal((await service.consume(user.id, "api", 40, key)).replayed, true);
  assert.equal((await service.me(user.id)).usage[0].used, 80);
  await assert.rejects(service.consume(user.id, "api", 41, key));
});
test("daily/weekly/period resets and courtesy reset preserve audit and idempotency", async (t) => {
  const { service, advance, store } = await fixture(t);
  await service.change(user, "starter", "plan");
  await service.consume(user.id, "api", 100, "r1");
  await assert.rejects(service.consume(user.id, "api", 1, "r2"), /limit/);
  advance(86400000);
  await service.consume(user.id, "api", 100, "r2");
  assert.equal((await service.me(user.id)).usage[0].used, 200);
  await service.reset(
    user.id,
    { scope: "all", reason: "Courtesy", requestId: "reset" },
    "root",
  );
  await service.reset(
    user.id,
    { scope: "all", reason: "Courtesy", requestId: "reset" },
    "root",
  );
  assert.equal((await service.me(user.id)).courtesyResets, 1);
  assert.equal(
    (await store.list("SUB_RESET#alice")).items[0].data.actorId,
    "root",
  );
  advance(31 * 86400000);
  assert.equal((await service.me(user.id)).active, true);
  assert.equal((await service.me(user.id)).usage[0].used, 0);
});
test("failed payment cuts access; a courtesy reset cannot reactivate it", async (t) => {
  const { service, store } = await fixture(t, true);
  await service.saveSettings(
    { version: 0, values: { ...defaults, paymentRequired: true } },
    "root",
  );
  await service.change(user, "pro", "plan");
  assert.equal((await service.me(user.id)).plan.id, "pro");
  await service.consume(user.id, "api", 10, "r1");
  const account = await store.get("SUB_ACCOUNTS", user.id);
  await service.provider.simulate(account.data.customerId, "past_due");
  await service.sync(user.id);
  await service.reset(
    user.id,
    { scope: "all", reason: "Test", requestId: "reset" },
    "root",
  );
  await assert.rejects(service.consume(user.id, "api", 1, "r2"), /inactive/);
  assert.equal((await service.me(user.id)).active, false);
});
test("enabling payment requirement blocks an existing unpaid account", async (t) => {
  const { service } = await fixture(t, true);
  await service.change(user, "starter", "free");
  await service.saveSettings(
    { version: 0, values: { ...defaults, paymentRequired: true } },
    "root",
  );
  assert.equal((await service.me(user.id)).active, false);
  await assert.rejects(service.consume(user.id, "api", 1, "r1"), /paid/);
});
test("cancellation prevents automatic unpaid renewal", async (t) => {
  const { service, advance } = await fixture(t);
  await service.change(user, "starter", "plan");
  await service.cancel(user, "cancel");
  advance(31 * 86400000);
  await assert.rejects(service.consume(user.id, "api", 1, "r1"), /expired/);
});
test("settings reject negative credits and invalid currency", () => {
  const bad = structuredClone(defaults);
  bad.plans[0].products[0].credits = -1;
  assert.throws(() => validateSettings(bad));
  const invalid = structuredClone(defaults);
  invalid.plans[0].currency = "zzz";
  assert.throws(() => validateSettings(invalid));
});
test("webhook signature is required; duplicate delivery produces one durable notice", async (t) => {
  const { service, store, sent } = await fixture(t, true);
  await service.saveSettings(
    { version: 0, values: { ...defaults, paymentRequired: true } },
    "root",
  );
  await service.change(user, "pro", "plan");
  const account = await store.get("SUB_ACCOUNTS", user.id);
  service.provider.verify = (raw, sig) => {
    if (sig !== "signed") throw Error();
    return {
      id: "evt_one",
      type: "invoice.payment_failed",
      customer: account.data.customerId,
    };
  };
  await service.provider.simulate(account.data.customerId, "past_due");
  await assert.rejects(service.webhook("{}", "wrong"), /signature/);
  await service.webhook("{}", "signed");
  await service.webhook("{}", "signed");
  assert.equal((await store.list("SUB_MAIL")).items.length, 1);
  assert.equal((await service.me(user.id)).active, false);
  await service.maintenance();
  await service.maintenance();
  assert.equal(sent.length, 1);
});
test("a pending billing retry preserves its key and original plan snapshot", async (t) => {
  const { service } = await fixture(t, true);
  await service.saveSettings(
    { version: 0, values: { ...defaults, paymentRequired: true } },
    "root",
  );
  const original = service.provider.change.bind(service.provider);
  let failed = false;
  service.provider.change = async (...args) => {
    if (!failed) {
      failed = true;
      throw new Error("network timeout");
    }
    return original(...args);
  };
  await assert.rejects(service.change(user, "pro", "pending"), /timeout/);
  assert.equal(
    (await service.me(user.id)).pendingBillingRequest.requestId,
    "pending",
  );
  await assert.rejects(service.change(user, "pro", "different"), /pending/);
  await service.change(user, "pro", "pending");
  await service.change(user, "pro", "pending");
  assert.equal((await service.billing(user.id)).invoices.length, 1);
});

async function seedUser(store) {
  await store.transact([{row:{pk:'USERS',sk:user.id,version:1,data:{...user,name:'Alice',passwordHash:'secret'}},expected:null}]);
}
test('admin plans grant entitlements without billing and expire; credit grants are audited and idempotent', async t => {
  const {service,store,advance} = await fixture(t);
  await seedUser(store);
  const grant = {kind:'plan',planId:'pro',valueMinor:2000,currency:'usd',reason:'Manual payment',requestId:'grant1'};
  await service.grant(user.id,grant,'root');
  await service.grant(user.id,grant,'root');
  let me=await service.me(user.id);
  assert.equal(me.assignedByAdmin,true);
  assert.equal(me.plan.id,'pro');
  assert.equal(me.active,true);
  assert.equal((await store.list('SUB_GRANTS#alice')).items.length,1);
  await assert.rejects(service.grant(user.id,{...grant,valueMinor:100},'root'));
  await service.consume(user.id,'api',100,'use');
  await assert.rejects(service.change(user,'starter','change'),/administrator/);
  const credit={kind:'credits',productId:'api',credits:500,valueMinor:20000,currency:'cop',reason:'Credits paid offline',requestId:'credits1'};
  await Promise.all([service.grant(user.id,credit,'root'),service.grant(user.id,credit,'root')]);
  assert.equal((await service.me(user.id)).creditBalance.api,500);
  assert.equal((await store.list('SUB_GRANTS#alice')).items[0].data.actorId,'root');
  advance(31*86400000);
  assert.equal((await service.me(user.id)).active,false);
  await assert.rejects(service.consume(user.id,'api',1,'expired'),/inactive/);
});
test('extra credits cover period exhaustion but not daily limits; consumption remains atomic', async t => {
  const {service,store}=await fixture(t); await seedUser(store);
  const config=await service.settings();
  config.values.plans[0].products[0].credits=10;
  await service.saveSettings(config,'root');
  await service.grant(user.id,{kind:'plan',planId:'starter',valueMinor:0,currency:'usd',reason:'Courtesy',requestId:'p'},'root');
  await service.grant(user.id,{kind:'credits',productId:'api',credits:20,valueMinor:100,currency:'usd',reason:'Extra',requestId:'c'},'root');
  const result=await Promise.allSettled([service.consume(user.id,'api',20,'a'),service.consume(user.id,'api',20,'b')]);
  assert.equal(result.filter(x=>x.status==='fulfilled').length,1);
  assert.equal((await service.me(user.id)).creditBalance.api,10);
  await service.consume(user.id,'api',10,'last');
  await assert.rejects(service.consume(user.id,'api',1,'over'),/limit/);
  await service.grant(user.id,{kind:'credits',productId:'api',credits:200,valueMinor:0,currency:'usd',reason:'Extra',requestId:'more'},'root');
  await assert.rejects(service.consume(user.id,'api',71,'daily'),/day limit/);
});
test('user search includes unsubscribed users and excludes secrets and deleted users',async t=>{
  const {service,store}=await fixture(t); await seedUser(store);
  const page=await service.listUsers({q:'alice'});
  assert.equal(page.items.length,1); assert.equal(page.items[0].status,'none');
  assert.equal(JSON.stringify(page).includes('secret'),false);
  assert.equal((await service.listUsers({q:'nobody'})).items.length,0);
  await assert.rejects(service.grant('missing',{kind:'plan',planId:'pro',valueMinor:0,currency:'usd',reason:'Test',requestId:'p'},'root'),/User not found/);
});
test('paid billing synchronization preserves an admin grant and its credits',async t=>{
 const {service,store}=await fixture(t,true); await seedUser(store);
 const config=await service.settings(); config.values.paymentRequired=true; await service.saveSettings(config,'root');
 await service.change(user,'pro','paid');
 const original=(await store.get('SUB_ACCOUNTS',user.id)).data;
 await service.grant(user.id,{kind:'plan',planId:'starter',valueMinor:0,currency:'usd',reason:'Override',requestId:'admin'},'root');
 await service.consume(user.id,'api',10,'use');
 await service.sync(user.id);
 const me=await service.me(user.id);
 assert.equal(me.active,true); assert.equal(me.plan.id,'starter'); assert.equal(me.usage[0].used,10);
 const raw=(await store.get('SUB_ACCOUNTS',user.id)).data;
 assert.equal(raw.customerId,original.customerId); assert.equal(raw.plan.id,'pro');
});
test('plan edits create immutable versions; availability changes do not bump version',async t=>{
 const {service,store}=await fixture(t); let settings=await service.settings();
 await service.saveSettings(settings,'root'); settings=await service.settings();
 assert.equal(settings.values.plans[0].version,'0.0.1');
 settings.values.plans[0].amount=500; await service.saveSettings(settings,'root');
 settings=await service.settings(); assert.equal(settings.values.plans[0].version,'0.0.2');
 assert.equal((await store.get('SUB_PLAN_HISTORY#starter','0.0.1')).data.amount,0);
 settings.values.plans[0].enabled=false; await service.saveSettings(settings,'root');
 settings=await service.settings(); assert.equal(settings.values.plans[0].version,'0.0.2');
 settings.values.plans[0].products[0].credits=2000; await service.saveSettings(settings,'root');
 assert.equal((await service.settings()).values.plans[0].version,'0.0.3');
});
test('catalog failure is resumable, locks changes and never persists credentials',async t=>{
 const {store}=await fixture(t); let fail=true; const calls=[];
 const publisher={publish:async(plan,namespace,previous)=>{calls.push({plan,namespace,previous});if(fail)throw new Error('Network error');return{stripeProductId:'prod_test',stripePriceId:'price_test'};}};
 const service=new Subscriptions(store,undefined,undefined,Date.now,()=>publisher);
 await service.saveSettings(await service.settings(),'root');
 const settings=await service.settings();
 await assert.rejects(service.publishPlan('pro',{version:settings.version,secretKey:'never-persist'},'root'),/Network/);
 assert.equal(JSON.stringify((await store.get('SUB_CONFIG','settings')).data).includes('never-persist'),false);
 await assert.rejects(service.saveSettings(await service.settings(),'root'),/Resume/);
 fail=false; await service.publishPlan('pro',{},'root');
 assert.equal(calls[0].namespace,calls[1].namespace);
 assert.deepEqual(calls[0].plan,calls[1].plan);
 assert.equal((await service.settings()).catalogOperation,undefined);
 assert.equal((await store.get('SUB_PLAN_PRICES','price_test')).data.plan.id,'pro');
});
test('Stripe sync keeps historical entitlements after the current plan changes',async t=>{
 const {store}=await fixture(t);
 const service=new Subscriptions(store,{mode:'stripe',snapshot:async()=>({subscriptionId:'sub_test',priceId:'price_old',status:'active',periodStart:Date.now(),periodEnd:Date.now()+86400000})});
 const oldPlan={...structuredClone(defaults.plans[1]),version:'0.0.1',stripePriceId:'price_old'};
 await store.transact([{row:{pk:'SUB_PLAN_PRICES',sk:'price_old',version:1,data:{plan:oldPlan}},expected:null},{row:{pk:'SUB_ACCOUNTS',sk:user.id,version:1,data:{userId:user.id,customerId:'cus_test',subscriptionId:'sub_test',plan:oldPlan}},expected:null}]);
 let settings=await service.settings();settings.values.plans[1].products[0].credits=999999;await service.saveSettings(settings,'root');
 await service.sync(user.id); assert.equal((await service.me(user.id)).plan.products[0].credits,10000);
});
test('restore creates a new revision without rewriting history or reactivating an archived plan',async t=>{
 const {service,store}=await fixture(t);
 await service.saveSettings(await service.settings(),'root');
 let settings=await service.settings();settings.values.plans[0].amount=500;await service.saveSettings(settings,'root');
 settings=await service.settings();settings.values.plans[0].archived=true;await service.saveSettings(settings,'root');
 settings=await service.settings();assert.equal(settings.values.plans[0].enabled,false);
 const restored=await service.restorePlan('starter',{version:settings.version,fromVersion:'0.0.1'},'root');
 assert.equal(restored.values.plans[0].version,'0.0.3');assert.equal(restored.values.plans[0].amount,0);
 assert.equal(restored.values.plans[0].archived,true);assert.equal(restored.values.plans[0].enabled,false);
 assert.equal((await store.get('SUB_PLAN_HISTORY#starter','0.0.2')).data.amount,500);
 assert.equal((await store.get('SUB_PLAN_HISTORY#starter','0.0.1')).data.amount,0);
 await assert.rejects(service.restorePlan('starter',{version:settings.version,fromVersion:'0.0.1'},'root'));
});

test('catalog actions create stable IDs, edit products, version and archive without losing history', async t => {
  const {service}=await fixture(t);
  let settings=await service.settings();
  settings=await service.editPlan('create',{version:settings.version,plan:{...defaults.plans[0],name:'Team Plus',id:'ignored'}},'root');
  const plan=settings.values.plans.find(p=>p.id==='team-plus');
  assert.ok(plan);assert.equal(plan.enabled,false);
  settings=await service.editPlan('update',{version:settings.version,id:plan.id,plan:{name:'Team Premium',products:[{...plan.products[0],credits:1234}]}},'root');
  assert.equal(settings.values.plans.find(p=>p.id===plan.id).version,'0.0.2');
  settings=await service.editPlan('version',{version:settings.version,id:plan.id},'root');
  assert.equal(settings.values.plans.find(p=>p.id===plan.id).version,'0.0.3');
  settings=await service.editPlan('archive',{version:settings.version,id:plan.id},'root');
  assert.equal(settings.values.plans.find(p=>p.id===plan.id).archived,true);
  settings=await service.editPlan('unarchive',{version:settings.version,id:plan.id},'root');
  assert.equal(settings.values.plans.find(p=>p.id===plan.id).enabled,false);
});
