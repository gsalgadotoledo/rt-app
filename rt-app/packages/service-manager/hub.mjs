import {projectCommands, commandSpec} from './commands.mjs';
import { packageFile } from '@gsalgadotoledo/rt-app-config/paths';
import {runtimeLabel} from './runtime-label.mjs';
import {Toolchains} from '@gsalgadotoledo/rt-app-create/runtime';
import {catalog,installTool,toolService} from './catalog.mjs';
import {discover} from './discovery.mjs';
import {detectProject,projectName,genericServices,genericManifest,excludeFromGit,scanWorkspace} from './stacks.mjs';
import {LaunchAgents,agentLabel} from './launchd.mjs';
import {MachineProcesses} from './processes.mjs';
import {adminFor} from './admins.mjs';
import {projectInsights,projectRecords} from './insights.mjs';
import {detectApps,appTask,repository} from './apps.mjs';
import {TerraformRunner,findStacks} from './terraform.mjs';
import {WizardRunner} from './wizard.mjs';
import {ContractRunner,findConfigs,describe as describeContracts} from './contracts.mjs';
import {createHash as hashOf} from 'node:crypto';
import {spawn as spawnProcess} from 'node:child_process';
const jobs=new Map();
import {readFile,writeFile,mkdir,rename,realpath,readdir,stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,basename} from 'node:path';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {ensureDaemon,request,manifest,bindPorts,packageManager} from './client.mjs';
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
 constructor({home=join(homedir(),'.rt-app','service-manager'),binary,noBuild=false,noMail=false,agents,machine,terraform,contracts,spawn=spawnProcess}={}){this.home=home;this.spawn=spawn;this.installs=new Map();this.options={binary,noBuild,noMail};this.root=null;this.queue=Promise.resolve();this.agents=agents??new LaunchAgents({managerHome:home});this.machine=machine??new MachineProcesses();this.terraform=terraform??new TerraformRunner({home});this.contracts=contracts??new ContractRunner({home});this.wizard=new WizardRunner({spawn});}
 exclusive(fn){const job=this.queue.then(fn);this.queue=job.catch(()=>{});return job;}
 async initialize(){await mkdir(this.home,{recursive:true,mode:0o700});this.registry=await read(join(this.home,'projects.json'),[]);this.global=await read(join(this.home,'settings.json'),{version:1,ports:{smtp:1025,mail:8025},extra:[]});validatePorts(this.global.ports);}
 async select(root){return this.exclusive(async()=>{
  this.registry=await read(join(this.home,'projects.json'),[]);this.global=await read(join(this.home,'settings.json'),this.global);
  root=await realpath(root);const detected=await detectProject(root);
  if(!detected)throw new Error('Not a project: add package.json, pyproject.toml, go.mod, Cargo.toml, a Makefile or rt-app.settings.json');
  if(detected.kind==='generic')return this.openGeneric(root);
  const settings=await read(join(root,'rt-app.settings.json'));const pkg=await read(join(root,'package.json'));
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
  const previous=this.root;this.root=root;
  try{
  // The command belongs to the framework, but its cache/database belong to the global directory.
  this.global.mailCommand??=['node',packageFile('@gsalgadotoledo/rt-app-cli','bin/rta.mjs',root),'mail'];
  await save(join(this.home,'settings.json'),this.global);
  const globalConfig=this.globalManifest();const globalDaemon=await ensureDaemon(this.home,{binary:this.options.binary,config:globalConfig});
  if(!globalDaemon.started&&JSON.stringify(await read(join(this.home,'.rt-app/services.json')))!==JSON.stringify(globalConfig))await apply(this.home,globalConfig);
  await this.ensureProject(root);
  }catch(error){this.root=previous;throw error;}
  return this.snapshot();
 });}
 globalManifest(){const {smtp,mail}=this.global.ports;return {services:[...(this.global.mailCommand?[{id:'mail',label:'Mailpit · shared email',cwd:'.',command:this.global.mailCommand,env:{RT_APP_MAIL_SMTP_PORT:String(smtp),RT_APP_MAIL_UI_PORT:String(mail)},ports:[smtp,mail],url:`http://localhost:${mail}`,readyUrl:`http://localhost:${mail}/readyz`,dependencies:[]}]:[]),...(this.global.extra??[]).map(bindPorts)]};}
 /** Projects without rt-app.settings.json: services detected by convention, kept in the manager home. */
 async isGeneric(root){try{await read(join(root,'rt-app.settings.json'));return false;}catch{return true;}}
 genericPath(root){return join(this.home,'generic',hashOf('sha256').update(root).digest('hex').slice(0,16)+'.json');}
 async genericConfig(root){let saved=await read(this.genericPath(root),null);if(!saved){saved={services:await genericServices(root)};await mkdir(join(this.home,'generic'),{recursive:true,mode:0o700});await save(this.genericPath(root),saved);}return saved;}
 async openGeneric(root){
  if(!this.registry.some(p=>p.path===root)){this.registry.push({path:root,name:await projectName(root,basename(root)),kind:'generic'});await save(join(this.home,'projects.json'),this.registry);}
  this.root=root;
  // The supervisor keeps its state in <project>/.rt-app; hide it from git without editing tracked files.
  await excludeFromGit(root);
  const globalConfig=this.globalManifest();const globalDaemon=await ensureDaemon(this.home,{binary:this.options.binary,config:globalConfig});
  if(!globalDaemon.started&&JSON.stringify(await read(join(this.home,'.rt-app/services.json')))!==JSON.stringify(globalConfig))await apply(this.home,globalConfig);
  await this.ensureProject(root);
  return this.snapshot();
 }
 async projectManifest(root,settings){return manifest(root,{...this.options,sharedMail:this.global.ports,sharedEnv:Object.fromEntries((this.global.extra??[]).flatMap(s=>(s.portEnv??[]).map((key,i)=>[key,String(s.ports[i])]))),settings});}
 /** Last rt-app.settings.json modification time applied per project root (to follow edits). */
 settingsApplied=new Map();
 async settingsMtime(root){try{return (await stat(join(root,'rt-app.settings.json'))).mtimeMs;}catch{return 0;}}
 async ensureProject(root){this.settingsApplied.set(root,await this.settingsMtime(root));const config=await this.isGeneric(root)?genericManifest((await this.genericConfig(root)).services):await this.projectManifest(root);const {started}=await ensureDaemon(root,{binary:this.options.binary,config});if(!started){const current=await read(join(root,'.rt-app/services.json'));if(JSON.stringify(current)!==JSON.stringify(config))await apply(root,config);}}
 async snapshot(){
  if(!this.root)return {project:'',services:[],projects:await this.withActivity(await this.projects()),catalog:[]};
  this.global=await read(join(this.home,'settings.json'),this.global);this.registry=await read(join(this.home,'projects.json'),this.registry);
  const [project,global]=await Promise.all([request(this.root,'status'),request(this.home,'status')]);
  // rt-app.settings.json edited while the project is open (a new extra service, ports…): apply it,
  // like reopening the project. Runs in the background so the status poll never waits for it.
  const root=this.root,mtime=await this.settingsMtime(root);
  if(this.settingsApplied.has(root)&&mtime!==this.settingsApplied.get(root)){this.settingsApplied.set(root,mtime);void this.exclusive(()=>this.ensureProject(root)).catch(error=>console.error(`Could not apply rt-app.settings.json: ${error.message}`));}
  const settings=await read(join(this.root,'rt-app.settings.json'),{});
  const config=await read(join(this.root,'.rt-app/services.json'),{services:[]});
  const detected=await detectProject(this.root)??{kind:'generic',runtimes:[]};
  const background=new Set((await this.agents.registry().catch(()=>[])).map(b=>b.label));
  const installed=this.global.catalogTools??[];const pgweb=global.services.find(s=>s.id==='pgweb'&&s.state==='running');
  const globalConfig=await read(join(this.home,'.rt-app/services.json'),{services:[]});
  const runtime=(s,list,backend)=>runtimeLabel(list.find(spec=>spec.id===s.id)??s,backend);
  return {...project,catalog:catalog.map(t=>({...t,installed:(this.global.catalogTools??[]).includes(t.id),job:jobs.get(t.id)})),projects:await this.withActivity(await this.projects(),{[this.root]:project}),globalPorts:{...this.global.ports,...extraPorts(this.global.extra)},projectPorts:detected.kind==='generic'?{}:{...defaults,...settings.local?.ports,...extraPorts(settings.services?.extra)},projectKind:detected.kind,projectRuntimes:detected.runtimes,services:[...global.services.map(s=>({...s,runtime:runtime(s,globalConfig.services),id:`global:${s.id}`,scope:'global',project:'Shared across projects',background:background.has(agentLabel(this.home,s.id)),admin:adminFor({...(globalConfig.services.find(spec=>spec.id===s.id)??{}),...s},{installed,running:pgweb?{pgweb:pgweb.url}:{}})})),...project.services.map(s=>({...s,runtime:runtime(s,config.services,settings.backend),scope:'project',project:this.registry.find(p=>p.path===this.root)?.name??basename(this.root),background:background.has(agentLabel(this.root,s.id))}))]};
 }
 /** Electron/Tauri/React Native/Expo/Capacitor apps of the selected project (read-only detection). */
 async projectApps(){if(!this.root)return [];const config=await read(join(this.root,'.rt-app/services.json'),{services:[]});return detectApps(this.root,config.services);}

 /**
  * Launch an app of the selected project: its supervisor service when one runs it (dev), otherwise
  * an independent task running the app's script. Returns the service/task id for its output page.
  */
 async launchApp(id,action){
  if(typeof id!=='string'||typeof action!=='string')throw new Error('Invalid app');
  const app=(await this.projectApps()).find(a=>a.id===id);
  if(!app)throw new Error('App no longer exists; reopen the project');
  if(action==='dev'&&app.serviceId){await this.action('start',app.serviceId);return {id:app.serviceId};}
  return this.exclusive(async()=>{
   const config=await read(join(this.root,'.rt-app/services.json'),{services:[]});
   const spec=await appTask(this.root,app,action,config.services);
   await request(this.root,'run-command',undefined,spec);
   return {id:spec.id};
  });
 }

 /** Path of a packaged build (.app) of an app, re-resolved from detection (never taken from the UI). */
 async appBuild(id,index){const app=(await this.projectApps()).find(a=>a.id===id);const build=app?.builds[Number(index)];if(!build)throw new Error('Build not found');return build.path;}

 /** Web page of the selected project's git remote and current branch, or null. */
 repository(){return this.root?repository(this.root):null;}

 /** Modules, their initialization and record counts of the selected RT-App project (read-only). */
 async insights(){if(!this.root)throw new Error('Select a project first');if(await this.isGeneric(this.root))throw new Error('Insights are available for RT-App projects (rt-app.settings.json).');return projectInsights(this.root);}

 /** A page of records of one collection of the selected project (sensitive fields redacted). */
 async records(options){if(!this.root)throw new Error('Select a project first');if(await this.isGeneric(this.root))throw new Error('Records are available for RT-App projects.');return projectRecords(this.root,options);}

 /**
  * Run `<npm|pnpm|yarn> install` in a known project whose dependencies are missing (e.g. created by npx and never
  * installed). Runs in the background with a bounded log; poll installStatus(path). One run per
  * project at a time. Resolves immediately with the job; it never throws for the command's exit.
  */
 async installDependencies(path){
  if(typeof path!=='string'||!(await this.projects()).some(p=>p.path===path))throw new Error('Unknown project');
  const running=this.installs.get(path);
  if(running?.state==='running')return running;
  let manager='npm';try{manager=await packageManager(path);}catch{}
  const args=manager==='npm'?['install','--no-audit','--no-fund']:['install'];
  const job={path,state:'running',manager,log:[`$ ${manager} ${args.join(' ')}`],startedAt:new Date().toISOString()};
  this.installs.set(path,job);
  const append=chunk=>{job.log=[...job.log,...String(chunk).split('\n').filter(line=>line.trim())].slice(-300);};
  const child=this.spawn(process.platform==='win32'?`${manager}.cmd`:manager,args,{cwd:path,env:process.env,stdio:['ignore','pipe','pipe']});
  child.stdout?.on('data',append);child.stderr?.on('data',append);
  child.once('error',error=>{append(error.code==='ENOENT'?`${manager} was not found. Install it (for pnpm: corepack enable) and try again.`:error.message);job.state='failed';job.exitCode=127;});
  child.once('close',code=>{if(job.state!=='running')return;job.exitCode=code;job.state=code===0?'succeeded':'failed';append(code===0?'Dependencies installed.':`${manager} install failed (exit ${code}).`);});
  return job;
 }

 /** Last dependency install of a project, or null. */
 installStatus(path){return this.installs.get(path)??null;}

 /**
  * Adds `running` (active service count) to each project. Only supervisors that are already up are
  * asked; a project whose daemon is not running counts as 0 and nothing is started.
  */
 async withActivity(projects,known={}){
  return Promise.all(projects.map(async p=>{
   if(p.kind==='missing')return {...p,running:0};
   const status=known[p.path]??await request(p.path,'status').catch(()=>null);
   return {...p,running:status?status.services.filter(s=>s.pid&&active(s)).length:0};
  }));
 }
 /**
  * Projects opened before plus every RT-App project in the workspace folder (one level deep,
  * identified by rt-app.settings.json), so projects created with npx appear without opening them.
  */
 async projects(){
  const listed=[];
  for(const project of this.registry)listed.push({...project,...(await detectProject(project.path).catch(()=>undefined)??{kind:'missing',runtimes:[]})});
  let workspace;try{workspace=JSON.parse(await readFile(join(this.home,'workspace.json'),'utf8')).path;}catch(e){if(e.code!=='ENOENT')throw e;}
  if(!workspace)return listed;
  for(const project of await scanWorkspace(workspace))if(!listed.some(p=>p.path===project.path))listed.push({...project,discovered:true});
  return listed;
 }
 /**
  * Forget a project before its folder is deleted: shut down its supervisor (services stop) and
  * remove it from the registry. The folder itself is moved to the Trash by the desktop shell.
  * Only known projects (opened or found in the workspace) can be removed.
  */
 deleteProject(path){return this.exclusive(async()=>{
  const known=(await this.projects()).find(p=>p.path===path);
  if(!known)throw new Error('Unknown project');
  try{await request(path,'shutdown');for(let i=0;i<100;i++){await request(path,'status');await delay(100);}}catch{}
  this.registry=this.registry.filter(p=>p.path!==path);
  await save(join(this.home,'projects.json'),this.registry);
  if(this.root===path)this.root=null;
  return {removed:known.path};
 });}
 /** List scripts on demand; polling status never scans the source tree. */
 async commands(){
  if(!this.root) return [];
  const config=await read(join(this.root,'.rt-app/services.json'));
  return projectCommands(this.root,config.services);
 }

 /** Start an existing dev service or an independent, explicitly requested task. */
 runCommand(id){return this.exclusive(async()=>{
  if(!this.root || typeof id!=='string') throw new Error('Select a project and command');
  const config=await read(join(this.root,'.rt-app/services.json'));
  const resolved=await commandSpec(this.root,id,config.services);
  const required=await this.requiredTools();
  const missing=(await new Toolchains(this.home).status(required)).filter(t=>t.required&&!t.ready);
  if(missing.length)throw new Error('Install project requirements first: '+missing.map(t=>t.name).join(', '));
  if(resolved.serviceId){
   if(!this.options.noMail)await this.waitMail();
   await request(this.root,'start',resolved.serviceId);
   return {id:resolved.serviceId==='all'?'api':resolved.serviceId};
  }
  try{await request(this.root,'run-command',undefined,resolved.spec);}catch(error){if(error.message==='Unknown action')throw new Error('The running supervisor is an older version. Run rta services shutdown in this project, then reopen the project. This stops its services.');throw error;}
  return {id:resolved.spec.id};
 });}
 async waitMail(){await request(this.home,'start','mail');for(let i=0;i<950;i++){const s=(await request(this.home,'status')).services.find(s=>s.id==='mail');if(s.state==='running')return;if(['failed','blocked'].includes(s.state))throw new Error(`Shared mail: ${s.error}`);await delay(100);}throw new Error('Shared email startup timed out');}
 action(action,id){return this.exclusive(async()=>{
  if(!['start','stop','restart'].includes(action))throw new Error('Invalid action');
  if(id.startsWith('global:'))return request(this.home,action,id.slice(7));
  if(action!=='stop'){const required=await this.requiredTools();const missing=(await new Toolchains(this.home).status(required)).filter(t=>t.required&&!t.ready);if(missing.length)throw new Error('Install project requirements first: '+missing.map(t=>t.name).join(', '));}
  if(action!=='stop'&&!this.options.noMail&&id!=='build'&&!id.startsWith('run-')&&!await this.isGeneric(this.root))await this.waitMail();
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
 /** Toolchains a project needs before starting: RT-App settings, or the detected runtimes we can install. */
 async requiredTools(){
  try{const settings=await read(join(this.root,'rt-app.settings.json'));return Object.keys(settings.requirements??{node:'24'});}
  catch{const {runtimes=[]}=await detectProject(this.root)??{};return runtimes.filter(r=>['node','python','go'].includes(r));}
 }

 /**
  * Run a service always (LaunchAgent: starts at login, restarts when it exits) or stop doing so.
  * The supervised copy is stopped first so both never fight for the same port.
  */
 background(id,enabled){return this.exclusive(async()=>{
  const global=id.startsWith('global:'),root=global?this.home:this.root,serviceId=global?id.slice(7):id;
  if(!root)throw new Error('Select a project first');
  const config=await read(join(root,'.rt-app/services.json'));const spec=config.services.find(s=>s.id===serviceId);
  if(!spec)throw new Error('Unknown service');
  if(!enabled){await this.agents.disable(agentLabel(root,serviceId));return this.snapshot();}
  const bound=bindPorts(spec);
  await request(root,'stop',serviceId).catch(()=>{});
  await this.agents.enable({project:root,serviceId,name:spec.label,command:bound.command,cwd:join(root,spec.cwd??'.'),env:{PATH:process.env.PATH??'',...bound.env}});
  return this.snapshot();
 });}

 /** Development processes on this computer (Node, Python, Go, …), including ones we did not start. */
 async machineProcesses(){
  const statuses=await Promise.all([this.home,...this.registry.map(p=>p.path)].map(root=>request(root,'status').catch(()=>({services:[]}))));
  const managedPids=new Set(statuses.flatMap(s=>s.services.map(x=>x.pid)).filter(Boolean));
  const launchd=await this.agents.loaded().catch(()=>new Map());
  return this.machine.list({projects:await this.projects(),managedPids,launchd});
 }

 stopProcess(pid){if(!Number.isInteger(pid)||pid<2)throw new Error('Invalid process');return this.machine.stop(pid);}

 detachAgent(label){return this.agents.detach(label);}

 /** URL to open for "View admin" of a shared service; starts an installed admin tool when needed. */
 async adminUrl(id){
  const service=(await this.snapshot()).services.find(s=>s.id===id);
  if(!service?.admin)throw new Error('Unknown service');
  const admin=service.admin;
  if(admin.kind==='url')return admin.url;
  if(admin.kind==='start'){await request(this.home,'start',admin.tool);for(let i=0;i<50;i++){const pg=(await request(this.home,'status')).services.find(s=>s.id===admin.tool);if(pg?.state==='running'&&pg.url)return pg.url;await delay(200);}throw new Error(admin.name+' did not start; see its logs in Shared services');}
  throw new Error(admin.kind==='install'?`Install ${admin.name} from Add tools & services first`:admin.description);
 }

 // -- Deploy setup wizard (the project's deploy.wizard.json) ----------------------

 wizardRoot(){if(!this.root)throw new Error('Select a project first');return this.root;}
 wizardState(){return this.root?this.wizard.state(this.root):{wizard:null};}
 wizardSave(values){return this.wizard.save(this.wizardRoot(),values);}
 wizardRun(step,action){return this.wizard.run(this.wizardRoot(),step,action);}
 wizardGetRun(id){return this.wizard.getRun(id);}

 // -- Terraform ----------------------------------------------------------------

 /** Terraform stacks (folders with *.tf, `infra/` first) of every known project. */
 async terraformStacks(){
  const stacks=[];
  for(const project of await this.projects())if(project.kind!=='missing')stacks.push(...await findStacks(project));
  return Promise.all(stacks.map(async stack=>({...stack,lastRun:(await this.terraform.history(stack))[0]??null})));
 }
 async terraformStack(id){const stack=(await this.terraformStacks()).find(s=>s.id===id);if(!stack)throw new Error('Unknown Terraform stack');return stack;}
 async terraformResources(id){return this.terraform.resources(await this.terraformStack(id));}
 async terraformVariables(id){return this.terraform.variables(await this.terraformStack(id));}
 async terraformSetVariables(id,values){const stack=await this.terraformStack(id);for(const [name,value] of Object.entries(values))await this.terraform.setVariable(stack,name,value);return this.terraform.variables(stack);}
 terraformGlobals(){return this.terraform.globals();}
 async terraformSetGlobals(values){for(const [key,value] of Object.entries(values))await this.terraform.setGlobal(key,value);return this.terraform.globals();}
 async terraformRun(id,command){return this.terraform.run(await this.terraformStack(id),command);}
 async terraformGetRun(id,runId){return this.terraform.getRun(await this.terraformStack(id),runId);}
 async terraformHistory(id){return this.terraform.history(await this.terraformStack(id));}

 // -- Contracts ------------------------------------------------------------------

 /** contracts.json configs of known projects plus the ones added by hand, with their last run. */
 async contractConfigs(){
  const configs=await findConfigs((await this.projects()).filter(p=>p.kind!=='missing'),await this.contracts.extra());
  return Promise.all(configs.map(async c=>({...c,lastRun:(await this.contracts.history(c))[0]??null})));
 }
 async contractConfig(id){const config=(await this.contractConfigs()).find(c=>c.id===id);if(!config)throw new Error('Unknown contracts config');return config;}
 async contractDescribe(id){return describeContracts((await this.contractConfig(id)).path);}
 async contractRun(id,options){return this.contracts.run(await this.contractConfig(id),options);}
 async contractGetRun(id,runId){return this.contracts.getRun(await this.contractConfig(id),runId);}
 async contractHistory(id){return this.contracts.history(await this.contractConfig(id));}
 async contractAdd(path){await this.contracts.addConfig(path);return this.contractConfigs();}
 async contractRemove(id){await this.contracts.removeConfig((await this.contractConfig(id)).path);return this.contractConfigs();}

 /** Re-read the open project's settings and apply them now (new services, ports…); the snapshot. */
 reloadProject(){if(!this.root)throw new Error('Select a project first');return this.exclusive(async()=>{await this.ensureProject(this.root);}).then(()=>this.snapshot());}

 async discover(){if(await this.isGeneric(this.root)){const saved=await this.genericConfig(this.root);const known=new Set(saved.services.map(s=>s.id));return (await genericServices(this.root)).filter(s=>!known.has(s.id));}const settings=await read(join(this.root,'rt-app.settings.json'));const existing=new Set((settings.services?.extra??[]).map(s=>s.id));return (await discover(this.root)).filter(s=>!existing.has(s.id));}
 addDiscovered(id){return this.exclusive(async()=>{
  const candidate=(await this.discover()).find(s=>s.id===id);if(!candidate)throw new Error('Candidate not found; scan again');
  if(await this.isGeneric(this.root)){const saved=await this.genericConfig(this.root);saved.services.push(candidate);await save(this.genericPath(this.root),saved);await apply(this.root,genericManifest(saved.services));return this.snapshot();}
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
