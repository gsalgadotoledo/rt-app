import { manifestFixture } from './manifest-fixture.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer,connect} from 'node:net';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ensureDaemon,request,defaultBinary} from '../client.mjs';
const free=async()=>{const s=createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p;};
async function wait(root,id,state){for(let i=0;i<150;i++){const item=(await request(root,'status')).services.find(s=>s.id===id);if(item.state===state)return item;await delay(100);}throw new Error(`${id} did not become ${state}: ${JSON.stringify(await request(root,'status'))}`);}
test('shared supervisor: dependencies, logs, secrets, restart, occupied ports and child cleanup',{timeout:120000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'rt-app-supervisor-'));const port=await free(),childPort=await free();
 const external=createServer();external.listen(0,'127.0.0.1');await once(external,'listening');const occupied=external.address().port;
 const prior=process.env.RT_TEST_SECRET;process.env.RT_TEST_SECRET='PRIVATE-SUPERVISOR-TEST';
 const script=`const {spawn}=require('node:child_process');spawn(process.execPath,['-e',"require('node:net').createServer().listen(${childPort},'127.0.0.1')"],{stdio:'ignore'});console.log(process.env.RT_TEST_SECRET);console.error('example stderr');require('node:http').createServer((q,r)=>r.end('ok')).listen(${port},'127.0.0.1');`;
 const base={cwd:'.',env:{},inheritEnv:[],dependencies:[],ports:[]};
 await writeFile(join(root,'package.json'),JSON.stringify({name:'fixture',rtApp:{}}));
 await writeFile(join(root,'rt-app.settings.json'),JSON.stringify({version:1,runtime:{local:{mode:'json'},aws:{mode:'aws'}},services:{defaults:false,extra:[
 {...base,id:'prepare',label:'Prepare',kind:'task',command:[process.execPath,'-e',"console.log('prepared')"]},
 {...base,id:'api',label:'API',command:[process.execPath,'-e',script],inheritEnv:['RT_TEST_SECRET'],dependencies:['prepare'],ports:[port,childPort],url:`http://127.0.0.1:${port}`,readyUrl:`http://127.0.0.1:${port}/`},
 {...base,id:'failure',label:'Failure',command:[process.execPath,'-e',"console.error('intentional failure');process.exit(7)"]},
 {...base,id:'occupied',label:'Occupied',command:[process.execPath,'-e','setInterval(()=>{},1000)'],ports:[occupied]},
 ]}}));
 try{
  assert.equal((await ensureDaemon(root)).started,true);assert.equal((await ensureDaemon(root)).started,false);
  await request(root,'start','all');const first=await wait(root,'api','running');await wait(root,'occupied','blocked');const failed=await wait(root,'failure','failed');assert.equal(failed.exitCode,7);
  const logs=await request(root,'logs','api');assert.ok(logs.some(l=>l.text.includes('[redacted]')));assert.ok(logs.some(l=>l.stream==='stderr'));assert.doesNotMatch(JSON.stringify(logs),/PRIVATE-SUPERVISOR-TEST/);
  const {stdout}=await promisify(execFile)(defaultBinary,['status','--project',root,'--json']);assert.equal(JSON.parse(stdout).services.find(s=>s.id==='api').pid,first.pid);
  await request(root,'restart','api');for(let i=0;i<100;i++){const s=await wait(root,'api','running');if(s.pid!==first.pid)break;if(i===99)throw new Error('PID did not change');await delay(100);}
  await request(root,'stop','prepare');await wait(root,'api','stopped');
  const probe=createServer();probe.listen(childPort,'127.0.0.1');await once(probe,'listening');await new Promise(r=>probe.close(r));assert.equal(external.listening,true);
  await assert.rejects(()=>request(root,'execute','anything'),/Unknown action/);
 }finally{
  await request(root,'shutdown').catch(()=>{});for(let i=0;i<60;i++){try{await request(root,'status');await delay(100);}catch{break;}}
  await new Promise(r=>external.close(r));await rm(root,{recursive:true,force:true});if(prior===undefined)delete process.env.RT_TEST_SECRET;else process.env.RT_TEST_SECRET=prior;
 }
});

test('default services select existing scripts and respect optional build/mail',async(t)=>{
 const {manifest}=await import('../client.mjs');const root=await manifestFixture(t);
 const config=await manifest(root,{noBuild:true,noMail:true});
 assert.equal(config.services.find(s=>s.id==='api').command[2],'dev');
 assert.equal(config.services.find(s=>s.id==='ssr').command[2],'dev');
 assert.equal(config.services.some(s=>s.id==='build'||s.id==='mail'),false);
 assert.equal(config.services.find(s=>s.id==='api').env.RT_APP_TARGET,'local');
 assert.equal(config.services.find(s=>s.id==='api').env.RT_APP_MAIL_TRANSPORT,'memory');
});
