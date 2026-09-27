import {readFile,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {listWorkspaces} from './client.mjs';

/**
 * Project insights for the Service Manager: which backend modules a project loads, how each one is
 * initialized (values resolved from the API service's real environment) and the records they keep
 * in the local store (JSON file or local Postgres). Read-only: nothing is started or written, and
 * sensitive values are redacted before they leave this module.
 */

// Modules the framework always wires (framework createApplication), besides the ones in modules.json.
const ALWAYS=['observer','subscriptions'];
const REQUIRED=['content','users','auth','acl','infra'];

// Record key prefixes owned by core modules. Application modules declare theirs in code (*_PK).
const CORE_PREFIXES={
 users:['USERS','EMAIL','PROFILE','IDENTITY'],
 auth:['CHALLENGE','RATE','SESSION','SESSIONS','REFRESH','RESET','VERIFY','TOKEN','TOKENS','MFA'],
 acl:['ACL','ROLE','ROLES','GRANT','GRANTS','PERMISSIONS'],
 subscriptions:['SUB','SUBS','SUBSCRIPTION','SUBSCRIPTIONS','PLAN','PLANS','CREDITS','BILLING','CUSTOMER','INVOICE','SUB_STATS','SUB_MAINTENANCE','SUB_ACCOUNTS','SUB_PLANS'],
 visits:['VISITS','VISIT'],
 'feature-flags':['FLAGS','FLAG','FEATURE_FLAGS'],
 content:['CONTENT','PAGE','PAGES','BLOCKS'],
 infra:['INFRA','AWS'],
 tasks:['TASKS','TASK','JOBS'],
 observer:['OBSERVER','EVENTS','LOGS'],
 system:['SCHEMA','MIGRATIONS','SEEDS'],
};

const LABELS={content:'Content',infra:'Infrastructure',users:'Users',auth:'Authentication',acl:'Access control','feature-flags':'Feature flags',visits:'Visits',health:'Health',tasks:'Tasks',subscriptions:'Subscriptions',observer:'Observer',system:'Framework bookkeeping','aws-monitor':'AWS monitor'};
const DESCRIPTIONS={
 content:'Editable pages and content blocks.',infra:'Infrastructure status and simulated/real drivers.',users:'User accounts and profiles.',auth:'Sign-in, tokens, challenges and rate limits.',acl:'Roles, grants and endpoint permissions.','feature-flags':'Flags with private rules and public evaluation.',visits:'Allowlisted page visits and bounded geometry.',health:'Readiness probes.',tasks:'Background tasks.',subscriptions:'Plans, credits and billing (local, Stripe or none).',observer:'Events, logs and their outputs.','aws-monitor':'AWS account monitor (only with infra).',
};

const SENSITIVE=/pass(word)?|hash|secret|token|salt|otp|api[_-]?key|private|signature|credential/i;

/** Replace sensitive fields (by key name) anywhere in a value. */
export function redact(value,depth=0){
 if(depth>12||value===null||typeof value!=='object')return value;
 if(Array.isArray(value))return value.map(v=>redact(v,depth+1));
 return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,SENSITIVE.test(k)&&v!==null&&v!==undefined&&typeof v!=='boolean'&&typeof v!=='number'?'••••••':redact(v,depth+1)]));
}

const shown=(key,value)=>value===undefined||value===''?undefined:SENSITIVE.test(key)?`set (${String(value).length} chars)`:String(value);
const prefixOf=pk=>String(pk).split('#')[0];

/** Environment the API service gets from the supervisor (its env plus the inherited variables). */
async function apiEnvironment(root){
 try{
  const config=JSON.parse(await readFile(join(root,'.rt-app/services.json'),'utf8'));
  const api=config.services.find(s=>s.id==='api');
  if(!api)return {env:{},found:false};
  return {env:{...Object.fromEntries((api.inheritEnv??[]).filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]])),...api.env},found:true,cwd:api.cwd};
 }catch{return {env:{},found:false};}
}

/** Directory of the backend workspace (where the API process runs and resolves relative paths). */
async function backendDirectory(root,pkg){
 const name=pkg.rtApp?.backend;
 if(!name)return join(root,'apps/server');
 try{const ws=(await listWorkspaces(root,{pkg})).find(w=>w.name===name);if(ws?.location)return resolve(root,ws.location);}catch{}
 return join(root,'apps/server');
}

