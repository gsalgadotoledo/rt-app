import test from 'node:test';import assert from 'node:assert/strict';import {FeatureFlags} from '../dist/index.js';import {Conflict} from '@gsalgadotoledo/rt-app-contracts';
const makeStore=()=>{const rows=new Map();return {get:async(pk,sk)=>structuredClone(rows.get(sk)),transact:async writes=>{for(const w of writes){if((rows.get(w.row.sk)?.version??null)!==w.expected)throw new Conflict();rows.set(w.row.sk,structuredClone(w.row));}},list:async()=>({items:[...rows.values()]})};};
const definition={description:'Test',enabled:true,public:false,rollout:50,subjects:['vip']};
test('flags are stable, fail closed, hide private flags and enforce optimistic writes',async()=>{
 const flags=new FeatureFlags(makeStore());assert.equal(await flags.enabled('missing'),false);
 const created=await flags.save('checkout',definition,null,'root');assert.equal(created.version,1);assert.equal(await flags.enabled('checkout','vip'),true);assert.equal(await flags.enabled('checkout','vip',true),false);
 assert.equal(await flags.enabled('checkout','person'),await flags.enabled('checkout','person'));
 await assert.rejects(flags.save('checkout',definition,null,'root'),Conflict);
 await flags.save('checkout',{...definition,enabled:false},1,'root');assert.equal(await flags.enabled('checkout','vip'),false);
 await assert.rejects(flags.save('bad/key',definition,null,'root'));await assert.rejects(flags.save('x',{...definition,rollout:101},null,'root'));
 const edit=flags.feature().endpoints.find(e=>e.method==='PUT');assert.equal(edit.access,'owner');
});
test('public evaluator returns booleans without rules or subject lists',async()=>{
 const flags=new FeatureFlags(makeStore());await flags.save('test',{...definition,public:true,rollout:100},null,'root');
 const evaluate=flags.feature().endpoints.find(e=>e.path.endsWith('/evaluate'));
 assert.deepEqual(await evaluate.handle({request:{body:{keys:['test','unknown']}}}),{test:true,unknown:false});
});
