import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {mailConfig,verifyArchive,mailpitAsset,mailpitLaunch} from '../runtime.mjs';
import {LocalSmtpMailer} from '../dist/index.js';
import {LocalMailbox} from '@gsalgadotoledo/rt-app-auth';
test('configuration and archive integrity',()=>{
 assert.equal(mailConfig({}).url,'http://127.0.0.1:8025');
 assert.throws(()=>mailConfig({RT_APP_MAIL_UI_PORT:'1025'}));
 assert.throws(()=>mailConfig({RT_APP_MAIL_SMTP_PORT:'bad'}));
 assert.throws(()=>mailpitAsset('unsupported','x64'));
 const data=Buffer.from('verified');const asset={size:data.length,sha256:createHash('sha256').update(data).digest('hex')};
 verifyArchive(data,asset);assert.throws(()=>verifyArchive(Buffer.from('tampered'),asset));
});
const freePort=async()=>{const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(r=>server.close(r));return port;};
test('SMTP delivery, persistence, and isolation from forwarding settings',{timeout:90000},async()=>{
 const root=resolve('../../..');const dir=await mkdtemp(join(tmpdir(),'rt-app-mail-test-'));
 const smtpPort=await freePort(),uiPort=await freePort();
 const launch=await mailpitLaunch(root,{...process.env,RT_APP_MAIL_SMTP_PORT:String(smtpPort),RT_APP_MAIL_UI_PORT:String(uiPort),MP_SMTP_FORWARD_CONFIG:'must-not-load'});
 assert.equal(launch.env.MP_SMTP_FORWARD_CONFIG,undefined);
 launch.args[launch.args.indexOf('--database')+1]=join(dir,'mail.db');
 let child;
 const stop=async()=>{if(child&&child.exitCode===null){const exit=once(child,'exit');child.kill('SIGTERM');await exit;}child=null;};
 const start=async()=>{child=spawn(launch.command,launch.args,{env:launch.env,stdio:'ignore'});for(let i=0;i<100;i++){try{const r=await fetch(`${launch.url}/readyz`);if(r.ok)return;}catch{}await delay(50);}throw new Error('Mailpit failed to start');};
 try{
  await start();const capture=new LocalMailbox();const mailer=new LocalSmtpMailer({port:smtpPort,capture});
  await mailer.sendCode('developer@example.test','123456','password recovery');
  assert.equal(capture.messages.length,1);
  let data=await(await fetch(`${launch.url}/api/v1/messages`)).json();assert.equal(data.total,1);assert.equal(data.messages[0].Subject,'RT-App: password recovery');
  const message=await(await fetch(`${launch.url}/api/v1/message/${data.messages[0].ID}`)).json();assert.match(message.Text,/123456/);
  await stop();await start();data=await(await fetch(`${launch.url}/api/v1/messages`)).json();assert.equal(data.total,1);
  await stop();await assert.rejects(()=>mailer.sendCode('developer@example.test','654321','login'),/Local inbox is unavailable/);assert.equal(capture.messages.length,1);
 }finally{await stop();await rm(dir,{recursive:true,force:true});}
});
test('standalone CLI stops the inbox on SIGTERM',{timeout:30000},async()=>{
 const smtpPort=await freePort(),uiPort=await freePort();
 const child=spawn(process.execPath,['rt-app/cli/bin/rta.mjs','mail'],{cwd:resolve('../../..'),env:{...process.env,RT_APP_MAIL_SMTP_PORT:String(smtpPort),RT_APP_MAIL_UI_PORT:String(uiPort)},stdio:'ignore'});
 try{
  let ready=false;
  for(let i=0;i<100;i++){try{ready=(await fetch(`http://127.0.0.1:${uiPort}/readyz`)).ok;if(ready)break;}catch{}await delay(50);}
  assert.equal(ready,true);
  const exit=once(child,'exit');child.kill('SIGTERM');await exit;
  await assert.rejects(()=>fetch(`http://127.0.0.1:${uiPort}/readyz`));
 }finally{if(child.exitCode===null)child.kill('SIGTERM');}
});
