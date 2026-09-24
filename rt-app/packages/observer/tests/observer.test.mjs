import test from 'node:test';
import assert from 'node:assert/strict';
import {Observer,ObserverStore,observerFeature,sanitize} from '../dist/index.js';
class Store {rows=new Map();async transact(writes){for(const w of writes)this.rows.set(w.row.pk+w.row.sk,w.row);}async list(pk){return {items:[...this.rows.values()].filter(r=>r.pk===pk)};}}
test('fan-out filters, disabling, redaction, failures and limits remain independent',async()=>{
 const delivered=[], observer=new Observer([{handler:{id:'all',write:e=>delivered.push(e)}},{handler:{id:'errors',write:e=>delivered.push({...e,id:'error'})},levels:['error'],maxPerMinute:1},{handler:{id:'disabled',write:()=>assert.fail()},enabled:false},{handler:{id:'broken',write:()=>{throw Error('private credential')}}}],20);
 await observer.info({password:'secret',authorization:'Bearer abc',email:'me@example.com'});
 await observer.error('token=abcdef');await observer.error('other');
 assert.equal(delivered.length,4);assert.equal(observer.health.failed,3);assert.equal(observer.health.dropped,1);
 assert.doesNotMatch(JSON.stringify(delivered),/abcdef|Bearer abc|me@example.com|"secret"/);
 assert.deepEqual(sanitize(new Error('sensitive')),{name:'Error'});
});
test('slow handlers do not block delivery indefinitely',async()=>{const observer=new Observer([{handler:{id:'slow',write:()=>new Promise(()=>{})}}],15);await observer.info('test');assert.equal(observer.health.failed,1);});
test('events survive a new reader and report site ranking / hourly counters / expiry',async()=>{
 const store=new Store(),storage=new ObserverStore(store),observer=new Observer([{handler:storage}]);
 await observer.emit('info','request','api','HTTP',{durationMs:20,status:200,path:'/users/:id'});
 await observer.emit('info','pageview','spa','View',{path:'/'});await observer.emit('info','pageview','spa','View',{path:'/'});await observer.emit('info','pageview','ssr','View',{path:'/about'});
 const report=await new ObserverStore(store).report(new Date().toISOString().slice(0,10));assert.deepEqual(report.counts,{requests:1,errors:0,spa:2,ssr:1});assert.equal(report.pages[0].views,2);assert.equal(report.averageMs,20);assert.ok([...store.rows.values()].every(r=>r.ttl>Date.now()/1000));
 await assert.rejects(storage.report('2026-02-30'),/Invalid day/);
});
test('public analytics validates payloads, rate limits IPs, and protects reporting',async()=>{
 const storage=new ObserverStore(new Store()),observer=new Observer([{handler:storage}]),feature=observerFeature(observer,storage),ingest=feature.endpoints.find(e=>e.method==='POST');
 assert.equal(feature.endpoints[0].access,'owner');
 const context={request:{ip:'127.0.0.1',body:{source:'spa',path:'/?token=private'}}};
 await assert.rejects(ingest.handle(context),/Invalid page/);context.request.body.path='/';
 for(let i=0;i<60;i++)await ingest.handle(context);
 await assert.rejects(ingest.handle(context),/Too many/);
});
test('dedicated helpers normalize URLs, retain messages, and aggregate weighted request means',async()=>{
 const storage=new ObserverStore(new Store()),observer=new Observer([{handler:storage}]);
 await observer.countView('Home',{url:'https://user:password@example.test/home?token=secret#private',apiUrl:'https://api.test/v1?key=secret',source:'ssr'});
 await observer.recordRequest({method:'get',url:'/users/:id?token=secret',durationMs:10,status:200});
 await observer.recordRequest({method:'get',url:'/users/:id',durationMs:30,status:500});
 await observer.recordRequest({method:'post',url:'/orders',durationMs:80,status:200});
 await observer.warning('Retrying',{attempt:2});
 const report=await storage.report(new Date().toISOString().slice(0,10));
 assert.equal(report.averageMs,40);assert.equal(report.requestMetrics[0].averageMs,20);assert.equal(report.requestMetrics[0].count,2);assert.equal(report.requestMetrics[0].errors,1);
 const view=report.events.find(e=>e.kind==='pageview');assert.equal(view.message,'Home');assert.equal(view.data.path,'/home');assert.equal(view.data.endpointPath,'/v1');assert.doesNotMatch(JSON.stringify(view),/password|secret|private/);
 assert.equal(report.events.find(e=>e.level==='warn').message,'Retrying');
 assert.throws(()=>observer.recordRequest({method:'GET',url:'/',durationMs:NaN,status:200}),/Invalid/);
});
test('measure returns results and rethrows the same error while recording separate timings',async()=>{
 const storage=new ObserverStore(new Store()),observer=new Observer([{handler:storage}]),failure=Error('private');
 assert.equal(await observer.measure('lookup',()=>42),42);
 await assert.rejects(observer.measure('lookup',async()=>{throw failure;}),e=>e===failure);
 const report=await storage.report(new Date().toISOString().slice(0,10));
 assert.equal(report.counts.requests,0);assert.equal(report.operationMetrics[0].count,2);assert.equal(report.operationMetrics[0].errors,1);assert.ok(report.operationMetrics[0].averageMs>=0);
});

test('categories, predicates, request isolation and output-free operation',async()=>{
 const events=[];
 const observer=new Observer([{handler:{id:'mail',write:event=>events.push(event)},levels:['error'],categories:['payments'],filter:event=>event.message.includes('declined')},{handler:{id:'bad-filter',write:()=>assert.fail()},filter:()=>{throw Error('filter');}}]);
 await Promise.all(['a','b'].map(requestId=>observer.withContext({requestId,category:'payments'},async()=>{await new Promise(r=>setTimeout(r,requestId==='a'?10:1));await observer.error('declined');})));
 await observer.write('info','declined',{category:'payments'});
 await observer.write('error','declined',{category:'users'});
 assert.deepEqual(events.map(e=>e.requestId).sort(),['a','b']);assert.equal(observer.health.failed,4);
 await new Observer([]).error('No outputs');
});

test('log search validates filters and preserves continuation on empty filtered pages',async()=>{
 const at=new Date().toISOString();
 const reader=new ObserverStore({list:async(pk,cursor)=>({items:cursor?[{data:{id:'2',at,level:'error',category:'payments',message:'declined',data:{}}}]:[{data:{id:'1',at,level:'debug',message:'hidden',data:{}}}],cursor:cursor?undefined:'next'})});
 const query={day:at.slice(0,10),category:'payments',text:'DECLINED'};
 const first=await reader.search(query);assert.equal(first.events.length,0);assert.equal(first.cursor,'next');
 const second=await reader.search({...query,cursor:first.cursor});assert.equal(second.events[0].id,'2');
 await assert.rejects(reader.search({...query,level:'invalid'}),/Invalid level/);
 const endpoint=observerFeature(new Observer(),reader).endpoints.find(e=>e.path==='/observer/logs');assert.equal(endpoint.access,'owner');
});
