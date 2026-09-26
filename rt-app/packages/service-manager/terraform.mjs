import {readdir,readFile,writeFile,mkdir,stat,rm} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawn as spawnProcess} from 'node:child_process';

/**
 * Terraform workspaces inside projects: find them, read their variables, keep values (per stack
 * and global environment such as AWS keys) and run init / validate / fmt / test / plan / apply with
 * a persistent run history. Values live in the manager home (0600), never in the project.
 */

const SKIP=new Set(['node_modules','.terraform','.git','.rt-app','dist','build','target','.next','.next-dev','.venv']);
// Saved plans can contain secrets: they live in the manager home (0700), never in the project.
const COMMANDS={
 init:()=>['init','-input=false','-no-color'],
 validate:()=>['validate','-no-color'],
 fmt:()=>['fmt','-check','-recursive','-diff','-no-color'],
 test:()=>['test','-no-color'],
 plan:plan=>['plan','-input=false','-no-color','-out='+plan],
 apply:plan=>['apply','-input=false','-no-color',plan],
};
export const TERRAFORM_COMMANDS=Object.keys(COMMANDS);

/** Well-known global variables with where to find them. Values are entered once, used by every stack. */
export const GLOBAL_VARIABLES=[
 {key:'AWS_ACCESS_KEY_ID',description:'AWS access key of an IAM user or role allowed to deploy.',url:'https://console.aws.amazon.com/iam/home#/security_credentials',secret:true},
 {key:'AWS_SECRET_ACCESS_KEY',description:'Secret of that access key.',url:'https://console.aws.amazon.com/iam/home#/security_credentials',secret:true},
 {key:'AWS_REGION',description:'Default region, e.g. us-east-1.',url:'https://docs.aws.amazon.com/general/latest/gr/rande.html',secret:false},
 {key:'AWS_PROFILE',description:'Named profile from ~/.aws/credentials (instead of keys).',url:'https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-files.html',secret:false},
 {key:'STRIPE_API_KEY',description:'Stripe secret key (use a test key sk_test_… while trying).',url:'https://dashboard.stripe.com/apikeys',secret:true},
 {key:'CLOUDFLARE_API_TOKEN',description:'Cloudflare API token.',url:'https://dash.cloudflare.com/profile/api-tokens',secret:true},
 {key:'GITHUB_TOKEN',description:'GitHub token for the github provider.',url:'https://github.com/settings/personal-access-tokens',secret:true},
];

const hash=value=>createHash('sha256').update(value).digest('hex').slice(0,16);
const exists=async path=>{try{await stat(path);return true;}catch{return false;}};

/** Folders (up to 4 levels) that contain *.tf files, `infra/` first. */
export async function findStacks(project,{depth=4}={}){
 const stacks=[];
 async function visit(dir,level){
  let entries;try{entries=await readdir(dir,{withFileTypes:true});}catch{return;}
  if(entries.some(e=>e.isFile()&&e.name.endsWith('.tf')))stacks.push(dir);
  if(level>=depth)return;
  for(const e of entries)if(e.isDirectory()&&!SKIP.has(e.name)&&!e.name.startsWith('.'))await visit(join(dir,e.name),level+1);
 }
 await visit(project.path,0);
 return stacks.map(path=>({id:hash(path),path,project:project.name,projectPath:project.path,name:relative(project.path,path)||'.'}))
  .sort((a,b)=>Number(!a.name.startsWith('infra'))-Number(!b.name.startsWith('infra'))||a.name.localeCompare(b.name));
}

/** Match the `{…}` block that starts at `open` (ignores braces inside strings). */
function block(text,open){
 let depth=0,quote=false;
 for(let i=open;i<text.length;i++){
  const c=text[i];
  if(c==='"'&&text[i-1]!=='\\')quote=!quote;
  if(quote)continue;
  if(c==='{')depth++;else if(c==='}'&&--depth===0)return text.slice(open+1,i);
 }
 return text.slice(open+1);
}

/** Variables declared in the stack's *.tf files: name, description, type, default, sensitive, links. */
export async function readVariables(dir){
 const files=(await readdir(dir)).filter(f=>f.endsWith('.tf')).sort();
 const variables=[];
 for(const file of files){
  const text=await readFile(join(dir,file),'utf8');
  for(const match of text.matchAll(/^\s*variable\s+"([A-Za-z_][A-Za-z0-9_-]*)"\s*\{/gm)){
   const body=block(text,match.index+match[0].length-1);
   const description=body.match(/^\s*description\s*=\s*"((?:[^"\\]|\\.)*)"/m)?.[1]?.replace(/\\"/g,'"')??'';
   variables.push({
    name:match[1],file,description,
    type:body.match(/^\s*type\s*=\s*(.+)$/m)?.[1]?.trim()??'string',
    required:!/^\s*default\s*=/m.test(body),
    sensitive:/^\s*sensitive\s*=\s*true/m.test(body),
    links:[...description.matchAll(/https?:\/\/[^\s)"']+/g)].map(m=>m[0]),
   });
  }
 }
 return variables;
}

/** Terraform errors in command output: summary, file and line when present. */
export function parseErrors(output){
 const errors=[];const lines=output.split('\n');
 for(let i=0;i<lines.length;i++){
  const m=lines[i].match(/^[│|\s]*Error:\s*(.+)$/);if(!m)continue;
  const context=lines.slice(i+1,i+6).join('\n').match(/on ([^\s]+) line (\d+)/);
  errors.push({summary:m[1].trim(),file:context?.[1]??null,line:context?Number(context[2]):null});
 }
 return errors;
}

