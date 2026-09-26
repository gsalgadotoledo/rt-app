import test from 'node:test';
import assert from 'node:assert/strict';
import {planIdFromName} from '../dist/plan-id.js';
import {currencyCodes,currencyDecimals,majorAmount,validCurrency,validMinorAmount} from '../dist/currency.js';
test('name-derived IDs normalize accents, stay bounded and avoid collisions',()=>{
 assert.equal(planIdFromName('Plan Élite +'), 'plan-elite');
 assert.equal(planIdFromName('Team Plus',['team-plus','team-plus-2']),'team-plus-3');
 assert.equal(planIdFromName('!!!'),'new-plan');
 assert.ok(planIdFromName('a'.repeat(500)).length<=100);
});
test('currency catalog and minor units cover zero, two and three decimal currencies',()=>{
 assert.ok(currencyCodes.length>140);assert.equal(validCurrency('jpy'),true);assert.equal(validCurrency('fake'),false);
 assert.equal(majorAmount(500000,'cop'),5000);assert.equal(currencyDecimals('cop'),2);
 assert.equal(majorAmount(2000,'usd'),20);assert.equal(majorAmount(2000,'jpy'),2000);
 assert.equal(currencyDecimals('kwd'),3);assert.equal(majorAmount(1000,'kwd'),1);
 assert.equal(majorAmount(500,'isk'),5);assert.equal(validMinorAmount(501,'isk'),false);
 assert.equal(currencyDecimals('mga'),0);
});
test('Stripe prices created outside the app (Terraform) link to plans without changing versions',async()=>{
 const {MemoryStore}=await import('@gsalgadotoledo/rt-app-dynamodb');
 const {Subscriptions}=await import('../dist/index.js');
 const store=new MemoryStore();const service=new Subscriptions(store,undefined,async()=>{},()=>Date.UTC(2026,8,1));
 assert.deepEqual(await service.linkStripePrices({pro:{productId:'prod_1',priceId:'price_1'},max:{productId:'prod_2',priceId:'price_2'}},'terraform'),['pro','max']);
 const plans=(await service.settings()).values.plans;
 assert.deepEqual(plans.filter(p=>p.stripePriceId).map(p=>[p.id,p.stripeProductId,p.stripePriceId,p.version]),[['pro','prod_1','price_1','0.0.1'],['max','prod_2','price_2','0.0.1']]);
 assert.deepEqual(await service.linkStripePrices({pro:{productId:'prod_1',priceId:'price_1'}},'terraform'),[],'linking again changes nothing');
 await assert.rejects(service.linkStripePrices({missing:{productId:'prod_1',priceId:'price_1'}},'t'),/Plan not found/);
 await assert.rejects(service.linkStripePrices({pro:{productId:'prod_1',priceId:'sk_live_x'}},'t'),/Invalid Stripe ids/);
 await assert.rejects(service.linkStripePrices({pro:{productId:'prod_1',priceId:'price_2'}},'t'),/one plan only/);
 const audit=(await store.list('SUB_AUDIT')).items.map(r=>r.data.action);
 assert.deepEqual(audit,['link-stripe-prices']);
});
