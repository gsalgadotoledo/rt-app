import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {readWizard,parseEnv,setEnvLine,awsProfiles,WizardRunner,WIZARD_FILE} from '../wizard.mjs';

const MANIFEST={
 title:'Desplegar',
 steps:[
  {id:'domain',title:'Tu dominio',platform:{name:'Tu registrador',url:'https://example.com/dns'},how:['Entra a tu registrador.'],
   fields:[{key:'DOMAIN',label:'Dominio',pattern:'^[a-z0-9.-]+\\.[a-z]{2,}$',placeholder:'midominio.com'}]},
  {id:'aws',title:'AWS',fields:[{key:'AWS_ADMIN_PROFILE',label:'Perfil',options:'aws-profiles'}]},
  {id:'models',title:'Modelos',oneOf:['ANTHROPIC_API_KEY','OPENAI_API_KEY'],
   fields:[{key:'ANTHROPIC_API_KEY',label:'Anthropic',secret:true},{key:'OPENAI_API_KEY',label:'OpenAI',secret:true},{key:'BRAVE_SEARCH_API_KEY',label:'Brave',secret:true,optional:true}]},
  {id:'up',title:'Levantar',actions:[{id:'dev',label:'Levantar dev',command:['node','say.mjs','${DOMAIN}']}]},
 ],
};

async function project(t,manifest=MANIFEST,files={}){
 const root=await mkdtemp(join(tmpdir(),'sm-wizard-'));t.after(()=>rm(root,{recursive:true,force:true}));
 if(manifest)await writeFile(join(root,WIZARD_FILE),JSON.stringify(manifest));
 for(const [path,content] of Object.entries(files)){await mkdir(join(root,path,'..'),{recursive:true});await writeFile(join(root,path),content);}
 return root;
}

function fakeSpawn(calls,{code=0,output='done\n'}={}){
 return (bin,args,options)=>{
  calls.push({bin,args,cwd:options.cwd});
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
  setImmediate(()=>{child.stdout.write(output);child.stdout.end();child.stderr.end();setImmediate(()=>child.emit('close',code));});
  return child;
 };
}
const settle=async(r,id)=>{for(let i=0;i<200;i++){const run=r.getRun(id);if(run.state!=='running')return run;await new Promise(x=>setTimeout(x,5));}throw new Error('did not finish');};

test('no manifest: no wizard; a bad one says why',async t=>{
 assert.equal(await readWizard(await project(t,null)),null);
 assert.equal((await new WizardRunner().state(await project(t,null))).wizard,null);
 await assert.rejects(readWizard(await project(t,{steps:[]})),/no steps/);
 await assert.rejects(readWizard(await project(t,{files:{secrets:'../x.env'},steps:MANIFEST.steps})),/inside the project/);
 await assert.rejects(readWizard(await project(t,{steps:[{id:'a',title:'A',platform:{name:'x',url:'http://x.test'}}]})),/https/);
 await assert.rejects(readWizard(await project(t,{steps:[{id:'a',title:'A',fields:[{key:'X'},{key:'X'}]}]})),/asked twice/);
 await assert.rejects(readWizard(await project(t,{steps:[{id:'a',title:'A',oneOf:['Y'],fields:[{key:'X'}]}]})),/oneOf names Y/);
});

test('env lines: read like the project scripts, one key changed, the rest kept',()=>{
 assert.deepEqual(parseEnv('# c\nA=1\nexport B="two words"\nC=3 # note\n\nbad line\n'),{A:'1',B:'two words',C:'3'});
 const before='# keep me\nA=1\nB=2\n';
 assert.equal(setEnvLine(before,'A','9'),'# keep me\nA=9\nB=2\n');
 assert.equal(setEnvLine(before,'C','x y'),'# keep me\nA=1\nB=2\nC="x y"\n');
 assert.equal(setEnvLine(before,'B',''),'# keep me\nA=1\n');
 assert.equal(setEnvLine('','A','1'),'A=1\n');
 assert.throws(()=>setEnvLine('','A','a\nb'),/one line/);
});

