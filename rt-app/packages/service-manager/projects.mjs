import {templates,template,backends,backend} from '@gsalgadotoledo/rt-app-create';
import {Toolchains} from '@gsalgadotoledo/rt-app-create/runtime';
import {readFile,writeFile,realpath} from 'node:fs/promises';
import {spawn as spawnProcess} from 'node:child_process';
import {join} from 'node:path';
import {createRequire} from 'node:module';

const version=createRequire(import.meta.url)('./package.json').version;

/**
 * Command that creates projects: the published initializer pinned to this Service Manager's
 * release, exactly what a user runs in a terminal. RT_APP_CREATE_COMMAND (JSON array) overrides it
 * for unpublished builds, e.g. ["node","/path/to/rt-app/packages/create-rt-app/bin/create-rt-app.mjs"].
 */
export function initializerCommand(env=process.env){
 if(env.RT_APP_CREATE_COMMAND){
  let command;
  try{command=JSON.parse(env.RT_APP_CREATE_COMMAND);}catch{throw new Error('RT_APP_CREATE_COMMAND must be a JSON array');}
  if(!Array.isArray(command)||!command.length||command.some(part=>typeof part!=='string'||!part))throw new Error('RT_APP_CREATE_COMMAND must be a JSON array of strings');
  return command;
 }
 return ['npx','--yes',`@gsalgadotoledo/create-rt-app@${version}`];
}

/** Run a command, streaming each output line to `log`. Resolves with the exit code. */
export function streamCommand(command,args,{cwd,env,log,spawn=spawnProcess}){
 return new Promise((resolve,reject)=>{
  const child=spawn(command,args,{cwd,env,stdio:['ignore','pipe','pipe']});
  const forward=stream=>{let rest='';stream.setEncoding('utf8');stream.on('data',chunk=>{const lines=(rest+chunk).split('\n');rest=lines.pop();for(const line of lines)if(line.trim())log(line);});stream.on('end',()=>{if(rest.trim())log(rest);});};
  forward(child.stdout);forward(child.stderr);
  child.once('error',reject);
  child.once('close',code=>resolve(code));
 });
}

export class ProjectWizard {
 constructor(hub,{spawn,env=process.env}={}){this.hub=hub;this.tools=new Toolchains(hub.home);this.job={state:'idle',log:[]};this.workspace='';this.spawn=spawn;this.env=env;}
 async initialize(){
  try{this.workspace=JSON.parse(await readFile(join(this.hub.home,'workspace.json'),'utf8')).path;}catch(e){if(e.code!=='ENOENT')throw e;}
  // settings.json → createCommand overrides the initializer for unpublished builds (apps opened
  // from Finder do not inherit terminal variables). The environment variable still wins.
  try{const {createCommand}=JSON.parse(await readFile(join(this.hub.home,'settings.json'),'utf8'));if(createCommand&&!this.env.RT_APP_CREATE_COMMAND)this.env={...this.env,RT_APP_CREATE_COMMAND:JSON.stringify(createCommand)};}catch(e){if(e.code!=='ENOENT')throw e;}
  await this.activateTools();
 }
 async activateTools(){const env=await this.tools.environment();process.env.PATH=env.PATH;}
 /** Templates (with their prompts), backends, requirement status and the running job. */
 async status(templateId='fullstack',backendId='node-ts'){const spec=await template(templateId);return {templates:await templates(),backends,requirements:await this.tools.status([...new Set([...spec.requirements,...backend(backendId).tools])]),workspace:this.workspace,job:this.job,initializer:initializerCommand(this.env).join(' ')};}
 log=text=>{this.job.log=[...this.job.log,...String(text).split('\n').filter(Boolean)].slice(-200);};
 async choose(path){if(this.job.state==='running')throw new Error('Wait for the current operation');this.workspace=await realpath(path);await writeFile(join(this.hub.home,'workspace.json'),JSON.stringify({path:this.workspace})+'\n',{mode:0o600});return this.workspace;}
 begin(fn){if(this.job.state==='running')throw new Error('An operation is already running');this.job={state:'running',log:[]};void fn().then(result=>{this.job={...this.job,state:'done',result};}).catch(e=>{this.job={...this.job,state:'error',error:e.message};});return {accepted:true};}
 install(ids){return this.begin(async()=>{await this.tools.install(ids,this.log);await this.activateTools();return {toolsInstalled:true};});}

 /**
  * Create a project by running the initializer in the chosen workspace. Its output is the job log
  * (the wizard's terminal). The project is opened in the manager when it finishes.
  */
 create({name,templateId,backendId='node-ts'}){return this.begin(async()=>{
  if(!this.workspace)throw new Error('Choose a workspace first');
  const spec=await template(templateId);
  const required=await this.tools.status([...new Set([...spec.requirements,...backend(backendId).tools])]);
  if(required.some(r=>r.required&&!r.ready))throw new Error('Install missing requirements before creating a project');
  const [command,...prefix]=initializerCommand(this.env);
  const args=[...prefix,name,'--template',templateId,'--backend',backendId,'--dir',this.workspace];
  this.log('$ '+[command,...args].join(' '));
  const code=await streamCommand(command,args,{cwd:this.workspace,env:{...this.env,...await this.tools.environment()},log:this.log,spawn:this.spawn});
  if(code!==0)throw new Error(`Project creation failed (exit ${code}). See the output above.`);
  const path=join(this.workspace,name);
  await this.hub.select(path);
  return {path,name,template:templateId,backend:backendId};
 });}
}
