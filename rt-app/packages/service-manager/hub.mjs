import { packageFile } from '@gsalgadotoledo/rt-app-config/paths';
import {runtimeLabel} from './runtime-label.mjs';
import {Toolchains} from '@gsalgadotoledo/rt-app-create/runtime';
import {catalog,installTool,toolService} from './catalog.mjs';
import {discover} from './discovery.mjs';
const jobs=new Map();
import {readFile,writeFile,mkdir,rename,realpath} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,basename} from 'node:path';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {ensureDaemon,request,manifest,bindPorts} from './client.mjs';
const defaults={api:4010,admin:5174,spa:5175,ssr:5176};
const active=s=>['running','starting','waiting'].includes(s.state);
async function read(path,fallback){try{return JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code==='ENOENT'&&fallback!==undefined)return fallback;throw e;}}
async function save(path,data){const temp=path+`.${process.pid}.tmp`;await writeFile(temp,JSON.stringify(data,null,2)+'\n',{mode:0o600});await rename(temp,path);}
async function available(port){return new Promise(resolve=>{const server=createServer();server.once('error',()=>resolve(false));server.listen(port,'127.0.0.1',()=>server.close(()=>resolve(true)));});}
function validatePorts(ports){const values=Object.values(ports);if(values.some(p=>!Number.isInteger(p)||p<1024||p>65535)||new Set(values).size!==values.length)throw new Error('Ports must be distinct integers between 1024 and 65535');}
function extraPorts(extra=[]){return Object.fromEntries(extra.flatMap(s=>(s.portEnv??[]).map((key,i)=>[`${s.id}.${i}`,s.ports[i]])));}
function updateExtras(extra=[],ports){return extra.map(s=>{
 const next=(s.ports??[]).map((p,i)=>ports[`${s.id}.${i}`]??p);
 const rewrite=value=>{if(!value)return value;const url=new URL(value);const index=(s.ports??[]).indexOf(Number(url.port));if(index>=0)url.port=String(next[index]);return url.href;};
 return {...s,ports:next,...(s.url?{url:rewrite(s.url)}:{}),...(s.readyUrl?{readyUrl:rewrite(s.readyUrl)}:{})};});}
