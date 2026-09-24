import test from 'node:test';import assert from 'node:assert/strict';
import {NoSQLCache} from '../dist/index.js';import {Conflict} from '@gsalgadotoledo/rt-app-contracts';
test('NoSQL cache enforces TTL immediately and handles version conflicts',async()=>{
 let row,now=1000,fail=true;const store={get:async()=>row,transact:async([write])=>{if(fail){fail=false;throw new Conflict();}row=write.delete?undefined:write.row;}};
 const cache=new NoSQLCache(store,'test',()=>now);await cache.set('k',{ok:true},100);assert.deepEqual(await cache.get('k'),{ok:true});assert.equal(row.ttl,2);
 now=1100;assert.equal(await cache.get('k'),undefined);await cache.delete('k');assert.equal(row,undefined);
 await assert.rejects(cache.set('large','x'.repeat(65000),100),/64 KB/);
});
