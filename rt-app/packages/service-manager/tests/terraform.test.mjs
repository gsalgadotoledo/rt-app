import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {findStacks,readVariables,parseErrors,TerraformRunner,GLOBAL_VARIABLES,TERRAFORM_COMMANDS} from '../terraform.mjs';

async function tree(t,files){
 const root=await mkdtemp(join(tmpdir(),'sm-tf-'));t.after(()=>rm(root,{recursive:true,force:true}));
 for(const [path,content] of Object.entries(files)){await mkdir(join(root,path,'..'),{recursive:true});await writeFile(join(root,path),content);}
 return root;
}

const VARIABLES=`
variable "stripe_api_key" {
  description = "Stripe secret key. Find it at https://dashboard.stripe.com/apikeys"
  type        = string
  sensitive   = true
}

variable "region" {
  description = "AWS region {e.g. us-east-1}"
  default     = "us-east-1"
}

variable "plans" {
  type = list(object({ id = string }))
}
`;

// Fake terraform: prints the arguments and an optional output, exits with `code`.
function fakeSpawn(calls,{code=0,output=''}={}){
 return (bin,args,options)=>{
  calls.push({bin,args,cwd:options.cwd,env:options.env});
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
  setImmediate(async()=>{
   child.stdout.write(output||`ran ${args[0]}\n`);child.stdout.end();child.stderr.end();
   if(args[0]==='plan')await writeFile(args.find(a=>a.startsWith('-out=')).slice(5),'plan');
   setImmediate(()=>child.emit('close',code));
  });
  return child;
 };
}

const settle=async(runner,stack,id)=>{for(let i=0;i<200;i++){const r=await runner.getRun(stack,id);if(r.state!=='running')return r;await new Promise(r=>setTimeout(r,5));}throw new Error('run did not finish');};

test('stacks are found in any folder with .tf files, infra first, skipping dependencies',async t=>{
 const root=await tree(t,{'infra/aws/main.tf':'','infra/stripe/main.tf':'','tools/tf/x.tf':'','node_modules/mod/main.tf':'','.terraform/modules/m/main.tf':'','apps/api/index.js':''});
 const stacks=await findStacks({path:root,name:'shop'});
 assert.deepEqual(stacks.map(s=>s.name),['infra/aws','infra/stripe','tools/tf']);
 assert.equal(stacks[0].project,'shop');
 assert.notEqual(stacks[0].id,stacks[1].id);
});

test('variables: description, links, type, required and sensitive',async t=>{
 const dir=await tree(t,{'variables.tf':VARIABLES,'main.tf':'resource "x" "y" {}'});
 const vars=await readVariables(dir);
 assert.deepEqual(vars.map(v=>[v.name,v.required,v.sensitive,v.type]),[['stripe_api_key',true,true,'string'],['region',false,false,'string'],['plans',true,false,'list(object({ id = string }))']]);
 assert.deepEqual(vars[0].links,['https://dashboard.stripe.com/apikeys']);
 assert.equal(vars[1].description,'AWS region {e.g. us-east-1}','braces inside strings do not end the block');
});

test('errors are extracted with file and line',()=>{
 const out='╷\n│ Error: Unsupported argument\n│\n│   on main.tf line 12, in resource "x" "y":\n│   12:   foo = 1\n╵\nError: No valid credential sources found\n';
 assert.deepEqual(parseErrors(out),[{summary:'Unsupported argument',file:'main.tf',line:12},{summary:'No valid credential sources found',file:null,line:null}]);
});