/**
 * Where the local API keeps its records and how to read them.
 * @returns {{kind:'json'|'postgres'|'dynamodb-local'|'memory'|string, location:string|null, readable:boolean, reason?:string, file?:string, url?:string, from:string}}
 */
async function storage(root,settings,env,backendDir){
 const mode=env.RT_APP_MODE??settings.runtime?.local?.mode??'json';
 if(mode==='json'){const file=resolve(backendDir,env.RT_APP_JSON_FILE??'.rt-app/local.json');return {kind:'json',location:file,file,readable:true,from:env.RT_APP_JSON_FILE?'RT_APP_JSON_FILE':'default .rt-app/local.json'};}
 if(mode==='postgres'){
  const url=env.DATABASE_URL??process.env.DATABASE_URL;
  if(!url)return {kind:'postgres',location:null,readable:false,reason:'DATABASE_URL is not set for the API service.',from:'RT_APP_MODE'};
  let host;try{host=new URL(url).hostname;}catch{return {kind:'postgres',location:null,readable:false,reason:'DATABASE_URL is not a valid URL.',from:'DATABASE_URL'};}
  if(!['localhost','127.0.0.1','::1'].includes(host))return {kind:'postgres',location:host,readable:false,reason:'Only local databases are read.',from:'DATABASE_URL'};
  const safe=new URL(url);safe.password=safe.password?'••••':'';
  return {kind:'postgres',location:safe.href,url,readable:true,from:'DATABASE_URL',backendDir};
 }
 if(mode==='memory')return {kind:'memory',location:null,readable:false,reason:'In-memory data lives inside the running API process and is lost on restart.',from:'RT_APP_MODE'};
 if(mode==='dynamodb-local')return {kind:'dynamodb-local',location:env.DYNAMODB_ENDPOINT??null,readable:false,reason:'Reading DynamoDB Local is not supported yet.',from:'RT_APP_MODE'};
 return {kind:mode,location:null,readable:false,reason:'This storage mode is not read by the Service Manager.',from:'RT_APP_MODE'};
}

/** Every row of the local store (TTL-expired rows excluded, like the store itself). */
async function allRows(store){
 const now=Math.floor(Date.now()/1000);
 const live=r=>!r.ttl||r.ttl>now;
 if(store.kind==='json'){
  let data;try{data=JSON.parse(await readFile(store.file,'utf8'));}catch(e){if(e.code==='ENOENT')return [];throw new Error('Could not read the JSON store: '+e.message);}
  return (data.rows??[]).filter(live);
 }
 if(store.kind==='postgres'){
  const client=await postgres(store);
  try{
   const {rows}=await client.query('SELECT pk, sk, version, data, ttl FROM rt_app_rows WHERE ttl IS NULL OR ttl > $1 ORDER BY pk, sk',[now]);
   return rows;
  }catch(e){if(/does not exist/.test(e.message))return [];throw e;}
  finally{await client.end().catch(()=>{});}
 }
 return [];
}

/** A pg client loaded from the project's own dependencies (the Service Manager does not ship one). */
async function postgres(store){
 let pg;
 try{pg=createRequire(join(store.backendDir,'package.json'))('pg');}catch{throw new Error('The project has no "pg" package installed; install dependencies first.');}
 const client=new (pg.Client??pg.default?.Client)({connectionString:store.url,ssl:false,connectionTimeoutMillis:3000});
 await client.connect();
 return client;
}

