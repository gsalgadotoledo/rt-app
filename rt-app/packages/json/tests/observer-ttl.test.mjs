import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {JsonStore} from '../dist/index.js';
test('local writes remove expired observer events while preserving application records',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'observer-ttl-'));
 try {const store=new JsonStore(join(dir,'db.json')),expired=Math.floor(Date.now()/1000)-1;
 await store.transact([{row:{pk:'OBSERVER#old',sk:'old',version:1,data:{},ttl:expired},expected:null},{row:{pk:'USERS',sk:'kept',version:1,data:{name:'User'}},expected:null}]);
 assert.equal(await store.get('OBSERVER#old','old'),undefined);assert.equal((await store.get('USERS','kept')).data.name,'User');
 }finally{await rm(dir,{recursive:true,force:true});}
});
