import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,cp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {MemoryStore} from '@gsalgadotoledo/rt-app-dynamodb';
import {parse,normalize} from '../crud.mjs';

const here=fileURLToPath(new URL('.',import.meta.url));

test('--owned is parsed, validated and stored in the schema',async()=>{
 assert.equal((await parse(['notes','--fields','text:string','--owned'])).spec.owned,true);
 assert.equal((await parse(['notes','--fields','text:string'])).spec.owned,undefined);
 assert.throws(()=>normalize({name:'notes',fields:[{name:'text',type:'string'}],owned:'yes'}),/owned must be true or false/);
});

test('owned CRUD: each user sees and changes only their own records; managers keep full access',async t=>{
 // The template imports @gsalgadotoledo/* packages, so the copy lives inside this package tree.
 const dir=await mkdtemp(join(here,'.owned-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await mkdir(join(dir,'src'));await cp(join(here,'../templates/crud/src'),join(dir,'src'),{recursive:true});
 await writeFile(join(dir,'src/schema.json'),JSON.stringify(normalize({name:'notes',title:'Notes',fields:[{name:'text',type:'string'}],owned:true})));
 await writeFile(join(dir,'src/actions.js'),'export const actions = {};\n');
 const feature=(await import(pathToFileURL(join(dir,'src/index.js')).href)).default(new MemoryStore());
 const find=(method,path)=>feature.endpoints.find(e=>e.method===method&&e.path===path);
 const as=(id,body={},params={},query={})=>({request:{body,query},params,actor:{id}});
 const create=find('POST','/notes/mine'),list=find('GET','/notes/mine'),read=find('GET','/notes/mine/:id'),edit=find('PATCH','/notes/mine/:id'),remove=find('DELETE','/notes/mine/:id');
 assert.ok([create,list,read,edit,remove].every(e=>e.access==='authenticated'));
 const ana=await create.handle(as('ana',{text:'ana 1'}));await create.handle(as('leo',{text:'leo 1'}));
 assert.equal(ana.ownerId,'ana');
 assert.deepEqual((await list.handle(as('ana'))).items.map(n=>n.text),['ana 1']);
 assert.deepEqual((await list.handle(as('leo',{},{},{q:'1'}))).items.map(n=>n.text),['leo 1']);
 await assert.rejects(read.handle(as('leo',{},{id:ana.id})),e=>e.status===404,'another user reads 404');
 await assert.rejects(edit.handle(as('leo',{text:'hack',version:1},{id:ana.id})),e=>e.status===404);
 await assert.rejects(remove.handle(as('leo',{version:1},{id:ana.id})),e=>e.status===404);
 const edited=await edit.handle(as('ana',{text:'ana 2',version:1},{id:ana.id}));assert.equal(edited.text,'ana 2');
 await assert.rejects(edit.handle(as('ana',{text:'stale',version:1},{id:ana.id})),e=>e.status===409);
 assert.deepEqual(await remove.handle(as('ana',{version:2},{id:ana.id})),{ok:true});
 assert.deepEqual((await list.handle(as('ana'))).items,[]);
 // Managers (explicit grants on the permission endpoints) still see everyone's records.
 assert.equal((await find('GET','/notes').handle(as('root',{},{},{trash:'true'}))).items.length,1);
});
