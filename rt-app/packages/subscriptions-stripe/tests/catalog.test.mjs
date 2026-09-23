import test from 'node:test';
import assert from 'node:assert/strict';
import {StripeCatalog} from '../dist/index.js';
function fixture(){
 const products=new Map(),prices=new Map(); let creations=0,failArchive=false;
 const publisher=new StripeCatalog('sk_test_fake');
 publisher.stripe={products:{retrieve:async id=>{if(!products.has(id))throw Object.assign(new Error('missing'),{code:'resource_missing'});return products.get(id);},create:async p=>{creations++;products.set(p.id,{...p});return products.get(p.id);},update:async(id,p)=>{if(failArchive&&p.active===false)throw new Error('offline');const old=products.get(id);Object.assign(old,{...p,metadata:{...old.metadata,...p.metadata}});return old;}},prices:{list:async q=>({data:[...prices.values()].filter(p=>q.lookup_keys.includes(p.lookup_key))}),create:async p=>{const price={...p,id:'price_'+prices.size};prices.set(price.id,price);return price;},retrieve:async id=>prices.get(id),update:async(id,p)=>{const old=prices.get(id);Object.assign(old,{...p,metadata:{...old.metadata,...p.metadata}});return old;}}};
 return{publisher,products,prices,creations:()=>creations,fail:()=>{failArchive=true;},recover:()=>{failArchive=false;}};
}
const plan={id:'max',family:'max',version:'0.0.1',name:'Max',amount:5000,currency:'usd',periodDays:30,products:[],enabled:true};
test('catalog creates one product per version and archives old versions without duplication on retry',async()=>{
 const f=fixture();const first=await f.publisher.publish(plan,'namespace');
 assert.deepEqual(await f.publisher.publish(plan,'namespace'),first);assert.equal(f.creations(),1);assert.equal(f.prices.size,1);
 const next={...plan,version:'0.0.2',amount:6000}; f.fail();
 await assert.rejects(f.publisher.publish(next,'namespace',{...plan,...first}),/offline/);
 f.recover();const second=await f.publisher.publish(next,'namespace',{...plan,...first});
 assert.equal(f.creations(),2);assert.equal(f.prices.size,2);
 assert.equal(f.products.get(first.stripeProductId).active,false);
 assert.equal(f.products.get(first.stripeProductId).metadata.State,'Disabled');
 assert.equal(f.products.get(second.stripeProductId).metadata.B_version,'0.0.2');
 assert.equal(f.products.get(second.stripeProductId).metadata.family,'max');
 assert.equal(f.prices.get(second.stripePriceId).recurring.interval_count,30);
});
test('catalog rejects mutation of an immutable price and foreign archive targets',async()=>{
 const f=fixture();const first=await f.publisher.publish(plan,'namespace');
 await assert.rejects(f.publisher.publish({...plan,amount:1},'namespace'),/immutable/);
 f.products.get(first.stripeProductId).metadata.rtAppCatalog='foreign';
 await assert.rejects(f.publisher.publish({...plan,version:'0.0.2'},'namespace',{...plan,...first}),/another catalog/);
 assert.equal(f.products.get(first.stripeProductId).active,true);
});
