import {readFile,writeFile,mkdir,chmod} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,resolve,relative,isAbsolute,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn as spawnProcess} from 'node:child_process';

/**
 * A project's setup wizard: `deploy.wizard.json` at its root says, step by step, which values it
 * needs (a domain, a profile, API keys), where each one is found (the platform's link and the
 * steps to get it) and which commands to run once they are there (`pnpm env:up dev`). The values
 * go to the project's own env files (`.deploy/config.env`, `.deploy/secrets.env`, 0600, the other
 * lines kept); a secret is never sent back, only whether it is there.
 */
export const WIZARD_FILE='deploy.wizard.json';
const KEY=/^[A-Za-z_][A-Za-z0-9_]*$/;
const FILES=['config','secrets'];

const text=(v,what)=>{if(typeof v!=='string'||!v.trim())throw new Error(`${WIZARD_FILE}: ${what} is required`);return v;};
const list=(v,what)=>{if(v===undefined)return [];if(!Array.isArray(v))throw new Error(`${WIZARD_FILE}: ${what} must be a list`);return v;};
const https=(v,what)=>{const url=new URL(text(v,what));if(url.protocol!=='https:')throw new Error(`${WIZARD_FILE}: ${what} must be https`);return url.href;};

/** The manifest, checked; null when the project has none. */
export async function readWizard(root){
 let raw;
 try{raw=await readFile(join(root,WIZARD_FILE),'utf8');}catch(error){if(error.code==='ENOENT')return null;throw error;}
 const m=JSON.parse(raw);
 const files={config:'.deploy/config.env',secrets:'.deploy/secrets.env',...(m.files??{})};
 for(const name of FILES){const path=resolve(root,files[name]);const rel=relative(root,path);if(rel.startsWith('..')||isAbsolute(rel))throw new Error(`${WIZARD_FILE}: files.${name} must stay inside the project`);}
 const keys=new Set();
 const steps=list(m.steps,'steps').map((s,i)=>{
  const id=text(s.id,`steps[${i}].id`);
  const fields=list(s.fields,`${id}.fields`).map(f=>{
   if(!KEY.test(f.key??''))throw new Error(`${WIZARD_FILE}: ${id}: invalid key ${f.key}`);
   if(keys.has(f.key))throw new Error(`${WIZARD_FILE}: ${f.key} is asked twice`);keys.add(f.key);
   const file=f.file??(f.secret?'secrets':'config');
   if(!FILES.includes(file))throw new Error(`${WIZARD_FILE}: ${f.key}: file must be config or secrets`);
   if(f.pattern!==undefined)new RegExp(f.pattern);
   return {key:f.key,file,label:text(f.label??f.key,`${f.key}.label`),secret:f.secret===true||file==='secrets',optional:f.optional===true,
    ...(f.help&&{help:String(f.help)}),...(f.placeholder&&{placeholder:String(f.placeholder)}),...(f.pattern&&{pattern:f.pattern}),...(f.options==='aws-profiles'&&{options:'aws-profiles'})};
  });
  const oneOf=list(s.oneOf,`${id}.oneOf`);
  for(const k of oneOf)if(!fields.some(f=>f.key===k))throw new Error(`${WIZARD_FILE}: ${id}.oneOf names ${k}, not a field of the step`);
  const actions=list(s.actions,`${id}.actions`).map(a=>{
   const command=list(a.command,`${id}.${a.id}.command`);
   if(!command.length||command.some(c=>typeof c!=='string'))throw new Error(`${WIZARD_FILE}: ${id}.${a.id}: command is a list of words`);
   return {id:text(a.id,`${id}.actions[].id`),label:text(a.label,`${a.id}.label`),command,...(a.confirm&&{confirm:String(a.confirm)}),...(a.help&&{help:String(a.help)})};
  });
  return {id,title:text(s.title,`${id}.title`),...(s.summary&&{summary:String(s.summary)}),
   ...(s.platform&&{platform:{name:text(s.platform.name,`${id}.platform.name`),url:https(s.platform.url,`${id}.platform.url`)}}),
   how:list(s.how,`${id}.how`).map(String),links:list(s.links,`${id}.links`).map(l=>({label:text(l.label,'link label'),url:https(l.url,'link url')})),
   fields,oneOf,actions};
 });
 if(!steps.length)throw new Error(`${WIZARD_FILE}: no steps`);
 return {title:String(m.title??'Deploy setup'),files,steps};
}

