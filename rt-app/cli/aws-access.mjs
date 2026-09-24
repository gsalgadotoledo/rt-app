import { packageFile } from '@gsalgadotoledo/rt-app-config/paths';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {STSClient,GetCallerIdentityCommand} from '@aws-sdk/client-sts';
const args=process.argv.slice(2),get=name=>{const i=args.indexOf('--'+name);return i<0?undefined:args[i+1];};
const app=get('app'),repository=get('repository'),principal=get('principal'),region=get('region')??process.env.AWS_REGION??'us-east-1';
if(!/^rt-app-[a-z0-9-]{3,30}$/.test(app??'')||! /^[\w.-]+\/[\w.-]+$/.test(repository??'')||! /^arn:aws:iam::\d{12}:(role|user)\/.+$/.test(principal??''))throw new Error('Usage: node rt-app/cli/aws-access.mjs --app rt-app-NAME --repository OWNER/REPO --principal IAM_ROLE_OR_USER_ARN [--region REGION] [--gitlab NAMESPACE/PROJECT] [--multi-environment] [--apply] [--configure-github]');
const file=resolve('.rt-app/aws-access.tfvars.json');await mkdir(resolve('.rt-app'),{recursive:true,mode:0o700});
let previous={};try{previous=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
if(Object.keys(previous).length&&(previous.app!==app||previous.region!==region||previous.repository!==repository))throw new Error('Existing AWS access configuration belongs to another application. Use its original app, region and repository.');
const config={...previous,app,region,repository,operator_principal_arn:principal,gitlab_project:get('gitlab')??previous.gitlab_project??'',multi_environment:(args.includes('--multi-environment')||previous.multi_environment===true),...(get('github-oidc-arn')?{oidc_provider_arn:get('github-oidc-arn')}:{}) ,...(get('gitlab-oidc-arn')?{gitlab_oidc_provider_arn:get('gitlab-oidc-arn')}:{})};
// Preserve the already-provisioned environment topology, even when this helper is new.
try{const state=JSON.parse(await readFile(resolve('.rt-app/bootstrap.tfstate'),'utf8'));for(const resource of state.resources??[]){if(resource.type==='aws_iam_role'&&resource.name==='deploy'){for(const instance of resource.instances??[]){if(['develop','stage'].includes(instance.index_key))config.multi_environment=true;const name=instance.attributes?.name;if(name&&!name.startsWith(app+'-'))throw new Error('Existing bootstrap state belongs to another app');}}}}catch(e){if(e.code!=='ENOENT')throw e;}
await writeFile(file,JSON.stringify(config,null,2)+'\n',{mode:0o600});console.log('Configuration written: '+file);
if(args.includes('--apply')){
 const sts=new STSClient({region,maxAttempts:1});try{const identity=await sts.send(new GetCallerIdentityCommand({}));if(identity.Arn?.endsWith(':root'))throw new Error('Root credentials are not accepted. Use an administrative SSO session or IAM role.');if(identity.Account!==principal.split(':')[4])throw new Error('Principal must belong to the current account');}finally{sts.destroy();}
 const env={...process.env,TF_DATA_DIR:resolve('.rt-app/terraform-bootstrap')},plan=resolve('.rt-app/aws-access.plan'),state=resolve('.rt-app/bootstrap.tfstate');
 function run(command,argv,capture=false){const r=spawnSync(command,argv,{env,encoding:'utf8',stdio:capture?'pipe':'inherit'});if(r.error||r.status!==0)throw new Error(`${command} failed`);return r.stdout;}
 run('terraform',['-chdir='+packageFile('@gsalgadotoledo/rt-app-infra','terraform/aws/bootstrap'),'init','-input=false']);run('terraform',['-chdir='+packageFile('@gsalgadotoledo/rt-app-infra','terraform/aws/bootstrap'),'plan','-input=false','-state='+state,'-var-file='+file,'-out='+plan]);run('terraform',['-chdir='+packageFile('@gsalgadotoledo/rt-app-infra','terraform/aws/bootstrap'),'apply','-input=false',plan]);
 const output=JSON.parse(run('terraform',['-chdir='+packageFile('@gsalgadotoledo/rt-app-infra','terraform/aws/bootstrap'),'output','-state='+state,'-json'],true));await writeFile(resolve('.rt-app/aws-access.outputs.json'),JSON.stringify(output,null,2)+'\n',{mode:0o600});
 if(args.includes('--configure-github')){const b=output.bootstrap.value;for(const [name,value] of Object.entries({AWS_REGION:region,RT_APP_NAME:app,TF_STATE_BUCKET:b.StateBucket,AWS_ROLE_PROD:b.ProdRole,...(config.multi_environment?{AWS_ROLE_DEVELOP:b.DevelopRole,AWS_ROLE_STAGE:b.StageRole}:{}),RT_APP_MULTI_ENVIRONMENT:String(config.multi_environment)}))run('gh',['variable','set',name,'--repo',repository,'--body',String(value)]);}
 console.log('Roles and policies created. Outputs: .rt-app/aws-access.outputs.json. No long-term AWS access keys were created.');
}else console.log('No AWS changes made. Add --apply using an administrative non-root session to create the roles and branch-scoped OIDC policies.');
