import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {FileCache} from '../dist/index.js';
test('file cache persists, deletes and shares entries with a new instance',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'rt-cache-'));
 try{const path=join(dir,'cache.json'),cache=new FileCache(path);await cache.set('key',false,60000);const second=new FileCache(path);assert.equal(await second.get('key'),false);await second.delete('key');assert.equal(await cache.get('key'),undefined);}finally{await rm(dir,{recursive:true,force:true});}
});
test('an injected clock drives logical expiry',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'rt-cache-'));
 try{let now=4102444800000;const cache=new FileCache(join(dir,'c.json'),'default',()=>now);await cache.set('k',1,100);assert.equal(await cache.get('k'),1);now+=100;assert.equal(await cache.get('k'),undefined);}finally{await rm(dir,{recursive:true,force:true});}
});
