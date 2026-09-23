import test from 'node:test';
import assert from 'node:assert/strict';
import {CognitoIdentity} from '../dist/index.js';
function setup(handler){const calls=[];return {calls,provider:new CognitoIdentity('us-east-1_pool','client','us-east-1',{async send(c){calls.push({name:c.constructor.name,input:c.input});return handler(c.constructor.name,c.input);}})};}
test('password and TOTP challenges validate identity with Cognito before accepting tokens',async()=>{
 let mfa=false,username='id';
 const {provider,calls}=setup((name,input)=>{
   if(name==='InitiateAuthCommand')return mfa?{ChallengeName:'SOFTWARE_TOKEN_MFA',Session:'opaque-session'}:{AuthenticationResult:{AccessToken:'token'}};
   if(name==='RespondToAuthChallengeCommand'){assert.equal(input.ChallengeName,'SOFTWARE_TOKEN_MFA');assert.equal(input.ChallengeResponses.SOFTWARE_TOKEN_MFA_CODE,'123456');return {AuthenticationResult:{AccessToken:'token'}};}
   if(name==='GetUserCommand')return {Username:username};throw new Error(name);
 });
 assert.deepEqual(await provider.password('id','password'),{accessToken:'token'});
 mfa=true;assert.deepEqual(await provider.password('id','password'),{challenge:'totp',session:'opaque-session'});
 assert.deepEqual(await provider.verifyTotp('id','opaque-session','123456'),{accessToken:'token'});
 username='other';await assert.rejects(provider.verifyTotp('id','opaque-session','123456'),e=>e.status===401);
 assert.ok(calls.some(c=>c.name==='GetUserCommand'));
});
test('email OTP uses Cognito USER_AUTH and reset/verification never falls back to local passwords',async()=>{
 const {provider,calls}=setup((name,input)=>{
  if(name==='InitiateAuthCommand'){assert.equal(input.AuthFlow,'USER_AUTH');assert.equal(input.AuthParameters.PREFERRED_CHALLENGE,'EMAIL_OTP');return {ChallengeName:'EMAIL_OTP',Session:'email-session'};}
  if(name==='RespondToAuthChallengeCommand'){assert.equal(input.Session,'email-session');assert.equal(input.ChallengeResponses.EMAIL_OTP_CODE,'123456');return {AuthenticationResult:{AccessToken:'token'}};}
  if(name==='GetUserCommand')return {Username:'id'};
  return {};
 });
 assert.equal(await provider.emailCode('id'),'email-session');await provider.verifyEmailCode('id','email-session','123456');
 await provider.forgot('id');await provider.reset('id','123456','new-password');
 assert.equal(calls.at(-1).name,'ConfirmForgotPasswordCommand');
 assert.deepEqual(calls.at(-1).input,{ClientId:'client',Username:'id',ConfirmationCode:'123456',Password:'new-password'});
});
test('TOTP provisioning, logout, disabling and verified email updates use pool-bound commands',async()=>{
 const {provider,calls}=setup(name=>{
  if(name==='AdminGetUserCommand')return {UserMFASettingList:['SOFTWARE_TOKEN_MFA']};
  if(name==='AssociateSoftwareTokenCommand')return {SecretCode:'SEED'};
  if(name==='GetUserCommand')return {Username:'id'};
  if(name==='VerifySoftwareTokenCommand')return {Status:'SUCCESS'};
  return {};
 });
 await provider.provision('id','test@example.test','password');assert.equal(calls[0].input.MessageAction,'SUPPRESS');assert.equal(calls[1].input.Permanent,true);
 assert.equal(await provider.mfaStatus('id'),true);assert.equal(await provider.beginTotp('token'),'SEED');
 await provider.enableTotp('id','token','123456');assert.equal(calls.at(-1).input.SoftwareTokenMfaSettings.Enabled,true);
 await provider.disableMfa('id');await provider.logout('id');await provider.disable('id');await provider.changeEmail('id','new@example.test');
 for(const call of calls.filter(c=>c.name.startsWith('Admin')))assert.equal(call.input.UserPoolId,'us-east-1_pool');
});
test('provider failures do not leak AWS details; retry cannot take over another identity',async()=>{
 const {provider}=setup(name=>{if(name==='AdminCreateUserCommand')throw {name:'UsernameExistsException'};if(name==='AdminGetUserCommand')return {UserAttributes:[{Name:'email',Value:'other@example.test'}]};throw {name:'NotAuthorizedException',message:'sensitive upstream detail'};});
 await assert.rejects(provider.provision('id','test@example.test','password'),/mismatch/);
 await assert.rejects(provider.password('id','password'),e=>e.status===401&&!e.message.includes('sensitive'));
});
test('shared Auth contract brokers Cognito email/MFA challenges without returning provider tokens',async t=>{
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const {JsonStore}=await import('@gsalgadotoledo/rt-app-json'),{Users}=await import('@gsalgadotoledo/rt-app-users'),{Auth,LocalMailbox}=await import('@gsalgadotoledo/rt-app-auth'),{JwtTokens}=await import('@gsalgadotoledo/rt-app-jwt');
 const dir=await mkdtemp(join(tmpdir(),'rta-cognito-contract-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 let id,mfa=false;
 const {provider}=setup((name,input)=>{
  if(name==='AdminCreateUserCommand'){id=input.Username;return {};}
  if(name==='AdminGetUserCommand')return {UserMFASettingList:mfa?['SOFTWARE_TOKEN_MFA']:[]};
  if(name==='InitiateAuthCommand')return input.AuthFlow==='USER_AUTH'?{ChallengeName:'EMAIL_OTP',Session:'email-session'}:mfa?{ChallengeName:'SOFTWARE_TOKEN_MFA',Session:'mfa-session'}:{AuthenticationResult:{AccessToken:'provider-token'}};
  if(name==='RespondToAuthChallengeCommand'){assert.ok(input.Session);return {AuthenticationResult:{AccessToken:'provider-token'}};}
  if(name==='GetUserCommand')return {Username:id};
  return {};
 });
 const store=new JsonStore(join(dir,'db.json')),users=new Users(store,provider),secret='contract-secret-'.repeat(4),auth=new Auth(users,new JwtTokens(secret),new LocalMailbox(),secret,provider);
 const row=await users.create({name:'Test',email:'test@example.test',password:'Test-password-2026!'});
 assert.equal(row.data.passwordHash,undefined);
 const email=await auth.issue(row.data.email,'login','a');
 assert.ok(email.challengeId);assert.ok(!JSON.stringify(email).includes('email-session'));
 const login=await auth.consume(row.data.email,'123456','login','b',undefined,email.challengeId);
 assert.ok(login.token);assert.notEqual(login.token,'provider-token');assert.equal((await auth.actor('Bearer '+login.token)).id,id);
 await assert.rejects(auth.consume(row.data.email,'123456','login','c',undefined,email.challengeId));
 const unknown=await auth.issue('unknown@example.test','login','d');assert.deepEqual(Object.keys(unknown).sort(),Object.keys(email).sort());
 mfa=true;const challenge=await auth.login(row.data.email,'Test-password-2026!','e');assert.equal(challenge.challenge,'totp');assert.equal(challenge.token,undefined);
 assert.ok((await auth.verifyMfa(challenge.challengeId,'123456','f')).token);
 await assert.rejects(auth.verifyMfa(challenge.challengeId,'123456','g'));
});
