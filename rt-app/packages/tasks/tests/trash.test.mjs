import test from 'node:test';
import assert from 'node:assert/strict';
import {MemoryStore} from '@gsalgadotoledo/rt-app-dynamodb';
import {tasksFeature} from '../dist/index.js';
test('tasks preserve tombstones, ownership checks and audit on restore',async()=>{
 const store=new MemoryStore(),feature=tasksFeature(store);
 const run=(method,path,id,body={},query={},actor='a')=>feature.endpoints.find(e=>e.method===method&&e.path===path).handle({params:{id},request:{body,query},actor:{id:actor,role:'user',grants:[]}});
 const item=await run('POST','/tasks',undefined,{title:'Test'});assert.equal(item.createdBy,'a');
 await run('DELETE','/tasks/:id',item.id);
 assert.equal((await run('GET','/tasks')).items.length,0);
 assert.equal((await run('GET','/tasks',undefined,{}, {trash:'true'})).items[0].deletedBy,'a');
 await assert.rejects(run('POST','/tasks/:id/restore',item.id,{}, {},'b'),e=>e.status===403);
 await assert.rejects(run('PATCH','/tasks/:id',item.id,{title:'Bad'}),e=>e.status===404);
 await run('POST','/tasks/:id/restore',item.id);
 const restored=(await run('GET','/tasks')).items[0];assert.equal(restored.id,item.id);assert.equal(restored.restoredBy,'a');assert.equal(restored.deletedAt,null);
});