async function stopped(root){for(let i=0;i<650;i++){const s=await request(root,'status');if(s.services.every(s=>!s.pid&&!active(s)))return;await delay(100);}throw new Error('Services did not stop; configuration was not applied');}
async function apply(root,config){
 const path=join(root,'.rt-app/services.json');const old=await read(path);const before=await request(root,'status');
 const resume=before.services.filter(active).map(s=>s.id);
 await request(root,'stop','all');await stopped(root);
 try{await save(path,config);await request(root,'reload');}catch(error){await save(path,old);await request(root,'reload');for(const id of resume)await request(root,'start',id);throw error;}
 for(const id of resume)if(config.services.some(s=>s.id===id))await request(root,'start',id);
}
/** Main-process coordinator. Each project retains its own native daemon; common services have one per user. */
export class ServiceHub {
 constructor({home=join(homedir(),'.rt-app','service-manager'),binary,noBuild=false,noMail=false}={}){this.home=home;this.options={binary,noBuild,noMail};this.root=null;this.queue=Promise.resolve();}
 exclusive(fn){const job=this.queue.then(fn);this.queue=job.catch(()=>{});return job;}
 async initialize(){await mkdir(this.home,{recursive:true,mode:0o700});this.registry=await read(join(this.home,'projects.json'),[]);this.global=await read(join(this.home,'settings.json'),{version:1,ports:{smtp:1025,mail:8025},extra:[]});validatePorts(this.global.ports);}
 async select(root){return this.exclusive(async()=>{
  this.registry=await read(join(this.home,'projects.json'),[]);this.global=await read(join(this.home,'settings.json'),this.global);
  root=await realpath(root);const settings=await read(join(root,'rt-app.settings.json'));const pkg=await read(join(root,'package.json'));
  if(settings.version!==1||!settings.runtime?.local)throw new Error('Select a project containing rt-app.settings.json version 1 and package.json');
  const existing=this.registry.find(p=>p.path===root);
  if(!existing){
   const reserved=new Set([...Object.values(this.global.ports),...(this.global.extra??[]).flatMap(s=>s.ports??[])]);
   for(const p of this.registry){try{const config=await read(join(p.path,'rt-app.settings.json'));[...Object.values({...defaults,...config.local?.ports}),...(config.services?.extra??[]).flatMap(s=>s.ports??[])].forEach(n=>reserved.add(n));}catch{}}
   const ports={...defaults,...(settings.backend&&settings.backend!=='node-ts'?{coreApi:4011}:{}),...settings.local?.ports};
   for(const key of Object.keys(ports)){if(settings.local?.ports?.[key]!==undefined)continue;while(reserved.has(ports[key])||!await available(ports[key])){if(++ports[key]>65535)throw new Error('No available local ports');}reserved.add(ports[key]);}
   for(const service of settings.services?.extra??[]){for(let i=0;i<(service.ports??[]).length;i++){if(!service.portEnv?.[i])continue;while(reserved.has(service.ports[i])||!await available(service.ports[i])){if(++service.ports[i]>65535)throw new Error('No available service port');}reserved.add(service.ports[i]);}}
   validatePorts(ports);settings.local={...settings.local,ports};await save(join(root,'rt-app.settings.json'),settings);
   this.registry.push({path:root,name:pkg.name??basename(root)});await save(join(this.home,'projects.json'),this.registry);
  }
  this.root=root;
  // The command belongs to the framework, but its cache/database belong to the global directory.
  this.global.mailCommand??=['node',packageFile('@gsalgadotoledo/rt-app-cli','bin/rta.mjs',root),'mail'];
  await save(join(this.home,'settings.json'),this.global);
  const globalConfig=this.globalManifest();const globalDaemon=await ensureDaemon(this.home,{binary:this.options.binary,config:globalConfig});
  if(!globalDaemon.started&&JSON.stringify(await read(join(this.home,'.rt-app/services.json')))!==JSON.stringify(globalConfig))await apply(this.home,globalConfig);
  await this.ensureProject(root);
  return this.snapshot();
 });}
 globalManifest(){const {smtp,mail}=this.global.ports;return {services:[{id:'mail',label:'Mailpit · shared email',cwd:'.',command:this.global.mailCommand,env:{RT_APP_MAIL_SMTP_PORT:String(smtp),RT_APP_MAIL_UI_PORT:String(mail)},ports:[smtp,mail],url:`http://localhost:${mail}`,readyUrl:`http://localhost:${mail}/readyz`,dependencies:[]},...(this.global.extra??[]).map(bindPorts)]};}
 async projectManifest(root,settings){return manifest(root,{...this.options,sharedMail:this.global.ports,sharedEnv:Object.fromEntries((this.global.extra??[]).flatMap(s=>(s.portEnv??[]).map((key,i)=>[key,String(s.ports[i])]))),settings});}
 async ensureProject(root){const config=await this.projectManifest(root);const {started}=await ensureDaemon(root,{binary:this.options.binary,config});if(!started){const current=await read(join(root,'.rt-app/services.json'));if(JSON.stringify(current)!==JSON.stringify(config))await apply(root,config);}}
 async snapshot(){
  if(!this.root)return {project:'',services:[],projects:this.registry,catalog:[]};
  this.global=await read(join(this.home,'settings.json'),this.global);this.registry=await read(join(this.home,'projects.json'),this.registry);
  const [project,global]=await Promise.all([request(this.root,'status'),request(this.home,'status')]);
  const settings=await read(join(this.root,'rt-app.settings.json'));
  const config=await read(join(this.root,'.rt-app/services.json'),{services:[]});
  const globalConfig=await read(join(this.home,'.rt-app/services.json'),{services:[]});
  const runtime=(s,list,backend)=>runtimeLabel(list.find(spec=>spec.id===s.id)??s,backend);
  return {...project,catalog:catalog.map(t=>({...t,installed:(this.global.catalogTools??[]).includes(t.id),job:jobs.get(t.id)})),projects:this.registry,globalPorts:{...this.global.ports,...extraPorts(this.global.extra)},projectPorts:{...defaults,...settings.local?.ports,...extraPorts(settings.services?.extra)},services:[...global.services.map(s=>({...s,runtime:runtime(s,globalConfig.services),id:`global:${s.id}`,scope:'global',project:'Shared across projects'})),...project.services.map(s=>({...s,runtime:runtime(s,config.services,settings.backend),scope:'project',project:this.registry.find(p=>p.path===this.root)?.name??basename(this.root)}))]};
 }
 async waitMail(){await request(this.home,'start','mail');for(let i=0;i<950;i++){const s=(await request(this.home,'status')).services.find(s=>s.id==='mail');if(s.state==='running')return;if(['failed','blocked'].includes(s.state))throw new Error(`Shared mail: ${s.error}`);await delay(100);}throw new Error('Shared email startup timed out');}
 action(action,id){return this.exclusive(async()=>{
  if(!['start','stop','restart'].includes(action))throw new Error('Invalid action');
  if(id.startsWith('global:'))return request(this.home,action,id.slice(7));
  if(action!=='stop'){const settings=await read(join(this.root,'rt-app.settings.json'));const required=Object.keys(settings.requirements??{node:'24'});const missing=(await new Toolchains(this.home).status(required)).filter(t=>t.required&&!t.ready);if(missing.length)throw new Error('Install project requirements first: '+missing.map(t=>t.name).join(', '));}
  if(action!=='stop'&&!this.options.noMail&&id!=='build')await this.waitMail();
  return request(this.root,action,id==='project:all'?'all':id);
 });}
 logs(id){return request(id.startsWith('global:')?this.home:this.root,'logs',id.replace(/^global:/,''));}
 async url(id){const s=(await this.snapshot()).services.find(s=>s.id===id);if(!s?.url)throw new Error('No browser URL');const url=new URL(s.url);if(url.protocol!=='http:'||!['localhost','127.0.0.1'].includes(url.hostname)||url.username||url.password)throw new Error('Only local service URLs can be opened');return url.href;}
 async catalogAction(action,id){
  if(!catalog.some(t=>t.id===id))throw new Error('Unknown tool');
  if(jobs.get(id)?.state==='installing')throw new Error('Installation already running');
  if(action==='add'){
   jobs.set(id,{state:'installing',message:'Preparing…'});
   void (async()=>{try{
    const info=await installTool(this.home,id,message=>jobs.set(id,{state:'installing',message}));
    await this.exclusive(async()=>{
     this.global=await read(join(this.home,'settings.json'));if((this.global.catalogTools??[]).includes(id))return;
     if((this.global.extra??[]).some(s=>s.id===id))throw new Error('A custom service already uses this ID');
     let port=catalog.find(t=>t.id===id).port;const reserved=new Set([...Object.values(this.global.ports),...(this.global.extra??[]).flatMap(s=>s.ports??[])]);
     for(const p of this.registry){const config=await read(join(p.path,'rt-app.settings.json'),{});Object.values({...defaults,...config.local?.ports}).forEach(p=>reserved.add(p));}
     if(port){while(reserved.has(port)||!await available(port)){if(++port>65535)throw new Error('No available port');}}
     const service=await toolService(this.home,info,port);
     const previous=this.global;this.global={...previous,catalogTools:[...(previous.catalogTools??[]),id],extra:[...(previous.extra??[]),...(service?[service]:[])]};
     try{await apply(this.home,this.globalManifest());await save(join(this.home,'settings.json'),this.global);}catch(e){this.global=previous;throw e;}
     if(service)await request(this.home,'start',id);
    });jobs.set(id,{state:'ready',message:`Installed ${info.version}`});
   }catch(e){jobs.set(id,{state:'error',message:e.message});}})();
   return {accepted:true};
  }
  if(action!=='remove')throw new Error('Invalid catalog action');
  return this.exclusive(async()=>{
   this.global=await read(join(this.home,'settings.json'));const previous=this.global;
   this.global={...previous,catalogTools:(previous.catalogTools??[]).filter(t=>t!==id),extra:(previous.extra??[]).filter(s=>s.catalogId!==id)};
   try{await apply(this.home,this.globalManifest());await save(join(this.home,'settings.json'),this.global);}catch(e){this.global=previous;throw e;}
   jobs.delete(id);return {removed:true,dataPreserved:true};
  });
 }
 async discover(){const settings=await read(join(this.root,'rt-app.settings.json'));const existing=new Set((settings.services?.extra??[]).map(s=>s.id));return (await discover(this.root)).filter(s=>!existing.has(s.id));}
 addDiscovered(id){return this.exclusive(async()=>{
  const candidate=(await this.discover()).find(s=>s.id===id);if(!candidate)throw new Error('Candidate not found; scan again');
  const path=join(this.root,'rt-app.settings.json'),settings=await read(path),next={...settings,services:{...settings.services,extra:[...(settings.services?.extra??[]),candidate]}};
  await apply(this.root,await this.projectManifest(this.root,next));await save(path,next);return this.snapshot();
 });}
 setPorts(scope,ports){return this.exclusive(async()=>{
  if(!['global','project'].includes(scope))throw new Error('Invalid scope');
  const snapshot=await this.snapshot();
  const current=scope==='global'?snapshot.globalPorts:snapshot.projectPorts;
  const keys=Object.keys(current);
  if(!ports||Object.keys(ports).length!==keys.length||keys.some(k=>!(k in ports)))throw new Error('Invalid port configuration');validatePorts(ports);
  const occupied=new Set();
  for(const p of this.registry){if(scope==='project'&&p.path===this.root)continue;const settings=await read(join(p.path,'rt-app.settings.json'),{});[...Object.values({...defaults,...settings.local?.ports}),...(settings.services?.extra??[]).flatMap(s=>s.ports??[])].forEach(n=>occupied.add(n));}
  if(scope==='project')Object.values(this.global.ports).forEach(n=>occupied.add(n));
  (this.global.extra??[]).flatMap(s=>(s.ports??[]).filter((_,i)=>scope==='project'||!(s.portEnv??[])[i])).forEach(n=>occupied.add(n));
  if(Object.values(ports).some(n=>occupied.has(n)))throw new Error('Port is reserved by another project or global service');
  for(const n of Object.values(ports))if(!Object.values(current).includes(n)&&!await available(n))throw new Error(`Port ${n} is occupied; no changes saved`);
  if(scope==='project'){
   const path=join(this.root,'rt-app.settings.json'),settings=await read(path);const next={...settings,local:{...settings.local,ports:Object.fromEntries(Object.keys(defaults).map(k=>[k,ports[k]]))},services:{...settings.services,extra:updateExtras(settings.services?.extra,ports)}};const config=await this.projectManifest(this.root,next);
   await apply(this.root,config);await save(path,next);
  }else if(scope==='global'){
   const previous=this.global;this.global={...previous,ports:{smtp:ports.smtp,mail:ports.mail},extra:updateExtras(previous.extra,ports)};
   try{await apply(this.home,this.globalManifest());}catch(e){this.global=previous;throw e;}
   await save(join(this.home,'settings.json'),this.global);
   const failures=[];
   for(const p of this.registry){try{await request(p.path,'status');}catch{continue;}try{await apply(p.path,await this.projectManifest(p.path));}catch(e){failures.push(`${p.name}: ${e.message}`);}}
   if(failures.length)throw new Error(`Global ports saved, but these projects need restarting: ${failures.join('; ')}`);
  }else throw new Error('Invalid scope');
  return this.snapshot();
 });}
}