/** Record prefixes an application module declares: string constants and templates like 'X' or `X#${…}`. */
async function declaredPrefixes(dir){
 const found=new Map();
 async function visit(folder,depth){
  let entries;try{entries=await readdir(folder,{withFileTypes:true});}catch{return;}
  for(const e of entries){
   if(e.isDirectory()&&depth<3&&!['node_modules','tests','ui','dist'].includes(e.name))await visit(join(folder,e.name),depth+1);
   else if(/\.(m?js|ts)$/.test(e.name)&&!/\.test\./.test(e.name)){
    const text=await readFile(join(folder,e.name),'utf8');
    for(const m of text.matchAll(/([A-Z][A-Z0-9_]*_PK)\s*=\s*['"`]([A-Z][A-Z0-9_]*)(?:#[^'"`]*)?['"`]/g))found.set(m[2],'const');
    for(const m of text.matchAll(/['"`]([A-Z][A-Z0-9_]{2,})#/g))if(!found.has(m[1]))found.set(m[1],'template');
    for(const m of text.matchAll(/['"`]([A-Z][A-Z0-9_]{2,})['"`]/g))if(!found.has(m[1]))found.set(m[1],'string');
   }
  }
 }
 await visit(join(dir,'src'),0);
 return found;
}

/** Environment variables a module's code reads (process.env.X, env.X, env['X']). */
async function envReads(dir){
 const names=new Set();
 async function visit(folder,depth){
  let entries;try{entries=await readdir(folder,{withFileTypes:true});}catch{return;}
  for(const e of entries){
   if(e.isDirectory()&&depth<3&&!['node_modules','tests','ui'].includes(e.name))await visit(join(folder,e.name),depth+1);
   else if(/\.(m?js|ts)$/.test(e.name)&&!/\.(test|d)\./.test(e.name)){
    const text=await readFile(join(folder,e.name),'utf8');
    for(const m of text.matchAll(/\benv(?:\??\.|\[['"])([A-Z][A-Z0-9_]{2,})/g))names.add(m[1]);
   }
  }
 }
 await visit(join(dir,'src'),0);
 if(!names.size)await visit(join(dir,'dist'),0);
 return [...names].sort();
}

const entry=(key,value,source,note)=>({key,value:value===undefined?null:value,source,...(note?{note}:{})});

/** How the framework wires each core module (mirrors createApplication in @gsalgadotoledo/rt-app-framework). */
function coreInitialization(id,ctx){
 const {env,store,mailer,secret,environment}=ctx;
 const storeEntry=entry('store',`${store.kind}${store.location?` · ${store.location}`:''}`,store.from);
 const billing=env.SUBSCRIPTIONS_PROVIDER??'local';
 switch(id){
  case 'users':return [storeEntry,entry('identityProvider',env.COGNITO_USER_POOL_ID?'Cognito':'local accounts in the store','createApplication default')];
  case 'auth':return [entry('users','Users module','createApplication'),entry('tokens','JWT signed with the application secret','createApplication'),entry('secret',secret,'local development secret'),entry('mailer',mailer,'RT_APP_MAIL_TRANSPORT')];
  case 'acl':return [storeEntry,entry('endpoints','every registered endpoint (resolved at startup)','createApplication')];
  case 'content':return [storeEntry];
  case 'infra':return [storeEntry,entry('driver','SimulatedInfraDriver','local default: no real cloud calls'),entry('managedByTerraform','false','createApplication default')];
  case 'feature-flags':return [storeEntry];
  case 'visits':return [storeEntry,entry('secret',secret,'application secret (visit tokens)'),entry('pages','default public pages','createApplication default')];
  case 'health':return [entry('probes','database: store.get("SCHEMA", "users")','createApplication default')];
  case 'tasks':return [storeEntry,entry('enabled',String(env.ENABLE_TASKS!=='false'),env.ENABLE_TASKS!==undefined?'ENABLE_TASKS':'default')];
  case 'subscriptions':return [storeEntry,entry('provider',billing,env.SUBSCRIPTIONS_PROVIDER?'SUBSCRIPTIONS_PROVIDER':'local development default'),...(billing==='stripe'?[entry('STRIPE_SECRET_KEY',shown('STRIPE_SECRET_KEY',env.STRIPE_SECRET_KEY)??'missing','environment'),entry('STRIPE_WEBHOOK_SECRET',shown('STRIPE_WEBHOOK_SECRET',env.STRIPE_WEBHOOK_SECRET)??'missing','environment')]:[]),entry('mailer',mailer,'RT_APP_MAIL_TRANSPORT')];
  case 'observer':return [entry('storage',store.kind==='json'?resolve(store.file,'..','observer.json'):storeEntry.value,store.kind==='json'?'next to the JSON store':'same store'),entry('console','info, warn, error','createApplication default'),...['OBSERVER_EMAIL_TRANSPORT','OBSERVER_EMAIL_TO','OBSERVER_SMS_TO','OBSERVER_LOG_GROUP'].filter(k=>env[k]).map(k=>entry(k,shown(k,env[k]),'environment'))];
  case 'aws-monitor':return [storeEntry,entry('awsConnected','false','createApplication default')];
  default:return [];
 }
}

/**
 * Overview of a project's backend: storage, modules with their initialization and record counts.
 * @param root project folder (rt-app.settings.json + package.json)
 * @returns {Promise<{project, storage, modules, collections, totals, environment, readAt, warnings}>}
 * @example await projectInsights('/work/my-store') // → {modules:[{id:'orders', records:12, …}], …}
 */
export async function projectInsights(root){
 const warnings=[];
 const settings=JSON.parse(await readFile(join(root,'rt-app.settings.json'),'utf8'));
 const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
 let configuration={modules:[],generatedCrud:[]};
 try{configuration=JSON.parse(await readFile(join(root,'modules.json'),'utf8'));}catch{warnings.push('modules.json was not found: the framework loads every registered module.');}
 const {env:apiEnv,found}=await apiEnvironment(root);
 if(!found)warnings.push('The API service has not been configured by the supervisor yet; values come from project defaults.');
 const env={RT_APP_MODE:settings.runtime?.local?.mode,...apiEnv};
 const backendDir=await backendDirectory(root,pkg);
 const store=await storage(root,settings,env,backendDir);
 const environment=env.RT_APP_ENVIRONMENT??'local';
 const mailer=(env.RT_APP_MAIL_TRANSPORT??'memory')==='smtp'?`SMTP · localhost:${env.RT_APP_MAIL_SMTP_PORT??1025}`:'in-memory mailbox';
 const secret=store.kind==='json'?`stored in ${store.file}.key`:store.kind==='postgres'?'stored in .rt-app/postgres.key':'random per process';
 const ctx={env,store,mailer,secret,environment};

 const crud=new Set((configuration.generatedCrud??[]).map(c=>c.name));
 const enabled=[...new Set([...(configuration.modules??[]),...ALWAYS,...((configuration.modules??[]).includes('infra')?['aws-monitor']:[])])];
 const modules=[];
 for(const id of enabled){
  const appDir=join(root,'packages',id);
  let appPkg=null;try{appPkg=JSON.parse(await readFile(join(appDir,'package.json'),'utf8'));}catch{}
  const kind=appPkg?(crud.has(id)?'crud':'app'):ALWAYS.includes(id)||id==='aws-monitor'?'always':'core';
  const corePkgDir=join(root,'node_modules','@gsalgadotoledo',`rt-app-${id}`);
  const reads=appPkg?await envReads(appDir):await envReads(corePkgDir);
  const init=appPkg
   ?[entry('store',`${store.kind}${store.location?` · ${store.location}`:''}`,'factory(store, context)'),entry('environment',environment,env.RT_APP_ENVIRONMENT?'RT_APP_ENVIRONMENT':'default'),...Object.keys(appPkg.dependencies??{}).filter(d=>d.startsWith('@app/')).map(d=>entry('uses',d,'package dependency'))]
   :coreInitialization(id,ctx);
  const known=new Set(init.map(i=>i.key));
  for(const name of reads)if(!known.has(name))init.push(entry(name,shown(name,env[name])??null,env[name]!==undefined?'API environment':'not set'));
  modules.push({id,label:LABELS[id]??(appPkg?.description||id[0].toUpperCase()+id.slice(1)),description:DESCRIPTIONS[id]??appPkg?.description??'',kind,package:appPkg?.name??(kind==='core'||kind==='always'?`@gsalgadotoledo/rt-app-${id}`:null),required:REQUIRED.includes(id),init,declared:appPkg?await declaredPrefixes(appDir):new Map((CORE_PREFIXES[id]??[]).map(p=>[p,'core'])),migrations:[],seeds:[],records:0,collections:0});
 }

 let rows=[];let readError=null;
 if(store.readable){try{rows=await allRows(store);}catch(e){readError=e.message;warnings.push(e.message);}}
 // Group rows by collection prefix and give each to the module that owns it.
 const byModule=new Map(modules.map(m=>[m.id,m]));
 const owner=prefix=>{
  if(prefix==='CRUD')return null;
  for(const kind of ['const','template','string'])for(const m of modules)if(m.declared.get(prefix)===kind)return m.id;
  for(const [id,list] of Object.entries(CORE_PREFIXES))if(list.includes(prefix)||list.some(p=>prefix.startsWith(p+'_')))return id;
  for(const m of modules)if(prefix.startsWith(m.id.toUpperCase().replace(/-/g,'_')))return m.id;
  return 'other';
 };
 const collections=new Map();
 for(const row of rows){
  const prefix=prefixOf(row.pk);
  const key=prefix==='CRUD'?row.pk:prefix;
  const module=prefix==='CRUD'?String(row.pk).slice(5):owner(prefix);
  const c=collections.get(key)??{id:key,module,count:0,partitions:new Set(),updatedAt:null};
  c.count++;c.partitions.add(row.pk);
  const at=row.data?.updatedAt??row.data?.appliedAt??row.data?.createdAt;if(at&&(!c.updatedAt||at>c.updatedAt))c.updatedAt=at;
  collections.set(key,c);
  if(row.pk==='MIGRATIONS'||row.pk==='SEEDS'){
   const [moduleId,step]=String(row.sk).split(':');
   byModule.get(moduleId)?.[row.pk==='MIGRATIONS'?'migrations':'seeds'].push({id:step??row.sk,appliedAt:row.data?.appliedAt??null,...(row.data?.environment?{environment:row.data.environment}:{})});
  }
 }
 const list=[...collections.values()].map(c=>({...c,partitions:c.partitions.size})).sort((a,b)=>b.count-a.count);
 for(const c of list){const m=byModule.get(c.module);if(m){m.records+=c.count;m.collections++;}}
 const system=list.filter(c=>c.module==='system').reduce((n,c)=>n+c.count,0);
 const other=list.filter(c=>c.module==='other'||!byModule.has(c.module)&&c.module!=='system').reduce((n,c)=>n+c.count,0);
 return {
  project:{name:pkg.name??settings.project?.name,template:settings.project?.template??null,backend:settings.backend??'node-ts',target:env.RT_APP_TARGET??'local',mode:store.kind},
  storage:{kind:store.kind,location:store.location,readable:store.readable&&!readError,reason:readError??store.reason,from:store.from},
  environment,
  modules:modules.map(({declared,...m})=>({...m,prefixes:[...declared].filter(([,k])=>k!=='string').map(([p])=>p)})),
  collections:list,
  totals:{records:rows.length,collections:list.length,modules:modules.length,migrations:modules.reduce((n,m)=>n+m.migrations.length,0),seeds:modules.reduce((n,m)=>n+m.seeds.length,0),system,other},
  warnings,
  readAt:new Date().toISOString(),
 };
}

/**
 * Records of one collection (a key prefix such as ORDERS, or a full pk such as CRUD#catalog),
 * newest first when rows carry timestamps. Sensitive fields are redacted.
 * @param options.collection collection id from projectInsights().collections
 * @param options.offset,limit paging (limit ≤ 200)
 * @param options.search case-insensitive text match on sk and data
 */
export async function projectRecords(root,{collection,offset=0,limit=50,search=''}={}){
 if(typeof collection!=='string'||!collection)throw new Error('Choose a collection');
 limit=Math.max(1,Math.min(200,Number(limit)||50));offset=Math.max(0,Number(offset)||0);
 const settings=JSON.parse(await readFile(join(root,'rt-app.settings.json'),'utf8'));
 const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
 const {env:apiEnv}=await apiEnvironment(root);
 const env={RT_APP_MODE:settings.runtime?.local?.mode,...apiEnv};
 const store=await storage(root,settings,env,await backendDirectory(root,pkg));
 if(!store.readable)throw new Error(store.reason??'This storage is not readable');
 const matches=r=>collection.includes('#')?r.pk===collection:r.pk===collection||String(r.pk).startsWith(collection+'#');
 let rows=(await allRows(store)).filter(matches);
 if(search){const q=search.toLowerCase();rows=rows.filter(r=>`${r.pk} ${r.sk} ${JSON.stringify(r.data)}`.toLowerCase().includes(q));}
 const stamp=r=>r.data?.updatedAt??r.data?.createdAt??r.data?.appliedAt??'';
 rows.sort((a,b)=>String(stamp(b)).localeCompare(String(stamp(a)))||String(a.sk).localeCompare(String(b.sk)));
 return {collection,total:rows.length,offset,limit,rows:rows.slice(offset,offset+limit).map(r=>({pk:r.pk,sk:r.sk,version:r.version??null,ttl:r.ttl??null,data:redact(r.data)}))};
}