/** KEY=value lines, the way the project's scripts read them (quotes kept off, `#` comments). */
export function parseEnv(textIn){
 const out={};
 for(const raw of String(textIn).split(/\r?\n/)){
  const line=raw.trim();if(!line||line.startsWith('#'))continue;
  const m=/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);if(!m)continue;
  let v=m[2];v=/^(['"]).*\1$/.test(v)?v.slice(1,-1):v.replace(/\s+#.*$/,'');out[m[1]]=v;
 }
 return out;
}

/** The file with `key` set (or removed when empty): its other lines and comments untouched. */
export function setEnvLine(textIn,key,value){
 if(/[\r\n]/.test(value))throw new Error(`${key}: one line only`);
 const quoted=/[\s#'"]/.test(value)?`"${value.replace(/"/g,'')}"`:value;
 const lines=String(textIn).split(/\r?\n/);if(lines.at(-1)==='')lines.pop();
 const at=lines.findIndex(l=>new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`).test(l));
 if(!value){if(at>=0)lines.splice(at,1);}
 else if(at>=0)lines[at]=`${key}=${quoted}`;
 else lines.push(`${key}=${quoted}`);
 return lines.length?lines.join('\n')+'\n':'';
}

const readText=async path=>{try{return await readFile(path,'utf8');}catch(error){if(error.code==='ENOENT')return '';throw error;}};

/** The AWS CLI profiles of this machine (names only), for a field that picks one. */
export async function awsProfiles(home=homedir()){
 const names=new Set();
 for(const [file,re] of [[join(home,'.aws','config'),/^\s*\[\s*(?:profile\s+)?([^\]\s]+)\s*\]/],[join(home,'.aws','credentials'),/^\s*\[\s*([^\]\s]+)\s*\]/]])
  for(const line of (await readText(file)).split(/\r?\n/)){const m=re.exec(line);if(m)names.add(m[1]);}
 return [...names].sort();
}

export class WizardRunner {
 constructor({spawn=spawnProcess,home=homedir(),now=()=>new Date()}={}){this.spawn=spawn;this.home=home;this.now=now;this.jobs=new Map();}

 async values(root,w){
  const out={};
  for(const name of FILES)out[name]=parseEnv(await readText(resolve(root,w.files[name])));
  return out;
 }

 /** The steps with what each field has (a secret: only whether it is there) and whether it is done. */
 async state(root){
  const w=await readWizard(root);if(!w)return {wizard:null};
  const values=await this.values(root,w);
  const profiles=w.steps.some(s=>s.fields.some(f=>f.options==='aws-profiles'))?await awsProfiles(this.home):[];
  const steps=w.steps.map(s=>{
   const fields=s.fields.map(f=>{const v=values[f.file][f.key]??'';return {...f,present:v!=='',...(!f.secret&&{value:v}),...(f.options==='aws-profiles'&&{choices:profiles})};});
   const required=fields.filter(f=>!f.optional&&!s.oneOf.includes(f.key));
   // A step of commands alone has nothing to check here: null, neither done nor pending.
   const done=!fields.length?null:required.every(f=>f.present)&&(!s.oneOf.length||fields.some(f=>s.oneOf.includes(f.key)&&f.present));
   return {...s,fields,done};
  });
  return {wizard:{title:w.title,files:w.files,steps}};
 }

 /** Save values of the manifest's fields (unknown keys refused); empty removes one. Files 0600. */
 async save(root,input){
  const w=await readWizard(root);if(!w)throw new Error(`This project has no ${WIZARD_FILE}`);
  const fields=new Map(w.steps.flatMap(s=>s.fields).map(f=>[f.key,f]));
  const byFile={config:{},secrets:{}};
  for(const [key,raw] of Object.entries(input)){
   const f=fields.get(key);if(!f)throw new Error(`${key} is not asked by ${WIZARD_FILE}`);
   if(typeof raw!=='string')throw new Error(`${key}: a text value`);
   const value=raw.trim();
   if(value&&f.pattern&&!new RegExp(f.pattern).test(value))throw new Error(`${f.label}: does not look right`);
   byFile[f.file][key]=value;
  }
  for(const name of FILES){
   const entries=Object.entries(byFile[name]);if(!entries.length)continue;
   const path=resolve(root,w.files[name]);
   await mkdir(dirname(path),{recursive:true,mode:0o700});
   let content=await readText(path);
   for(const [key,value] of entries)content=setEnvLine(content,key,value);
   await writeFile(path,content,{mode:0o600});await chmod(path,0o600);
  }
  return this.state(root);
 }

 /** Run a step's action in the project: its output kept (secrets redacted); one at a time. */
 async run(root,stepId,actionId){
  const w=await readWizard(root);if(!w)throw new Error(`This project has no ${WIZARD_FILE}`);
  const action=w.steps.find(s=>s.id===stepId)?.actions.find(a=>a.id===actionId);
  if(!action)throw new Error('Unknown action');
  if([...this.jobs.values()].some(j=>j.root===root&&j.state==='running'))throw new Error('Another command of this project is running');
  const values=await this.values(root,w);
  // ${KEY} in the command: the project's config values (never a secret: those stay in the files).
  const words=action.command.map(word=>word.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,(_,k)=>values.config[k]??''));
  const secrets=Object.values(values.secrets).filter(v=>v&&v.length>=6);
  const redact=t=>secrets.reduce((out,s)=>out.split(s).join('[redacted]'),t);
  const id=randomUUID();
  const job={id,root,step:stepId,action:actionId,label:action.label,command:words.join(' '),state:'running',startedAt:this.now().toISOString(),output:''};
  this.jobs.set(id,job);
  const child=this.spawn(words[0],words.slice(1),{cwd:root,env:process.env,stdio:['ignore','pipe','pipe']});
  const append=chunk=>{job.output=(job.output+redact(String(chunk))).slice(-1_000_000);};
  child.stdout?.on('data',append);child.stderr?.on('data',append);
  const finish=code=>{if(job.state!=='running')return;job.state=code===0?'succeeded':'failed';job.exitCode=code;job.finishedAt=this.now().toISOString();};
  child.once('error',error=>{append(`\n${error.code==='ENOENT'?`${words[0]} was not found`:error.message}\n`);finish(127);});
  child.once('close',code=>finish(code??1));
  return {id};
 }

 getRun(id){const j=this.jobs.get(id);if(!j)throw new Error('Unknown run');const {root,...rest}=j;return rest;}
}
