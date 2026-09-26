import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {join,dirname,relative,resolve} from 'node:path';
import {homedir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {loadConfig,findContracts,loadContract,runTarget,saveRecorded} from '@gsalgadotoledo/rt-app-conformance';

/**
 * Language contracts of projects (rt-app-conformance): find `contracts.json` configs, describe
 * their cases (inputs → expected outputs), run them on every language target and keep a history.
 * Recording writes expectations into the contract files, so it needs an explicit request.
 */

/** Where a project keeps its contracts config, in order of preference. */
export const CONFIG_CANDIDATES=['contracts.json','spec/contracts.json','rt-app/spec/contracts.json'];

const hash=value=>createHash('sha256').update(value).digest('hex').slice(0,16);
const exists=async path=>{try{await stat(path);return true;}catch{return false;}};

/** Tool folders a GUI app may not have on PATH (Homebrew, /usr/local, Go, installed toolchains). */
export async function toolPaths(home=homedir()){
 const paths=['/opt/homebrew/bin','/usr/local/bin',join(home,'go','bin'),join(home,'.local','bin')];
 try{paths.unshift(...JSON.parse(await readFile(join(home,'.rt-app','service-manager','toolchains','paths.json'),'utf8')));}catch{}
 return paths;
}

/** contracts.json files of the given projects plus extra configs added by the user. */
export async function findConfigs(projects,extra=[]){
 const found=[];
 for(const project of projects){
  for(const candidate of CONFIG_CANDIDATES){
   const path=join(project.path,candidate);
   if(await exists(path)){found.push({id:hash(path),path,project:project.name,name:relative(project.path,path)});break;}
  }
 }
 for(const path of extra)if(!found.some(c=>c.path===path)&&await exists(path))found.push({id:hash(path),path,project:dirname(path).split('/').slice(-2).join('/'),name:'contracts.json',added:true});
 return found;
}

const brief=value=>{const text=JSON.stringify(value);return text===undefined?'':text.length>160?text.slice(0,157)+'…':text;};

/** Cases of a config as plain data for the UI. */
export async function describe(configPath){
 const {config,targets,contractPaths}=await loadConfig(configPath);
 const files=await findContracts(contractPaths);
 const contracts=[];
 for(const file of files){
  try{
   const c=await loadContract(file);
   contracts.push({file,relative:relative(dirname(configPath),file),module:c.module,title:c.title??'',kind:c.kind,description:c.description??'',cases:c.cases.map(x=>({
    name:x.name,tags:x.tags,init:c.kind==='module'&&JSON.stringify(x.init)!=='{}'?brief(x.init):'',
    create:x.create?(x.create.error?'error '+brief(x.create.error):'ok'):'',
    steps:c.kind==='module'?x.steps.map(s=>({call:`${s.call}(${brief(s.args).slice(1,-1)})`,expect:!s.expect?'(not recorded)':s.expect.error?'error '+brief(s.expect.error):brief(s.expect.value),note:s.note??''})):x.requests.map(r=>({call:`${r.request.method} ${r.request.path}${r.request.body!==undefined?' '+brief(r.request.body):r.request.raw!==undefined?' '+brief(r.request.raw):''}`,expect:`${r.expect?.status??''} ${r.expect?.body!==undefined?brief(r.expect.body):''}`.trim()||'(not recorded)',note:''})),
   }))});
  }catch(error){contracts.push({file,relative:relative(dirname(configPath),file),module:'?',title:'',kind:'module',description:'',error:error.message,cases:[]});}
 }
 return {path:configPath,reference:config.reference??targets[0]?.name,targets:targets.map(t=>({name:t.name,host:!!t.host,api:!!t.api})),contracts};
}

export class ContractRunner {
 constructor({home,paths}={}){this.home=join(home,'contracts');this.jobs=new Map();this.paths=paths;}
 async readJson(path,fallback){try{return JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
 async writeJson(path,data){await mkdir(dirname(path),{recursive:true,mode:0o700});await writeFile(path,JSON.stringify(data,null,2)+'\n',{mode:0o600});}
 /** Configs added by hand (outside known projects). */
 async extra(){return (await this.readJson(join(this.home,'configs.json'),{paths:[]})).paths;}
 async addConfig(path){
  path=resolve(path);
  const {config}=await loadConfig(path);
  if(!config.targets||!Object.keys(config.targets).length)throw new Error('This contracts.json has no targets');
  const paths=await this.extra();if(!paths.includes(path))paths.push(path);
  await this.writeJson(join(this.home,'configs.json'),{paths});
  return path;
 }
 async removeConfig(path){await this.writeJson(join(this.home,'configs.json'),{paths:(await this.extra()).filter(p=>p!==path)});}

 /**
  * Run contracts of a config in the background. `targets` limits the languages; `record` runs
  * only the reference target and writes expectations of unrecorded steps into the files.
  */
 async run(config,{targets:wanted,filter,record=false}={}){
  if([...this.jobs.values()].some(j=>j.config===config.id&&j.state==='running'))throw new Error('Contracts are already running for this config');
  const {config:raw,targets:all,contractPaths}=await loadConfig(config.path);
  const names=record?[raw.reference??all[0]?.name]:wanted?.length?wanted:all.map(t=>t.name);
  const selected=all.filter(t=>names.includes(t.name));
  if(!selected.length)throw new Error('Choose at least one target');
  const PATH=[...(this.paths??await toolPaths()),process.env.PATH].filter(Boolean).join(':');
  const withPath=target=>({...target,...Object.fromEntries(['host','api'].filter(k=>target[k]&&typeof target[k]==='object').map(k=>[k,{...target[k],env:{PATH,...target[k].env}}]))});
  const contracts=await Promise.all((await findContracts(contractPaths)).map(loadContract));
  const id=randomUUID();
  const job={id,config:config.id,state:'running',startedAt:new Date().toISOString(),targets:selected.map(t=>t.name),filter:filter||'',record,results:[],recorded:0,error:null};
  this.jobs.set(id,job);
  void (async()=>{
   try{
    for(const target of selected){
     job.current=target.name;
     const recorded=record?new Map():undefined;
     await runTarget(withPath(target),contracts,{filter:filter||undefined,recorded,onResult:r=>job.results.push({...r,file:r.file?relative(dirname(config.path),r.file):undefined})});
     if(recorded)for(const contract of contracts)job.recorded+=await saveRecorded(contract,recorded.get(contract.file)??new Map());
    }
    job.state=job.results.some(r=>r.status==='failed'||r.status==='unrecorded')?'failed':'passed';
   }catch(error){job.state='error';job.error=error.message;}
   job.current=null;job.finishedAt=new Date().toISOString();
   const history=await this.readJson(join(this.home,'runs',config.id+'.json'),[]);
   await this.writeJson(join(this.home,'runs',config.id+'.json'),[job,...history].slice(0,30));
   this.jobs.delete(id);
  })();
  return {id};
 }
 async getRun(config,id){return this.jobs.get(id)??(await this.readJson(join(this.home,'runs',config.id+'.json'),[])).find(r=>r.id===id);}
 /** Past runs, newest first, with per-target counts instead of every result. */
 async history(config){
  return (await this.readJson(join(this.home,'runs',config.id+'.json'),[])).map(({results,...run})=>({...run,summary:summarize(results)}));
 }
}

/** Counts per target and status. */
export function summarize(results=[]){
 const out={};
 for(const r of results){const t=out[r.target]??={passed:0,failed:0,missing:0,unrecorded:0,skipped:0};t[r.status]++;}
 return out;
}
