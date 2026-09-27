import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {JsonStore} from '@gsalgadotoledo/rt-app-json';
import {Users} from '@gsalgadotoledo/rt-app-users';
import {JwtTokens} from '@gsalgadotoledo/rt-app-jwt';
import {Auth,LocalMailbox,RefreshSessions,clientText,parseRefreshToken,sessionPartition,SESSION_TTL_MS,rateLimit} from '../dist/index.js';

const password='Test-password-only-2026!';
const secret='test-encryption-key-'.repeat(4);

// A clock the test moves explicitly; every component shares it.
async function setup(t,{provider,options={}}={}){
  const dir=await mkdtemp(join(tmpdir(),'rta-sessions-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  let now=Date.parse('2026-01-02T03:04:05.000Z');
  const clock={now:()=>now,set:v=>{now=v;},advance:ms=>{now+=ms;}};
  const store=new JsonStore(join(dir,'db.json')),users=new Users(store,undefined,{now:clock.now});
  const auth=new Auth(users,new JwtTokens(secret,undefined,undefined,{now:clock.now}),new LocalMailbox(),secret,provider,{now:clock.now,...options});
  const user=await users.create({name:'Test',email:'test@example.test',password});
  if(provider)await store.transact([{row:{...user,version:user.version+1,data:{...user.data,credentialProvider:provider.id}},expected:user.version}]);
  return {store,users,auth,user,clock};
}
const bearer=token=>'Bearer '+token;

test('client details keep printable ASCII only and tokens have one strict format',()=>{
  assert.equal(clientText('Mozilla/5.0 ü\u0007',200),'Mozilla/5.0 ');
  assert.equal(clientText('ééé',10),null);
  assert.equal(clientText(5,10),null);
  assert.equal(clientText('a'.repeat(300),200).length,200);
  assert.deepEqual(parseRefreshToken('A'.repeat(22)+'.'+'b'.repeat(43)),{sessionId:'A'.repeat(22),secret:'b'.repeat(43)});
  for(const bad of [undefined,null,42,'','x.y','A'.repeat(22)+'.'+'b'.repeat(42),'A'.repeat(22)+'.'+'b'.repeat(43)+'=','A'.repeat(23)+'.'+'b'.repeat(43)])
    assert.equal(parseRefreshToken(bad),undefined);
  assert.equal(SESSION_TTL_MS,345600000);
});

test('sign-in, rotation and the refresh response never expose stored hashes',async t=>{
  const {store,auth,user,clock}=await setup(t);
  const first=await auth.login(user.data.email,password,'1.1.1.1','Agent');
  assert.equal(first.expiresIn,900);
  assert.equal(first.refreshExpiresAt,new Date(clock.now()+SESSION_TTL_MS).toISOString());
  assert.ok(first.refreshToken.startsWith(first.sessionId+'.'));
  const row=await store.get(sessionPartition(user.data.id),first.sessionId);
  assert.ok(!JSON.stringify(row).includes(first.refreshToken.split('.')[1]));
  assert.equal((await auth.actor(bearer(first.token))).sessionId,first.sessionId);
  clock.advance(60000);
  const second=await auth.refresh(first.refreshToken,'1.1.1.1');
  assert.equal(second.sessionId,first.sessionId);
  assert.equal(second.refreshExpiresAt,first.refreshExpiresAt);
  assert.notEqual(second.refreshToken,first.refreshToken);
  const listed=await auth.sessions(user.data.id,second.sessionId);
  assert.doesNotMatch(JSON.stringify(listed),/Hash|secret/);
  assert.deepEqual(listed.items.map(i=>[i.current,i.userAgent,i.ip]),[[true,'Agent','1.1.1.1']]);
});

test('concurrent refreshes with the same token both succeed through the grace window',async t=>{
  const {auth,user}=await setup(t);
  const session=await auth.login(user.data.email,password,'1.1.1.1');
  const results=await Promise.allSettled([auth.refresh(session.refreshToken,'a'),auth.refresh(session.refreshToken,'b'),auth.refresh(session.refreshToken,'c')]);
  assert.deepEqual(results.map(r=>r.status),['fulfilled','fulfilled','fulfilled']);
  const tokens=new Set(results.map(r=>r.value.refreshToken));
  assert.equal(tokens.size,3);
  // Exactly one of them (the last writer's) is current; it keeps working.
  const row=await auth.refreshSessions.get(user.data.id,session.sessionId);
  const current=results.map(r=>r.value).filter(v=>auth.refreshSessions.hash(v.sessionId,v.refreshToken.split('.')[1])===row.data.secretHash);
  assert.equal(current.length,1);
  assert.ok(await auth.actor(bearer(current[0].token)));
  assert.ok(await auth.refresh(current[0].refreshToken,'d'));
});

test('persistent write conflicts end in 409 instead of looping',async t=>{
  const {store,auth,user}=await setup(t);
  const session=await auth.login(user.data.email,password,'1.1.1.1');
  const transact=store.transact.bind(store);
  const {Conflict}=await import('@gsalgadotoledo/rt-app-contracts');
  store.transact=async writes=>{if(writes.some(w=>w.row.pk.startsWith('SESSIONS#')))throw new Conflict();return transact(writes);};
  await assert.rejects(auth.refresh(session.refreshToken,'1.1.1.1'),e=>e.status===409);
  await assert.rejects(auth.revokeSession(user.data.id,session.sessionId),e=>e.status===409);
  store.transact=async()=>{throw new Error('database down');};
  await assert.rejects(auth.refreshSessions.revoke(user.data.id,session.sessionId,'x'),/database down/);
});

test('theft detection revokes even when a sibling rotation races the revocation',async t=>{
  const {store,auth,user,clock}=await setup(t);
  const session=await auth.login(user.data.email,password,'1.1.1.1');
  const next=await auth.refresh(session.refreshToken,'1.1.1.1');
  clock.advance(31000);
  const transact=store.transact.bind(store);let raced=false;
  const {Conflict}=await import('@gsalgadotoledo/rt-app-contracts');
  store.transact=async writes=>{if(!raced&&writes[0].row.data?.revokedReason==='reuse'){raced=true;throw new Conflict();}return transact(writes);};
  await assert.rejects(auth.refresh(session.refreshToken,'1.1.1.1'),e=>e.status===401);
  assert.equal((await store.get(sessionPartition(user.data.id),session.sessionId)).data.revokedReason,'reuse');
  await assert.rejects(auth.refresh(next.refreshToken,'1.1.1.1'),e=>e.status===401);
});

test('endpoints: refresh is guest, sessions and logout use the calling session',async t=>{
  const {auth,user}=await setup(t);
  const endpoints=Object.fromEntries(auth.feature().endpoints.map(e=>[e.method+' '+e.path,e]));
  assert.equal(endpoints['POST /auth/refresh'].access,'guest');
  assert.equal(endpoints['GET /auth/sessions'].access,'authenticated');
  assert.equal(endpoints['DELETE /auth/sessions/:id'].access,'authenticated');
  assert.equal((await endpoints['GET /auth/methods'].handle({request:{},params:{}})).refreshTokens,true);
  const login=endpoints['POST /auth/login'];
  const a=await login.handle({request:{body:{email:user.data.email,password},ip:'1.1.1.1',headers:{'user-agent':'Browser A'}},params:{}});
  const b=await login.handle({request:{body:{email:user.data.email,password},ip:'2.2.2.2',headers:{}},params:{}});
  const actorA=await auth.actor(bearer(a.token));
  const refreshed=await endpoints['POST /auth/refresh'].handle({request:{body:{refreshToken:a.refreshToken},ip:'1.1.1.1',headers:{}},params:{}});
  assert.equal(refreshed.sessionId,a.sessionId);
  const list=await endpoints['GET /auth/sessions'].handle({request:{},params:{},actor:actorA});
  assert.deepEqual(list.items.map(i=>[i.id,i.current,i.userAgent]).sort(),[[a.sessionId,true,'Browser A'],[b.sessionId,false,null]].sort());
  assert.deepEqual(await endpoints['DELETE /auth/sessions/:id'].handle({request:{},params:{id:b.sessionId},actor:actorA}),{ok:true});
  await assert.rejects(auth.actor(bearer(b.token)),e=>e.status===401);
  assert.deepEqual(await endpoints['POST /auth/logout'].handle({request:{body:{}},params:{},actor:actorA}),{ok:true});
  await assert.rejects(auth.actor(bearer(a.token)),e=>e.status===401);
  assert.equal((await auth.users.get(user.data.id)).data.tokenVersion,1);
  await assert.rejects(auth.logout('missing',undefined,true),e=>e.status===401);
});

test('an identity provider logs out only when signing out everywhere',async t=>{
  const calls=[];
  const provider={id:'test',async password(){return {accessToken:'x'};},async logout(id){calls.push(id);},async mfaStatus(){return false;}};
  const {auth,user}=await setup(t,{provider});
  const session=await auth.login(user.data.email,password,'1.1.1.1');
  const refreshed=await auth.refresh(session.refreshToken,'1.1.1.1');
  assert.equal(refreshed.sessionId,session.sessionId);
  await auth.logout(user.data.id,session.sessionId);
  assert.deepEqual(calls,[]);
  await auth.logout(user.data.id,undefined,true);
  assert.deepEqual(calls,[user.data.id]);
});

test('a configurable lifetime and grace window, and the shared rate limiter',async t=>{
  const {auth,user,clock,store}=await setup(t,{options:{sessionTtlMs:60000,refreshGraceMs:0}});
  const session=await auth.login(user.data.email,password,'1.1.1.1');
  assert.equal(Date.parse(session.refreshExpiresAt)-clock.now(),60000);
  const next=await auth.refresh(session.refreshToken,'1.1.1.1');
  clock.advance(1);
  await assert.rejects(auth.refresh(session.refreshToken,'1.1.1.1'),e=>e.status===401);
  await assert.rejects(auth.refresh(next.refreshToken,'1.1.1.1'),e=>e.status===401);
  await rateLimit(store,secret,clock.now(),'k',1);
  await assert.rejects(rateLimit(store,secret,clock.now(),'k',1),e=>e.status===429);
  const sessions=new RefreshSessions(store,secret);
  assert.equal(sessions.ttlMs,SESSION_TTL_MS);
  assert.equal(await sessions.find('nope'),undefined);
  assert.equal(await sessions.revoke(user.data.id,'',"x"),false);
});
