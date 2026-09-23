import {templates,template,createProject,backends,backend} from '@gsalgadotoledo/rt-app-create';
import {Toolchains} from '@gsalgadotoledo/rt-app-create/runtime';
import {readFile,writeFile,realpath} from 'node:fs/promises';
import {join} from 'node:path';
export class ProjectWizard {
 constructor(hub){this.hub=hub;this.tools=new Toolchains(hub.home);this.job={state:'idle',log:[]};this.workspace='';}
 async initialize(){try{this.workspace=JSON.parse(await readFile(join(this.hub.home,'workspace.json'),'utf8')).path;}catch(e){if(e.code!=='ENOENT')throw e;}await this.activateTools();}
 async activateTools(){const env=await this.tools.environment();process.env.PATH=env.PATH;}
 async status(templateId='fullstack',backendId='node-ts'){const spec=await template(templateId);return {templates:await templates(),backends,requirements:await this.tools.status([...new Set([...spec.requirements,...backend(backendId).tools])]),workspace:this.workspace,job:this.job};}
 log=text=>{this.job.log=[...this.job.log,...String(text).split('\n').filter(Boolean)].slice(-100);};
 async choose(path){if(this.job.state==='running')throw new Error('Wait for the current operation');this.workspace=await realpath(path);await writeFile(join(this.hub.home,'workspace.json'),JSON.stringify({path:this.workspace})+'\n',{mode:0o600});return this.workspace;}
 begin(fn){if(this.job.state==='running')throw new Error('An operation is already running');this.job={state:'running',log:[]};void fn().then(result=>{this.job={...this.job,state:'done',result};}).catch(e=>{this.job={...this.job,state:'error',error:e.message};});return {accepted:true};}
 install(ids){return this.begin(async()=>{await this.tools.install(ids,this.log);await this.activateTools();return {toolsInstalled:true};});}
 create({name,templateId,backendId='node-ts'}){return this.begin(async()=>{if(!this.workspace)throw new Error('Choose a workspace first');const spec=await template(templateId);const required=await this.tools.status([...new Set([...spec.requirements,...backend(backendId).tools])]);if(required.some(r=>r.required&&!r.ready))throw new Error('Install missing requirements before creating a project');const result=await createProject({workspace:this.workspace,name,templateId,backendId,env:await this.tools.environment(),onLog:this.log});await this.hub.select(result.path);return result;});}
}
