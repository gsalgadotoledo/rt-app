import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {JsonStore} from '@gsalgadotoledo/rt-app-json';
import {Users} from '@gsalgadotoledo/rt-app-users';
import {Auth,LocalMailbox} from '../dist/index.js';
import {totpCode} from '../dist/totp.js';
import {JwtTokens} from '@gsalgadotoledo/rt-app-jwt';
const password='Test-password-only-2026!';
const secret='test-encryption-key-'.repeat(4);
async function setup(t,provider){
 const dir=await mkdtemp(join(tmpdir(),'rta-auth-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=join(dir,'db.json'),store=new JsonStore(file),users=new Users(store,provider),mail=new LocalMailbox();
 const auth=new Auth(users,new JwtTokens(secret),mail,secret,provider);
 const user=await users.create({name:'Test',email:'test@example.test',password});
 return {file,store,users,mail,auth,user};
}
test('local JSON credentials, recovery and TOTP survive rebuilding the runtime; codes cannot be reused',async t=>{
 const {file,store,users,mail,auth,user}=await setup(t);
 assert.match(user.data.passwordHash,/^scrypt\$/);
 const first=await auth.login(user.data.email,password,'one');assert.ok(first.token);
 const enrollment=await auth.setupMfa(user.data.id,password,'two');
 const now=Math.floor(Date.now()/30000);t.mock.method(Date,'now',()=>now*30000+5000);
 // Enroll in previous accepted time window so current code is distinct.
 await auth.enableMfa(user.data.id,enrollment.challengeId,totpCode(enrollment.secret,now-1),'three');
 await assert.rejects(auth.actor('Bearer '+first.token));
 const pending=await auth.login(user.data.email,password,'four');assert.equal(pending.challenge,'totp');assert.equal(pending.token,undefined);
 await auth.issue(user.data.email,'login','five');assert.equal(mail.messages.length,0);
 const restarted=new Auth(new Users(new JsonStore(file)),new JwtTokens(secret),mail,secret);
 const session=await restarted.verifyMfa(pending.challengeId,totpCode(enrollment.secret,now),'six');assert.ok(session.token);
 await assert.rejects(restarted.verifyMfa(pending.challengeId,totpCode(enrollment.secret,now),'seven'));
 const another=await auth.login(user.data.email,password,'eight');await assert.rejects(auth.verifyMfa(another.challengeId,totpCode(enrollment.secret,now),'nine'),/previously used/);
 await auth.issue(user.data.email,'reset','ten');const code=mail.messages[0].code;
 await auth.consume(user.data.email,code,'reset','eleven',password+'new');
 await assert.rejects(auth.actor('Bearer '+session.token));
 assert.equal((await auth.login(user.data.email,password+'new','twelve')).challenge,'totp');
 await assert.rejects(auth.consume(user.data.email,code,'reset','thirteen',password));
 const serialized=JSON.stringify((await store.list('MFA')).items)+JSON.stringify((await store.list('AUTH_FLOW')).items);
 assert.ok(!serialized.includes(enrollment.secret));assert.ok(!serialized.includes(password));
 await auth.resetMfa(user.data.id);assert.ok((await auth.login(user.data.email,password+'new','fourteen')).token);
});
test('enrollment requires current password, bounds guesses and refuses a different account',async t=>{
 const {auth,users,user}=await setup(t),other=await users.create({name:'Other',email:'other@example.test',password});
 await assert.rejects(auth.setupMfa(user.data.id,'Wrong-password-2026','a'),/Incorrect password/);
 const flow=await auth.setupMfa(user.data.id,password,'b');
 await assert.rejects(auth.enableMfa(other.data.id,flow.challengeId,'123456','c'),/another account/);
 for(let i=0;i<5;i++)await assert.rejects(auth.enableMfa(user.data.id,flow.challengeId,'invalid','different-'+i));
 await assert.rejects(auth.enableMfa(user.data.id,flow.challengeId,totpCode(flow.secret),'last'),e=>e.status===429);
});
test('remote credential provisioning failures stay inactive and are retried with the reserved ID',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'rta-provision-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 let fail=true;const ids=[];const provider={id:'test',async provision(id){ids.push(id);if(fail)throw new Error('offline');},async disable(){}};
 const users=new Users(new JsonStore(join(dir,'db.json')),provider),input={name:'Test',email:'test@example.test',password};
 await assert.rejects(users.create(input),/offline/);
 const pending=await users.byEmail(input.email);assert.equal(pending.data.active,false);assert.equal(pending.data.passwordHash,undefined);
 fail=false;const ready=await users.create(input);assert.equal(ready.data.active,true);assert.equal(ids[0],ids[1]);assert.equal(ready.data.passwordHash,undefined);
 await assert.rejects(users.create(input));
});

test('TOTP matches RFC 6238 SHA-1 vectors (six-digit truncation)',()=>{
 const key='GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
 assert.equal(totpCode(key,Math.floor(59/30)),'287082');
 assert.equal(totpCode(key,Math.floor(1111111109/30)),'081804');
});
