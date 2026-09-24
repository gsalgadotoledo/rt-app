import { packageFile } from '@gsalgadotoledo/rt-app-config/paths';
import {mkdir,open,readFile,lstat,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {IAMClient,CreateUserCommand,PutUserPolicyCommand,CreateAccessKeyCommand,DeleteAccessKeyCommand,DeleteUserPolicyCommand,DeleteUserCommand} from '@aws-sdk/client-iam';
import {STSClient,GetCallerIdentityCommand} from '@aws-sdk/client-sts';

const policyPath=packageFile('@gsalgadotoledo/rt-app-infra','terraform/aws/data/installer-policy.json');
export const bootstrapKeys=['RT_APP_BOOTSTRAP_ACCESS_KEY_ID','RT_APP_BOOTSTRAP_SECRET_ACCESS_KEY','RT_APP_BOOTSTRAP_SESSION_TOKEN'];
export function deploymentEnvironment(env,identity){
 const next={...env};
 for(const key of [...bootstrapKeys,'AWS_PROFILE','AWS_DEFAULT_PROFILE','AWS_SESSION_TOKEN','AWS_WEB_IDENTITY_TOKEN_FILE','AWS_ROLE_ARN','AWS_ROLE_SESSION_NAME'])delete next[key];
 return {...next,AWS_ACCESS_KEY_ID:identity.accessKeyId,AWS_SECRET_ACCESS_KEY:identity.secretAccessKey,AWS_REGION:identity.region,AWS_DEFAULT_REGION:identity.region,RT_APP_NAME:identity.app};
}
export async function savedIdentity(root){
 const path=join(root,'.rt-app/aws-identity.json');
 try{
  const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||(process.platform!=='win32'&&(stat.mode&0o077)))throw new Error('AWS identity file must be a private regular file (chmod 600).');
  const data=JSON.parse(await readFile(path,'utf8'));
  if(data.version!==1||!data.accessKeyId||!data.secretAccessKey||!/^rt-app-[a-z0-9-]{3,30}$/.test(data.app)||!data.region)throw new Error('Invalid saved AWS identity; do not overwrite it automatically.');
  return data;
 }catch(error){if(error.code==='ENOENT')return null;throw error;}
}
export async function bootstrapAws({root,env=process.env,iamFactory=options=>new IAMClient(options),stsFactory=options=>new STSClient(options)}={}){
 const dir=join(root,'.rt-app');await mkdir(dir,{recursive:true,mode:0o700});if((await lstat(dir)).isSymbolicLink())throw new Error('Local state directory must not be a symlink.');
 const lockPath=join(dir,'aws-bootstrap.lock');let lock;
 try{lock=await open(lockPath,'wx',0o600);}catch(error){if(error.code==='EEXIST')throw new Error('AWS bootstrap is already locked. Check whether another setup is running.');throw error;}
 let iam,sts;
 try{
  const saved=await savedIdentity(root);
  if(saved){if(env.RT_APP_NAME&&env.RT_APP_NAME!==saved.app)throw new Error('Saved AWS identity belongs to a different app.');if(env.AWS_REGION&&env.AWS_REGION!==saved.region)throw new Error('Use the saved AWS region for this project.');return saved;}
  const accessKeyId=env.RT_APP_BOOTSTRAP_ACCESS_KEY_ID,secretAccessKey=env.RT_APP_BOOTSTRAP_SECRET_ACCESS_KEY;
  if(!accessKeyId||!secretAccessKey)throw new Error('Set RT_APP_BOOTSTRAP_ACCESS_KEY_ID and RT_APP_BOOTSTRAP_SECRET_ACCESS_KEY. Temporary credentials also need RT_APP_BOOTSTRAP_SESSION_TOKEN.');
  const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
  const suffix=(pkg.name??'hello').replace(/^rt-app-/,'').replace(/[^a-z0-9-]/g,'-').slice(0,30).padEnd(3,'x');
  const app=env.RT_APP_NAME??'rt-app-'+suffix,region=env.AWS_REGION??'us-east-1';
  if(!/^rt-app-[a-z0-9-]{3,30}$/.test(app)||! /^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region))throw new Error('Invalid RT_APP_NAME or AWS_REGION.');
  const options={region,credentials:{accessKeyId,secretAccessKey,...(env.RT_APP_BOOTSTRAP_SESSION_TOKEN?{sessionToken:env.RT_APP_BOOTSTRAP_SESSION_TOKEN}:{})},maxAttempts:1};
  sts=stsFactory(options);const caller=await sts.send(new GetCallerIdentityCommand({}));
  if(!/^\d{12}$/.test(caller.Account??''))throw new Error('Could not identify AWS account.');
  // This policy currently supports the commercial AWS partition only.
  if(!caller.Arn?.startsWith('arn:aws:'))throw new Error('This installer currently supports the commercial AWS partition.');
  const userName=app+'-installer',policyName='rt-app-install';
  const policyData=JSON.parse((await readFile(policyPath,'utf8')).replaceAll('rt-app-*',app+'-*').replaceAll(':*:*:',`:*:${caller.Account}:`).replaceAll('arn:aws:iam::*:',`arn:aws:iam::${caller.Account}:`));
  // Production has no environment suffix. Include its base and qualified ARNs,
  // as well as the prefixed resources used by develop/stage and child resources.
  for(const statement of policyData.Statement){
   if(['ApplicationFunctions','ApplicationLogs','ApplicationSecrets'].includes(statement.Sid)){
    const scoped=statement.Resource;
    const base=scoped.replace(app+'-*',app);
    statement.Resource=[scoped,base,...(statement.Sid==='ApplicationSecrets'?[]:[base+':*'])];
   }
  }
  const policy=JSON.stringify(policyData);
  iam=iamFactory(options);let created=false,key,identityFile;
  try{
   await iam.send(new CreateUserCommand({UserName:userName,Tags:[{Key:'ManagedBy',Value:'RT-App'},{Key:'Application',Value:app}]}));created=true;
   await iam.send(new PutUserPolicyCommand({UserName:userName,PolicyName:policyName,PolicyDocument:policy}));
   key=(await iam.send(new CreateAccessKeyCommand({UserName:userName}))).AccessKey;
   if(!key?.AccessKeyId||!key?.SecretAccessKey)throw new Error('Missing access key response');
   const identity={version:1,app,region,account:caller.Account,userName,accessKeyId:key.AccessKeyId,secretAccessKey:key.SecretAccessKey};
   identityFile=await open(join(dir,'aws-identity.json'),'wx',0o600);
   await identityFile.writeFile(JSON.stringify(identity)+'\n');await identityFile.sync();await identityFile.close();identityFile=null;
   return identity;
  }catch(error){
   if(identityFile){await identityFile.close().catch(()=>{});await unlink(join(dir,'aws-identity.json')).catch(()=>{});}
   let cleanupFailed=false;
   if(created){
    if(key?.AccessKeyId)await iam.send(new DeleteAccessKeyCommand({UserName:userName,AccessKeyId:key.AccessKeyId})).catch(()=>{cleanupFailed=true;});
    await iam.send(new DeleteUserPolicyCommand({UserName:userName,PolicyName:policyName})).catch(e=>{if(e.name!=='NoSuchEntityException')cleanupFailed=true;});
    await iam.send(new DeleteUserCommand({UserName:userName})).catch(()=>{cleanupFailed=true;});
   }
   throw new Error(`AWS bootstrap failed (${error.name}). ${created?(cleanupFailed?`Cleanup incomplete; inspect IAM user ${userName}.`:'New IAM resources were rolled back.'):'No existing IAM user was modified.'}`);
  }
 }finally{iam?.destroy();sts?.destroy();await lock.close();await unlink(lockPath);}
}