export class TerraformRunner {
 constructor({home,spawn=spawnProcess,binary='terraform',now=()=>new Date()}){this.home=join(home,'terraform');this.spawn=spawn;this.binary=binary;this.now=now;this.jobs=new Map();}

 async readJson(path,fallback){try{return JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
 async writeJson(path,data){await mkdir(join(path,'..'),{recursive:true,mode:0o700});await writeFile(path,JSON.stringify(data,null,2)+'\n',{mode:0o600});}

 // -- values ---------------------------------------------------------------

 /** Global environment (AWS, Stripe… keys) shared by every stack. Returns which keys are set. */
 async globals(){const values=(await this.readJson(join(this.home,'global.json'),{env:{}})).env;return GLOBAL_VARIABLES.map(v=>({...v,present:Boolean(values[v.key])})).concat(Object.keys(values).filter(k=>!GLOBAL_VARIABLES.some(v=>v.key===k)).map(key=>({key,description:'Custom variable',secret:true,present:true})));}

 async setGlobal(key,value){
  if(!/^[A-Z][A-Z0-9_]{1,80}$/.test(key))throw new Error('Invalid variable name');
  const data=await this.readJson(join(this.home,'global.json'),{env:{}});
  if(value)data.env[key]=String(value);else delete data.env[key];
  await this.writeJson(join(this.home,'global.json'),data);
 }

 /** Variables of a stack with whether each has a value (secrets are never returned). */
 async variables(stack){
  const values=(await this.readJson(join(this.home,stack.id+'.json'),{vars:{}})).vars;
  return (await readVariables(stack.path)).map(v=>({...v,present:values[v.name]!==undefined,value:v.sensitive?undefined:values[v.name]}));
 }

 async setVariable(stack,name,value){
  const known=(await readVariables(stack.path)).some(v=>v.name===name);
  if(!known)throw new Error('Unknown variable: '+name);
  const data=await this.readJson(join(this.home,stack.id+'.json'),{vars:{}});
  if(value===''||value===undefined||value===null)delete data.vars[name];else data.vars[name]=String(value);
  await this.writeJson(join(this.home,stack.id+'.json'),data);
 }

 /** Environment for a run: process env + globals + TF_VAR_<name> per stack value. */
 async environment(stack,base=process.env){
  const globals=(await this.readJson(join(this.home,'global.json'),{env:{}})).env;
  const vars=(await this.readJson(join(this.home,stack.id+'.json'),{vars:{}})).vars;
  return {...base,...globals,...Object.fromEntries(Object.entries(vars).map(([k,v])=>['TF_VAR_'+k,v])),TF_IN_AUTOMATION:'1',CHECKPOINT_DISABLE:'1'};
 }

 // -- runs -----------------------------------------------------------------

 /**
  * Start a command in the background; returns the run id. One run per stack at a time. Apply needs
  * a plan saved by this manager (it applies exactly what was reviewed) and consumes it.
  */
 async run(stack,command){
  if(!COMMANDS[command])throw new Error('Unknown Terraform command');
  if([...this.jobs.values()].some(j=>j.stack===stack.id&&j.state==='running'))throw new Error('A command is already running for this stack');
  const plan=join(this.home,'plans',stack.id+'.tfplan');await mkdir(join(this.home,'plans'),{recursive:true,mode:0o700});
  if(command==='apply'&&!await exists(plan))throw new Error('Run Plan first: Apply applies the last reviewed plan');
  if(!['init','fmt'].includes(command)&&!await exists(join(stack.path,'.terraform')))throw new Error('Run Init first');
  const id=randomUUID(),started=this.now().toISOString();
  const job={id,stack:stack.id,command,state:'running',startedAt:started,output:''};
  this.jobs.set(id,job);
  const env=await this.environment(stack);
  const secrets=Object.entries(env).filter(([k,v])=>v&&v.length>=8&&(/KEY|SECRET|TOKEN|PASSWORD/.test(k)||k.startsWith('TF_VAR_'))).map(([,v])=>v);
  const redact=text=>secrets.reduce((t,s)=>t.split(s).join('[redacted]'),text);
  const child=this.spawn(this.binary,COMMANDS[command](plan),{cwd:stack.path,env,stdio:['ignore','pipe','pipe']});
  const append=chunk=>{job.output=(job.output+redact(String(chunk))).slice(-2_000_000);};
  child.stdout?.on('data',append);child.stderr?.on('data',append);
  const finish=async code=>{
   job.state=code===0?'succeeded':'failed';job.exitCode=code;job.finishedAt=this.now().toISOString();job.errors=parseErrors(job.output);
   if(command==='apply'&&code===0)await rm(plan,{force:true});
   if(command==='plan'&&code!==0)await rm(plan,{force:true});
   const history=await this.readJson(join(this.home,'runs',stack.id+'.json'),[]);
   await this.writeJson(join(this.home,'runs',stack.id+'.json'),[{id,command,state:job.state,exitCode:code,startedAt:job.startedAt,finishedAt:job.finishedAt,errors:job.errors,output:job.output},...history].slice(0,50));
  };
  child.once('error',error=>{append(`\n${error.code==='ENOENT'?'terraform was not found. Install it from Add tools & services (Terraform).':error.message}\n`);void finish(127);});
  child.once('close',code=>void finish(code??1));
  return {id};
 }

 /** A run: live while running, from the history afterwards. */
 async getRun(stack,id){
  const live=this.jobs.get(id);if(live)return live;
  return (await this.readJson(join(this.home,'runs',stack.id+'.json'),[])).find(r=>r.id===id);
 }

 /** Past runs of a stack, newest first, without their output. */
 async history(stack){return (await this.readJson(join(this.home,'runs',stack.id+'.json'),[])).map(({output,...rest})=>rest);}
}
