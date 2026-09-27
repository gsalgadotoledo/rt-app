import test from 'node:test';
import assert from 'node:assert/strict';
import {MemoryStore} from '@gsalgadotoledo/rt-app-dynamodb';
import {Users} from '@gsalgadotoledo/rt-app-users';
import {JwtTokens} from '@gsalgadotoledo/rt-app-jwt';
import {Auth,LocalMailbox,sessionPartition} from '../dist/index.js';
import {totpCode} from '../dist/totp.js';

// The ban gate of every sign-in path. The ban row format belongs to rt-app-users (activeBan); the
// writes that set it (UserBans) are tested in rt-app-users-bans. Here bans are written directly.
const password='Test-password-only-2026!';
const secret='test-encryption-key-'.repeat(4);
const suspended={status:403,message:'Account suspended'};

async function setup({provider}={}){
  let now=Date.parse('2026-01-02T03:04:05.000Z');
  const clock={now:()=>now,advance:ms=>{now+=ms;}};
  const store=new MemoryStore(),users=new Users(store,undefined,{now:clock.now}),mail=new LocalMailbox();
  const auth=new Auth(users,new JwtTokens(secret,undefined,undefined,{now:clock.now}),mail,secret,provider,{now:clock.now});
  let user=await users.create({name:'Test',email:'test@example.test',password});
  if(provider){user={...user,version:user.version+1,data:{...user.data,credentialProvider:provider.id}};await store.transact([{row:user,expected:user.version-1}]);}
  // Write data.ban without touching tokenVersion (what UserBans does besides the bump).
  const ban=async(until=null,bump=false)=>{const row=await users.get(user.data.id);await store.transact([{row:{...row,version:row.version+1,data:{...row.data,ban:{reason:'Spam',category:null,until,at:'2026-01-02T03:04:05.000Z',by:'rt-app-root'},tokenVersion:row.data.tokenVersion+(bump?1:0)}},expected:row.version}]);};
  const unban=async()=>{const row=await users.get(user.data.id);await store.transact([{row:{...row,version:row.version+1,data:{...row.data,ban:null}},expected:row.version}]);};
  return {store,users,auth,mail,user,clock,ban,unban};
}

test('password sign-in is refused only after the password matched',async()=>{
  const {auth,user,ban,clock}=await setup();
  await ban('2026-01-02T04:04:05.000Z');
  await assert.rejects(auth.login(user.data.email,password,'1.1.1.1'),suspended);
  await assert.rejects(auth.login(user.data.email,'Wrong-password-2026!','1.1.1.1'),{status:401,message:'Incorrect email or password'});
  await assert.rejects(auth.login('nobody@example.test',password,'1.1.1.1'),{status:401});
  clock.advance(3600000);
  assert.ok((await auth.login(user.data.email,password,'1.1.1.1')).token,'the temporary ban lifted at until');
});

test('email codes: sent as usual, refused at verify (code unused); password reset still works',async()=>{
  const {auth,mail,user,ban,unban,store}=await setup();
  await ban();
  assert.deepEqual(await auth.issue(user.data.email,'login','1.1.1.1'),{message:'If the account supports this method, you will receive a code.'});
  const code=mail.messages[0].code;
  await assert.rejects(auth.consume(user.data.email,code,'login','1.1.1.1'),suspended);
  await assert.rejects(auth.consume(user.data.email,code==='000000'?'111111':'000000','login','1.1.1.1'),{status:400});
  await unban();
  assert.ok((await auth.consume(user.data.email,code,'login','1.1.1.1')).token,'the code was left unused');
  await ban();
  await auth.issue(user.data.email,'reset','1.1.1.1');
  assert.deepEqual(await auth.consume(user.data.email,mail.messages[0].code,'reset','1.1.1.1',password+'x'),{message:'Password updated. Sign in to continue.'});
  assert.ok((await store.get('USERS',user.data.id)).data.ban,'a reset does not lift the ban');
  await assert.rejects(auth.login(user.data.email,password+'x','1.1.1.1'),suspended);
});

test('TOTP: the challenge of a banned account is refused before the code is checked',async()=>{
  const {auth,user,ban,clock}=await setup();
  const flow=await auth.setupMfa(user.data.id,password,'1.1.1.1');
  const step=Math.floor(clock.now()/30000);
  await auth.enableMfa(user.data.id,flow.challengeId,totpCode(flow.secret,step),'1.1.1.1');
  const pending=await auth.login(user.data.email,password,'1.1.1.1');
  assert.equal(pending.challenge,'totp');
  await ban();
  await assert.rejects(auth.verifyMfa(pending.challengeId,totpCode(flow.secret,step+1),'1.1.1.1'),suspended);
  await assert.rejects(auth.login(user.data.email,password,'1.1.1.1'),suspended,'no new challenge either');
});

test('refresh: 403 for the holder of the secret, 401 for anyone else, nothing written',async()=>{
  const {auth,store,user,ban,unban}=await setup();
  const first=await auth.login(user.data.email,password,'1.1.1.1');
  const second=await auth.refresh(first.refreshToken,'1.1.1.1');
  await ban(null,true);
  const before=await store.get(sessionPartition(user.data.id),first.sessionId);
  await assert.rejects(auth.refresh(second.refreshToken,'1.1.1.1'),suspended);
  await assert.rejects(auth.refresh(first.refreshToken,'1.1.1.1'),suspended,'the previous secret is still a holder');
  await assert.rejects(auth.refresh(first.sessionId+'.'+'x'.repeat(43),'1.1.1.1'),{status:401,message:'Invalid session'});
  await assert.rejects(auth.refresh('A'.repeat(22)+'.'+'x'.repeat(43),'1.1.1.1'),{status:401,message:'Invalid session'});
  assert.deepEqual(await store.get(sessionPartition(user.data.id),first.sessionId),before,'no reuse revocation, no rotation');
  await unban();
  await assert.rejects(auth.refresh(second.refreshToken,'1.1.1.1'),{status:401,message:'Invalid session'},'unban does not revive old sessions');
});

test('actor: a ban written without a tokenVersion bump still refuses the token',async()=>{
  const {auth,user,ban,unban}=await setup();
  const session=await auth.login(user.data.email,password,'1.1.1.1');
  await ban();
  await assert.rejects(auth.actor('Bearer '+session.token),suspended);
  await unban();
  assert.equal((await auth.actor('Bearer '+session.token)).id,user.data.id);
});

test('identity providers: refused after the provider accepted the credentials',async()=>{
  const calls=[];
  const provider={id:'test',
    async password(id){calls.push('password:'+id);return {accessToken:'x'};},
    async emailCode(){return 'provider-session';},
    async verifyEmailCode(id){calls.push('code:'+id);return {accessToken:'x'};},
    async mfaStatus(){return false;},async logout(){},async provision(){},async disable(){}};
  const {auth,user,ban}=await setup({provider});
  await ban();
  await assert.rejects(auth.login(user.data.email,password,'1.1.1.1'),suspended);
  const pending=await auth.issue(user.data.email,'login','1.1.1.1');
  assert.equal(pending.challenge,'email');
  await assert.rejects(auth.consume(user.data.email,'123456','login','1.1.1.1',undefined,pending.challengeId),suspended);
  assert.deepEqual(calls,['password:'+user.data.id,'code:'+user.data.id]);
});
