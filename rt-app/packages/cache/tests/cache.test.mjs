import test from 'node:test';import assert from 'node:assert/strict';
import {Cache,MemoryCache,contentKey,canonical} from '../dist/index.js';
test('stable keys distinguish arrays, namespaces and invalid JSON',()=>{
 assert.equal(contentKey('x',{a:1,b:2}),contentKey('x',{b:2,a:1}));
 assert.notEqual(contentKey('x',[1,2]),contentKey('x',[2,1]));assert.notEqual(contentKey('x',1),contentKey('y',1));
 for(const value of [undefined,NaN,BigInt(1),new Date()])assert.throws(()=>canonical(value));
 const cyclic={};cyclic.self=cyclic;assert.throws(()=>canonical(cyclic));
});
test('memory enforces expiry, capacity and mutation isolation',async()=>{
 let now=0;const store=new MemoryCache(2,()=>now);await store.set('a',{v:1},10);await store.set('b',false,10);
 const copy=await store.get('a');copy.v=5;assert.equal((await store.get('a')).v,1);
 await store.set('c',null,10);assert.equal(await store.get('b'),undefined);assert.equal(await store.get('c'),null);
 now=11;assert.equal(await store.get('a'),undefined);await assert.rejects(store.set('x',1,0));
});
test('remember deduplicates in-flight work and never caches failures',async()=>{
 const cache=new Cache();let calls=0;
 const load=async()=>{calls++;await new Promise(r=>setTimeout(r,10));return {a:1};};
 const values=await Promise.all([cache.remember('test',{id:1},100,load),cache.remember('test',{id:1},100,load)]);
 assert.equal(calls,1);values[0].a=3;assert.equal(values[1].a,1);
 await assert.rejects(cache.remember('fail',1,100,()=>{throw Error('failed');}));
 assert.equal(await cache.remember('fail',1,100,()=>2),2);
});
