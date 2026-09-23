import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('explicit installer stays available after installation to allow environment expansion',async t=>{
 const {fork}=await import('node:child_process');
 const {fileURLToPath}=await import('node:url');
 const root=await mkdtemp(join(tmpdir(),'rt-app-setup-http-'));
 const children=[],capabilities=new Map();
 t.after(async()=>{for(const child of children)child.kill();await rm(root,{recursive:true,force:true});});
 async function launch(){
  const child=fork(fileURLToPath(new URL('../dist/web.js',import.meta.url)),[],{cwd:root,env:{...process.env,SETUP_PORT:'0',ADMIN_PASSWORD:'CLI-Root-Password-2026!'},stdio:['ignore','ignore','ignore','ipc']});
  children.push(child);
  return await new Promise((resolve,reject)=>{
   const timeout=setTimeout(()=>reject(new Error('startup timeout')),5000);
   child.once('message',message=>{clearTimeout(timeout);const u=new URL(message.setupUrl);capabilities.set(u.origin,new URLSearchParams(u.hash.slice(1)).get("setup"));resolve(u.origin);});
   child.once('error',error=>{clearTimeout(timeout);reject(error);});
  });
 }
 const first=await launch();
 assert.equal((await (await fetch(first+'/api/__dev/setup')).json()).installer,true);
 assert.equal((await fetch(first+'/api/setup/status')).status,401);
 const login=await fetch(first+'/api/admin/identity/auth/login',{method:'POST',headers:{'content-type':'application/json','x-setup-token':capabilities.get(first)},body:JSON.stringify({password:'CLI-Root-Password-2026!'})});
 assert.equal(login.status,200);
 const session=await login.json();
 assert.equal((await fetch(first+'/api/setup/status',{headers:{authorization:'Bearer '+session.token}})).status,200);
 await mkdir(join(root,'.rt-app'));
 await writeFile(join(root,'.rt-app/installation.json'),JSON.stringify({status:'ready',adminUrl:'https://admin.example.com'}));
 const complete=await (await fetch(first+'/api/__dev/setup')).json();
 assert.equal(complete.installer,true);
 assert.equal(complete.installed,false);
 children[0].kill();
 const restarted=await launch();
 assert.deepEqual(await (await fetch(restarted+'/api/__dev/setup')).json(),complete);
});