test('state and save: config values shown, secrets only as present, files 0600, steps done',async t=>{
 const home=await project(t,null,{'.aws/config':'[default]\nregion=us-east-1\n[profile remote-os-admin]\n','.aws/credentials':'[default]\n[other]\n'});
 const root=await project(t,MANIFEST,{'.deploy/config.env':'# mine\nAWS_REGION=us-east-1\n'});
 const r=new WizardRunner({home});
 let s=(await r.state(root)).wizard;
 assert.deepEqual(s.steps.map(x=>x.done),[false,false,false,null]);
 assert.deepEqual(s.steps[1].fields[0].choices,['default','other','remote-os-admin']);
 await assert.rejects(r.save(root,{DOMAIN:'not a domain'}),/does not look right/);
 await assert.rejects(r.save(root,{NOPE:'x'}),/not asked/);
 s=(await r.save(root,{DOMAIN:'midominio.com',AWS_ADMIN_PROFILE:'remote-os-admin',OPENAI_API_KEY:'sk-secret-123456'})).wizard;
 assert.deepEqual(s.steps.map(x=>x.done),[true,true,true,null],'one of the model keys is enough; the optional one is not needed');
 assert.equal(s.steps[0].fields[0].value,'midominio.com');
 const openai=s.steps[2].fields.find(f=>f.key==='OPENAI_API_KEY');
 assert.equal(openai.present,true);assert.equal('value' in openai,false);
 assert.equal(JSON.stringify(s).includes('sk-secret-123456'),false,'a secret never comes back');
 assert.equal(await readFile(join(root,'.deploy/config.env'),'utf8'),'# mine\nAWS_REGION=us-east-1\nDOMAIN=midominio.com\nAWS_ADMIN_PROFILE=remote-os-admin\n');
 assert.equal(await readFile(join(root,'.deploy/secrets.env'),'utf8'),'OPENAI_API_KEY=sk-secret-123456\n');
 for(const f of ['config.env','secrets.env'])assert.equal((await stat(join(root,'.deploy',f))).mode&0o777,0o600);
 s=(await r.save(root,{OPENAI_API_KEY:''})).wizard;
 assert.equal(s.steps[2].done,false,'removed');
});

test('actions: only the manifest\'s, config values filled in, secrets redacted, one at a time',async t=>{
 const root=await project(t,MANIFEST,{'.deploy/config.env':'DOMAIN=midominio.com\n','.deploy/secrets.env':'OPENAI_API_KEY=sk-secret-123456\n'});
 const calls=[];
 const r=new WizardRunner({spawn:fakeSpawn(calls,{output:'using sk-secret-123456 for midominio.com\n'})});
 await assert.rejects(r.run(root,'up','nope'),/Unknown action/);
 const {id}=await r.run(root,'up','dev');
 const run=await settle(r,id);
 // A command still running: the next one waits for it.
 const hang=new WizardRunner({spawn:()=>{const c=new EventEmitter();c.stdout=new PassThrough();c.stderr=new PassThrough();return c;}});
 await hang.run(root,'up','dev');
 await assert.rejects(hang.run(root,'up','dev'),/Another command/);
 assert.deepEqual(calls[0],{bin:'node',args:['say.mjs','midominio.com'],cwd:root});
 assert.equal(run.state,'succeeded');
 assert.equal(run.output,'using [redacted] for midominio.com\n');
 assert.equal('root' in run,false);
 const failed=new WizardRunner({spawn:fakeSpawn([],{code:2})});
 assert.equal((await settle(failed,(await failed.run(root,'up','dev')).id)).state,'failed');
 assert.throws(()=>r.getRun('missing'),/Unknown run/);
});

test('aws profiles: none on a machine without the AWS CLI',async t=>{
 assert.deepEqual(await awsProfiles(await project(t,null)),[]);
});

test('route53 zones: the profile\'s public zones as choices, asked once a minute, none on failure',async t=>{
 const manifest={steps:[
  {id:'aws',title:'AWS',fields:[{key:'AWS_ADMIN_PROFILE',label:'Perfil'}]},
  {id:'domain',title:'Dominio',fields:[{key:'DOMAIN',label:'Dominio',options:'route53-zones',profileFrom:'AWS_ADMIN_PROFILE'}]},
 ]};
 await assert.rejects(readWizard(await project(t,{steps:[{id:'d',title:'D',fields:[{key:'DOMAIN',options:'route53-zones'}]}]})),/profileFrom/);
 await assert.rejects(readWizard(await project(t,{steps:[{id:'d',title:'D',fields:[{key:'DOMAIN',options:'nope'}]}]})),/options is/);
 const root=await project(t,manifest,{'.deploy/config.env':'AWS_ADMIN_PROFILE=admin\n'});
 const calls=[];
 const spawn=(cmd,args)=>{
  calls.push([cmd,...args]);
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
  setImmediate(()=>{child.stdout.end(JSON.stringify({HostedZones:[{Name:'rtapp.io.',Config:{PrivateZone:false}},{Name:'internal.test.',Config:{PrivateZone:true}},{Name:'otro.com.',Config:{PrivateZone:false}}]}));child.emit('close',0);});
  return child;
 };
 const r=new WizardRunner({spawn});
 const domain=async()=>(await r.state(root)).wizard.steps[1].fields[0];
 assert.deepEqual((await domain()).choices,['otro.com','rtapp.io'],'public zones only');
 await domain();
 assert.equal(calls.length,1,'kept a minute');
 assert.deepEqual(calls[0],['aws','route53','list-hosted-zones','--output','json','--profile','admin']);
 const failing=new WizardRunner({spawn:()=>{const c=new EventEmitter();c.stdout=new PassThrough();setImmediate(()=>c.emit('close',255));return c;}});
 assert.deepEqual((await failing.state(root)).wizard.steps[1].fields[0].choices,[]);
 const noProfile=await project(t,manifest);
 assert.deepEqual((await r.state(noProfile)).wizard.steps[1].fields[0].choices,[],'no profile yet: no zones asked');
});
