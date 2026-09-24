import test from 'node:test';import assert from 'node:assert/strict';import {RedisCache} from '../dist/index.js';
test('Redis preserves falsy values, prefixes keys and sets millisecond TTL',async()=>{
 const rows=new Map();let ttl;
 const cache=new RedisCache({get:async key=>rows.get(key)??null,set:async(key,value,options)=>{rows.set(key,value);ttl=options.PX;},del:async key=>rows.delete(key)});
 assert.equal(await cache.get('missing'),undefined);await cache.set('x',false,123);assert.equal(ttl,123);assert.equal(rows.get('rt-app:cache:x'),'false');assert.equal(await cache.get('x'),false);await cache.delete('x');assert.equal(await cache.get('x'),undefined);
});
