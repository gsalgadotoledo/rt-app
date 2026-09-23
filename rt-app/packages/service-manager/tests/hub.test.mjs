import { manifestFixture } from './manifest-fixture.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {ServiceHub} from '../hub.mjs';
import {request,manifest} from '../client.mjs';
async function free(){const s=createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const port=s.address().port;await new Promise(r=>s.close(r));return port;}
async function wait(root,id,state){for(let i=0;i<150;i++){const s=(await request(root,'status')).services.find(s=>s.id===id);if(s.state===state)return s;await delay(100);}throw new Error('State timed out');}
test('projects share one global service; port edits persist and restart consumers, invalid ports preserve running processes',{timeout:120000},async()=>{
 const folder=await mkdtemp(join(tmpdir(),'rt-hub-')),home=join(folder,'shared'),a=join(folder,'a'),b=join(folder,'b');
 for(const dir of [home,a,b])await mkdir(dir);
 const smtp=await free(),mail=await free();
 await writeFile(join(home,'settings.json'),JSON.stringify({version:1,ports:{smtp,mail},mailCommand:[process.execPath,'-e',"require('node:http').createServer((q,r)=>r.end('ok')).listen(Number(process.env.RT_APP_MAIL_UI_PORT),'127.0.0.1')"],extra:[]}));
 for(const root of [a,b]){
  await writeFile(join(root,'package.json'),JSON.stringify({name:root===a?'project-a':'project-b'}));
  await writeFile(join(root,'rt-app.settings.json'),JSON.stringify({version:1,runtime:{local:{mode:'json'}},services:{defaults:false,extra:[{id:'api',label:'API',cwd:'.',command:[process.execPath,'-e',"console.log(process.env.RT_APP_API_URL);setInterval(()=>{},1000)"],ports:[],dependencies:[]}]}}));
 }
 const hub=new ServiceHub({home});await hub.initialize();
 try{
  await hub.select(a);await hub.action('start','project:all');const first=await wait(a,'api','running');const shared=await wait(home,'mail','running');
  const aPorts=(await hub.snapshot()).projectPorts;await hub.select(b);const bPorts=(await hub.snapshot()).projectPorts;assert.notEqual(aPorts.api,bPorts.api);
  await hub.action('start','project:all');await wait(b,'api','running');assert.equal((await wait(home,'mail','running')).pid,shared.pid);
  const bBefore=await wait(b,'api','running');await hub.action('restart','project:all');assert.notEqual((await wait(b,'api','running')).pid,bBefore.pid);assert.equal((await wait(a,'api','running')).pid,first.pid);assert.equal((await wait(home,'mail','running')).pid,shared.pid);
  await hub.action('stop','project:all');await wait(b,'api','stopped');assert.equal((await wait(a,'api','running')).pid,first.pid);assert.equal((await wait(home,'mail','running')).pid,shared.pid);
  await hub.select(a);const port=await free();await hub.setPorts('project',{...aPorts,api:port});const after=await wait(a,'api','running');assert.notEqual(after.pid,first.pid);
  for(let i=0;i<30;i++){if((await hub.logs('api')).some(l=>l.text===`http://localhost:${port}`))break;await delay(100);}
  assert.ok((await hub.logs('api')).some(l=>l.text===`http://localhost:${port}`));assert.equal(JSON.parse(await readFile(join(a,'rt-app.settings.json'))).local.ports.api,port);
  await assert.rejects(()=>hub.setPorts('project',{...aPorts,api:bPorts.api}),/reserved/);
  assert.equal((await wait(a,'api','running')).pid,after.pid);
  const newMail=await free();await hub.setPorts('global',{smtp,mail:newMail});await wait(home,'mail','running');assert.notEqual((await wait(a,'api','running')).pid,after.pid);
  assert.equal(await hub.url('global:mail'),`http://localhost:${newMail}/`);
 }finally{
  for(const dir of [a,b,home])await request(dir,'shutdown').catch(()=>{});await delay(600);await rm(folder,{recursive:true,force:true});
 }
});
test('default manifest injects selected URLs, SMTP port and project-only dependencies',async(t)=>{
 const root=await manifestFixture(t);
 const settings=JSON.parse(await readFile(join(root,'rt-app.settings.json')));settings.local={ports:{api:14010,admin:15174,spa:15175,ssr:15176}};
 const config=await manifest(root,{settings,sharedMail:{smtp:11025,mail:18025}});
 assert.equal(config.services.some(s=>s.id==='mail'),false);
 for(const s of config.services){assert.equal(s.env.RT_APP_API_URL,'http://localhost:14010');assert.equal(s.dependencies.includes('mail'),false);}
 const api=config.services.find(s=>s.id==='api');assert.equal(api.env.PORT,'14010');assert.equal(api.env.RT_APP_MAIL_SMTP_PORT,'11025');
 assert.equal(config.services.find(s=>s.id==='ssr').url,'http://localhost:15176');
});

test('custom service port bindings update environment without rewriting command arguments',async()=>{
 const root=new URL('../../../..',import.meta.url).pathname;
 const settings={version:1,runtime:{local:{mode:'json'}},services:{defaults:false,extra:[{id:'postgres',cwd:'.',command:['postgres','-D','.rt-app/postgres'],ports:[15432],portEnv:['PGPORT']}]}};
 const config=await manifest(root,{settings,sharedMail:{smtp:1025,mail:8025},sharedEnv:{REDIS_PORT:'16379'}});
 assert.equal(config.services[0].env.PGPORT,'15432');assert.equal(config.services[0].env.REDIS_PORT,'16379');
 assert.deepEqual(config.services[0].command,['postgres','-D','.rt-app/postgres']);
});
