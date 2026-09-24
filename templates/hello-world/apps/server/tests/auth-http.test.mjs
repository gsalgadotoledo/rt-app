import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {get} from 'node:http';
import {totpCode} from '@gsalgadotoledo/rt-app-auth/totp';
test('HTTP starter works without AWS and retains JSON authentication across server restarts',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'rta-auth-http-'));let child;
 async function stop(){if(child&&child.exitCode===null){const exit=once(child,'exit');child.kill('SIGTERM');await exit;}child=undefined;}
 t.after(async()=>{await stop();await rm(dir,{recursive:true,force:true});});
 const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
 const base='http://127.0.0.1:'+port,password='Local-test-password-2026!';
 async function start(){
  const env={...process.env,RT_APP_MODE:'json',RT_APP_JSON_FILE:join(dir,'db.json'),PORT:String(port),RT_APP_ADMIN_URL:'http://localhost:15174',NODE_ENV:'development'};
  for(const key of Object.keys(env))if(key.startsWith('AWS_')||key.startsWith('COGNITO_')||['AUTH_PROVIDER','DEMO_PASSWORD','ADMIN_PASSWORD'].includes(key))delete env[key];
  child=spawn(process.execPath,[fileURLToPath(new URL('../dist/index.js',import.meta.url))],{env,stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Startup timeout')),10000);child.stdout.on('data',b=>{if(String(b).includes('RT-App API:')){clearTimeout(timer);resolve();}});child.once('exit',code=>{clearTimeout(timer);reject(new Error('Server exited '+code));});child.once('error',reject);});
 }
 const call=async(path,body,token)=>{const response=await fetch(base+path,{method:body?'POST':'GET',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,...await response.json()};};
 await start();assert.equal((await call('/auth/methods')).provider,'local');
 assert.equal((await call('/__dev/setup')).adminAuth,'local');
 const customOrigin=await fetch(base+'/admin/modules',{headers:{origin:'http://localhost:15174'}});assert.equal(customOrigin.status,200);
 for(const path of ['/admin/modules','/__dev/setup']) {
  assert.equal((await fetch(base+path,{headers:{origin:'http://untrusted.invalid'}})).status,403);
  assert.equal(await new Promise((resolve,reject)=>get(base+path,{headers:{host:'untrusted.invalid'}},res=>{res.resume();resolve(res.statusCode);}).on('error',reject)),403);
 }
 assert.equal((await call('/admin/app/users',{email:'user@example.test',name:'User',password})).status,200);
 const session=await call('/auth/login',{email:'user@example.test',password});assert.ok(session.token);
 const enroll=await call('/auth/mfa/setup',{password},session.token);assert.ok(enroll.secret);
 const now=Math.floor(Date.now()/30000);const enabled=await call('/auth/mfa/enable',{challengeId:enroll.challengeId,code:totpCode(enroll.secret,now)},session.token);assert.equal(enabled.status,200);
 assert.equal((await call('/users/me',undefined,session.token)).status,401);
 const flow=await call('/auth/login',{email:'user@example.test',password});assert.equal(flow.challenge,'totp');assert.equal(flow.token,undefined);
 const final=await call('/auth/mfa/verify',{challengeId:flow.challengeId,code:totpCode(enroll.secret,Math.floor(Date.now()/30000)+1)});assert.ok(final.token);
 assert.equal((await call('/auth/mfa/reset',{userId:final.user.id},final.token)).status,403);
 await stop();await start();assert.equal((await call('/users/me',undefined,final.token)).status,200);
 assert.equal((await call('/auth/login',{email:'user@example.test',password})).challenge,'totp');
});