test('values: per stack and global, stored 0600, secrets never returned, passed as env',async t=>{
 const home=await tree(t,{}),dir=await tree(t,{'variables.tf':VARIABLES});
 const runner=new TerraformRunner({home});const stack={id:'s1',path:dir};
 await runner.setVariable(stack,'stripe_api_key','sk_test_1234567890');
 await runner.setVariable(stack,'region','eu-west-1');
 await assert.rejects(runner.setVariable(stack,'nope','x'),/Unknown variable/);
 const vars=await runner.variables(stack);
 assert.deepEqual(vars.map(v=>[v.name,v.present,v.value]),[['stripe_api_key',true,undefined],['region',true,'eu-west-1'],['plans',false,undefined]]);
 await runner.setVariable(stack,'region','');
 assert.equal((await runner.variables(stack))[1].present,false,'empty value clears it');
 await runner.setGlobal('AWS_ACCESS_KEY_ID','AKIA1234567890');
 await runner.setGlobal('MY_TOKEN','custom');
 await assert.rejects(runner.setGlobal('bad key','x'),/Invalid variable name/);
 const globals=await runner.globals();
 assert.equal(globals.find(g=>g.key==='AWS_ACCESS_KEY_ID').present,true);
 assert.ok(globals.find(g=>g.key==='MY_TOKEN'));
 assert.equal(JSON.stringify(globals).includes('AKIA1234567890'),false);
 assert.equal((await stat(join(home,'terraform/global.json'))).mode&0o777,0o600);
 const env=await runner.environment(stack,{PATH:'/bin'});
 assert.deepEqual([env.TF_VAR_stripe_api_key,env.AWS_ACCESS_KEY_ID,env.TF_IN_AUTOMATION,env.PATH],['sk_test_1234567890','AKIA1234567890','1','/bin']);
 await runner.setGlobal('MY_TOKEN','');
 assert.equal((await runner.globals()).some(g=>g.key==='MY_TOKEN'),false);
 assert.ok(GLOBAL_VARIABLES.every(g=>g.url.startsWith('https://')));
});

test('runs: init first, plan then apply exactly that plan, history and redaction',async t=>{
 const home=await tree(t,{}),dir=await tree(t,{'main.tf':VARIABLES});
 const calls=[];const runner=new TerraformRunner({home,spawn:fakeSpawn(calls,{output:'using sk_test_1234567890\n'})});const stack={id:'s2',path:dir};
 await runner.setVariable(stack,'stripe_api_key','sk_test_1234567890');
 await assert.rejects(runner.run(stack,'destroy'),/Unknown Terraform command/);
 await assert.rejects(runner.run(stack,'plan'),/Run Init first/);
 await assert.rejects(runner.run(stack,'apply'),/Run Plan first/);
 let run=await settle(runner,stack,(await runner.run(stack,'init')).id);
 assert.equal(run.state,'succeeded');
 assert.equal(run.output.includes('sk_test_1234567890'),false,'secrets are redacted from output');
 await mkdir(join(dir,'.terraform'));
 const planRun=await runner.run(stack,'plan');
 await assert.rejects(runner.run(stack,'validate'),/already running/);
 await settle(runner,stack,planRun.id);
 const planPath=calls.at(-1).args.find(a=>a.startsWith('-out=')).slice(5);
 assert.ok(planPath.startsWith(join(home,'terraform/plans')),'plans live in the manager home');
 await settle(runner,stack,(await runner.run(stack,'apply')).id);
 assert.equal(calls.at(-1).args.at(-1),planPath,'apply uses the reviewed plan');
 await assert.rejects(runner.run(stack,'apply'),/Run Plan first/,'the plan is consumed');
 assert.equal(calls.at(-1).env.TF_VAR_stripe_api_key,'sk_test_1234567890');
 const history=await runner.history(stack);
 assert.deepEqual(history.map(h=>h.command),['apply','plan','init']);
 assert.equal('output' in history[0],false);
 assert.equal((await runner.getRun(stack,history[0].id)).output.length>0,true);
 assert.deepEqual(TERRAFORM_COMMANDS,['init','validate','fmt','test','plan','apply']);
});

test('runs: failures keep errors, a failed plan cannot be applied, missing terraform is explained',async t=>{
 const home=await tree(t,{}),dir=await tree(t,{'main.tf':'','.terraform/x':''});
 const runner=new TerraformRunner({home,spawn:fakeSpawn([],{code:1,output:'Error: Invalid provider configuration\n'})});const stack={id:'s3',path:dir};
 const failed=await settle(runner,stack,(await runner.run(stack,'plan')).id);
 assert.deepEqual([failed.state,failed.exitCode,failed.errors[0].summary],['failed',1,'Invalid provider configuration']);
 await assert.rejects(runner.run(stack,'apply'),/Run Plan first/);
 const missing=new TerraformRunner({home,spawn:()=>{const c=new EventEmitter();setImmediate(()=>c.emit('error',Object.assign(new Error('spawn'),{code:'ENOENT'})));return c;}});
 const run=await settle(missing,stack,(await missing.run(stack,'fmt')).id);
 assert.match(run.output,/Install it from Add tools & services/);
});
