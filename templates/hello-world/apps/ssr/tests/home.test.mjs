import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadHome} from '../app/home.mjs';
test('SSR reads the configured API without a shared response cache',async()=>{
 let calls=0;
 const request=async(url,options)=>{assert.equal(url,'https://api.example.test/');assert.equal(options.cache,'no-store');return Response.json({title:`Home ${++calls}`,content:'Description'});};
 assert.equal((await loadHome('https://api.example.test',request)).title,'Home 1');
 assert.equal((await loadHome('https://api.example.test',request)).title,'Home 2');
 await assert.rejects(()=>loadHome('https://api.example.test',async()=>new Response('',{status:503})),/could not load/);
 await assert.rejects(()=>loadHome('https://api.example.test',async()=>Response.json({})),/Invalid home/);
});
