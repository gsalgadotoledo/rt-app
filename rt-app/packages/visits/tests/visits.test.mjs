import test from 'node:test';import assert from 'node:assert/strict';import {Visits} from '../dist/index.js';import {Conflict} from '@gsalgadotoledo/rt-app-contracts';import {visitPoint,startVisitCapture} from '../browser.js';
function memory(){let row;return {get:async()=>structuredClone(row),transact:async([write])=>{if((row?.version??null)!==write.expected)throw new Conflict();row=structuredClone(write.row);}};}
const point={type:'click',path:'/',t:5,x:20,y:30};
test('keeps only latest 10 sessions, limits points, and expires sessions',async()=>{
 let now=1000;const visits=new Visits(memory(),'s'.repeat(64),undefined,()=>now);const tokens=[];
 for(let i=0;i<12;i++){now++;const session=visits.start('test');tokens.push(session.token);await visits.ingest({token:session.token,sequence:1,points:[point]},'test');}
 const list=await visits.list();assert.equal(list.items.length,10);assert.equal(list.items[0].startedAt,now);
 for(let i=2;i<=10;i++)await visits.ingest({token:tokens.at(-1),sequence:i,points:Array(20).fill(point)},'test');
 const detail=await visits.detail(list.items[0].id);assert.equal(detail.points.length,120);
 await visits.ingest({token:tokens.at(-1),sequence:10,points:[point]},'test');assert.equal((await visits.detail(detail.id)).points.length,120);
 await visits.remove(detail.id);await assert.rejects(visits.detail(detail.id),error=>error.status===404);
 now+=86400001;assert.equal((await visits.list()).items.length,0);
});
test('rejects tampering, private paths and invalid geometry and protects read routes',async()=>{
 const visits=new Visits(memory(),'s'.repeat(64)),{token}=visits.start('test');
 await assert.rejects(visits.ingest({token:token+'x',sequence:1,points:[point]},'test'));
 await assert.rejects(visits.ingest({token,sequence:1,points:[{...point,path:'/account?token=secret'}]},'test'));
 await assert.rejects(visits.ingest({token,sequence:1,points:[{...point,x:101}]},'test'));
 assert.ok(visits.feature().endpoints.filter(e=>e.method==='GET').every(e=>e.access==='owner'));
});
test('concurrent batches retain sessions using conditional writes',async()=>{
 const visits=new Visits(memory(),'s'.repeat(64));const a=visits.start('a'),b=visits.start('b');
 await Promise.all([a,b].map(session=>visits.ingest({token:session.token,sequence:1,points:[point]},'test')));assert.equal((await visits.list()).items.length,2);
});
test('browser geometry never reads text or form values, respects excluded elements, and imports on server',()=>{
 assert.equal(typeof startVisitCapture({apiUrl:'http://localhost'}),'function');
 assert.equal(visitPoint('click',{target:{closest:()=>true},clientX:5},'/',1,{width:100,height:100,scroll:0}),undefined);
 const value=visitPoint('click',{clientX:50,clientY:25,target:{closest:()=>false},password:'never'},'/',1,{width:100,height:100,scroll:0});
 assert.deepEqual(value,{type:'click',path:'/',t:1,x:50,y:25});assert.doesNotMatch(JSON.stringify(value),/password|never/);
});
