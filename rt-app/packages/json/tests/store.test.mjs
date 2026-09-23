import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {JsonStore} from '../dist/index.js';
const row=(sk,version=1)=>({pk:'p',sk,version,data:{value:sk}});
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'rta-json-'));t.after(()=>rm(dir,{recursive:true,force:true}));return join(dir,'db.json');}
test('persists transactions and only one concurrent conditional update wins',async t=>{
 const file=await fixture(t),a=new JsonStore(file),b=new JsonStore(file);
 await a.transact([{row:row('a'),expected:null}]);
 assert.deepEqual(await b.get('p','a'),row('a'));
 const results=await Promise.allSettled([a,b].map(s=>s.transact([{row:row('a',2),expected:1}])));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal((await new JsonStore(file).get('p','a')).version,2);
 await assert.rejects(a.transact([{row:row('b'),expected:null},{row:row('a',3),expected:1}]));
 assert.equal(await b.get('p','b'),undefined);
});
test('pagination is partition-bound; returned objects cannot mutate stored data',async t=>{
 const s=new JsonStore(await fixture(t));await s.transact(Array.from({length:51},(_,i)=>({row:row(String(i).padStart(3,'0')),expected:null})));
 const first=await s.list('p');assert.equal(first.items.length,50);first.items[0].data.value='changed';
 assert.equal((await s.get('p','000')).data.value,'000');assert.equal((await s.list('p',first.cursor)).items.length,1);
 assert.throws(()=>s.list('other',first.cursor),/cursor/);
});
test('corrupt data and stale locks fail closed',async t=>{
 const file=await fixture(t);await writeFile(file,'broken');const s=new JsonStore(file,30);
 await assert.rejects(s.transact([{row:row('a'),expected:null}]));assert.equal(await readFile(file,'utf8'),'broken');
 await writeFile(file+'.lock','');await assert.rejects(s.get('p','a'),/locked/);
});
test('separate processes cannot both claim the same key',async t=>{
 const {spawn}=await import('node:child_process');const file=await fixture(t);
 const moduleURL=new URL('../dist/index.js',import.meta.url).href;
 const results=await Promise.all([0,1].map(()=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['--input-type=module','-e',`import {JsonStore} from ${JSON.stringify(moduleURL)};try {await new JsonStore(process.argv[1]).transact([{row:{pk:'p',sk:'once',version:1,data:{}},expected:null}]);}catch(e){if(e.constructor.name==='Conflict')process.exitCode=2;else throw e;}`,file],{stdio:'pipe'});
  let error='';child.stderr.on('data',chunk=>error+=chunk);child.on('error',reject);child.on('exit',code=>code===0||code===2?resolve(code):reject(new Error(error)));
 })));
 assert.deepEqual(results.sort(),[0,2]);assert.equal((await new JsonStore(file).list('p')).items.length,1);
});
