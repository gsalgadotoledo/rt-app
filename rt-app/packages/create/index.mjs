import YAML from 'yaml';
import * as generator from './crud.mjs';
import {projectReadme,claudeGuide} from './project-docs.mjs';
import {backends,backend,generateBackend} from './backends.mjs';
export {backends,backend};
import {readFile,writeFile,mkdir,readdir,lstat,cp,rm,realpath,rename,access} from 'node:fs/promises';
import {join,resolve,relative,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
export const packageRoot=dirname(fileURLToPath(import.meta.url));
/**
 * Templates are prompts: templates/<id>.md with YAML front matter for the deterministic part
 * (kind, requirements, CRUD modules) and a Markdown body that tells an LLM what to build on top of
 * the tested starter. No template stores a copy of application code, so none can go stale.
 */
export function parseTemplate(id,text){
 const match=text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
 if(!match)throw new Error(`Template ${id}: missing front matter`);
 const meta=YAML.parse(match[1])??{};
 if(meta.id!==id)throw new Error(`Template ${id}: id must match the file name`);
 if(typeof meta.name!=='string'||!meta.name||typeof meta.description!=='string'||!meta.description)throw new Error(`Template ${id}: name and description are required`);
 if(!['fullstack','electron','mobile'].includes(meta.kind??'fullstack'))throw new Error(`Template ${id}: unknown kind`);
 const requirements=meta.requirements??['node'];
 if(!Array.isArray(requirements)||requirements.some(r=>typeof r!=='string'))throw new Error(`Template ${id}: requirements must be a list`);
 // fields: { name: string, notes: string? } → generator fields; "?" marks an optional field.
 const crud=(meta.crud??[]).map(entry=>({name:entry.name,title:entry.title??entry.name,fields:Object.entries(entry.fields??{}).map(([name,type])=>({name,type:String(type).replace(/\?$/,''),required:!String(type).endsWith('?')})),...(entry.actions?{actions:entry.actions}:{})}));
 return {id,name:meta.name,description:meta.description,kind:meta.kind??'fullstack',requirements,...(crud.length?{crud}:{}),prompt:match[2].trim()+'\n'};
}
export async function templates(){
 const directory=join(packageRoot,'templates');
 const files=(await readdir(directory)).filter(f=>f.endsWith('.md')).sort();
 const list=await Promise.all(files.map(async f=>parseTemplate(f.slice(0,-3),await readFile(join(directory,f),'utf8'))));
 // The base template first; the rest alphabetically.
 return list.sort((a,b)=>(a.id==='fullstack'?-1:b.id==='fullstack'?1:a.name.localeCompare(b.name)));
}
export async function template(id){const result=(await templates()).find(t=>t.id===id);if(!result)throw new Error('Unknown project template');return result;}
export function projectName(name){if(typeof name!=='string'||name.length>48||! /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)||/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(name))throw new Error('Use a lowercase project name with letters, numbers and hyphens (max 48).');return name;}
const ignored=new Set(['node_modules','.git','.rt-app','.next','.next-dev','.terraform','dist','build','bundle','target','release','starter','.venv','__pycache__','.DS_Store']);
export async function copyStarter(source,destination, selectedRoots){
 const roots=selectedRoots??['apps','packages','infra','.github','.gitignore','gitignore','.gitlab-ci.yml','package.json','main.js','main.d.ts','modules.json','rt-app.settings.json','README.md','CLAUDE.md','AGENTS.md'];
 async function copy(from,to){const st=await lstat(from);if(st.isSymbolicLink())throw new Error('Template contains a symbolic link: '+relative(source,from));if(st.isDirectory()){await mkdir(to,{recursive:true});for(const entry of await readdir(from)){if(ignored.has(entry)||entry.startsWith('.env')||/\.(tfstate|tfplan|plan|tgz|zip|sqlite|db|log|tsbuildinfo)(\.|$)/.test(entry))continue;if(entry.endsWith('.egg-info')||entry.endsWith('.pyc'))continue;await copy(join(from,entry),join(to,entry));}}else if(st.isFile()){await cp(from,to,{errorOnExist:true,force:false});}}
 for(const name of roots){try{await access(join(source,name));}catch(e){if(e.code==='ENOENT')continue;throw e;}await copy(join(source,name),join(destination,name));}
}
export async function starterRoot(){const bundled=join(packageRoot,'starter');await access(join(bundled,'package.json'));return bundled;}
export function run(command,args,{cwd,env=process.env,onLog=()=>{}}={}){return new Promise((yes,no)=>{const child=spawn(command,args,{cwd,env,stdio:['ignore','pipe','pipe']});let tail='';for(const stream of [child.stdout,child.stderr])stream.on('data',data=>{tail=(tail+data).slice(-4000);onLog(String(data));});child.once('error',no);child.once('exit',code=>code===0?yes():no(new Error(`${command} failed (${code})\n${tail}`)));});}
const generatorVersion=JSON.parse(await readFile(join(packageRoot,'package.json'),'utf8')).version;
export async function createProject({workspace,name,templateId='fullstack',backendId='node-ts',install=true,source,env=process.env,onLog=()=>{}}){
 projectName(name);const selectedBackend=backend(backendId);const spec=await template(templateId);workspace=await realpath(workspace);if(!(await lstat(workspace)).isDirectory())throw new Error('Workspace must be a directory');const target=join(workspace,name);
 // Reserve the final directory exclusively. Never merge with or remove an existing project.
 await mkdir(target);let complete=false;
 try{
  onLog('Copying '+spec.name+' template…');
  if(spec.source){
   if(!/^(gh|github|gitlab):[a-zA-Z0-9_.\/-]+#[a-f0-9]{40}$/.test(spec.source))throw new Error('Remote templates must use a GitHub/GitLab reference pinned to a full commit');
   const {downloadTemplate}=await import('giget');const cache=join(workspace,'.rt-template-'+randomUUID());
   try{await downloadTemplate(spec.source,{dir:cache,install:false});await copyStarter(cache,target);}finally{await rm(cache,{recursive:true,force:true});}
  }else await copyStarter(source??await starterRoot(),target);
  // Published starters carry "gitignore" (npm strips .gitignore); every project gets a real one.
  try{await rename(join(target,'gitignore'),join(target,'.gitignore'));}catch(e){if(e.code!=='ENOENT')throw e;}
  await access(join(target,'.gitignore'));
  const read=async p=>JSON.parse(await readFile(join(target,p),'utf8'));const save=async(p,value)=>writeFile(join(target,p),JSON.stringify(value,null,2)+'\n');
  const pkg=await read('package.json');pkg.name=name;delete pkg.version;await save('package.json',pkg);
  for(const app of ['spa','ssr'])await save('apps/'+app+'/branding.json',{name});
  const settings=await read('rt-app.settings.json');delete settings.local;settings.project={name,template:spec.id};settings.backend=backendId;settings.requirements=Object.fromEntries([...new Set([...spec.requirements,...selectedBackend.tools])].map(id=>[id,{node:'24',go:'1.26',python:'3.14',java:'temurin-21'}[id]]));settings.services={defaults:true,extra:[]};await save('rt-app.settings.json',settings);
  // Existing user-generated modules and local state never become the defaults of another project.
  await rm(join(target,'packages'),{recursive:true,force:true});await mkdir(join(target,'packages'));for(const [p,body] of Object.entries(generator.registries([])))await writeFile(join(target,p),body);
  const modules=await read('modules.json');modules.modules=modules.modules.filter(m=>!(modules.generatedCrud??[]).some(c=>c.name===m));modules.generatedCrud=[];await save('modules.json',modules);
  for(const crud of spec.crud??[])await generator.generate(target,crud);
  if(spec.kind==='electron'){
   const dir=join(target,'apps/desktop');await mkdir(dir,{recursive:true});
   await save('apps/desktop/package.json',{name:'@app/desktop',private:true,type:'module',scripts:{dev:'electron .'},main:'main.mjs',dependencies:{electron:'44.4.4','@gsalgadotoledo/rt-app-config':generatorVersion}});
   await writeFile(join(dir,'main.mjs'),`import {app,BrowserWindow} from 'electron';\nimport {publicConfig} from '@gsalgadotoledo/rt-app-config';\nawait app.whenReady();\nconst window=new BrowserWindow({width:1100,height:760,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});\nwindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));\nawait window.loadURL(publicConfig().urls.spa);\napp.on('window-all-closed',()=>app.quit());\n`);
   settings.services.extra.push({id:'desktop',label:'Electron app',command:['npm','run','dev','-w','@app/desktop'],cwd:'.',ports:[],dependencies:['spa']});
  }
  if(spec.kind==='mobile'){
   const dir=join(target,'apps/mobile');await mkdir(dir,{recursive:true});
   await save('apps/mobile/package.json',{name:'@app/mobile',private:true,main:'index.js',scripts:{dev:'expo start --localhost'},dependencies:{expo:'~54.0.0',react:'19.1.0','react-native':'0.81.5'}});
   await writeFile(join(dir,'index.js'),"import {registerRootComponent} from 'expo';\nimport App from './App';\nregisterRootComponent(App);\n");
   await save('apps/mobile/app.json',{expo:{name,slug:name,version:'1.0.0',platforms:['ios','android']}});
   await writeFile(join(dir,'App.js'),`import React,{useState} from 'react';\nimport {SafeAreaView,Text,TextInput,Button,StyleSheet} from 'react-native';\nexport default function App(){const [url,setUrl]=useState('http://localhost:4010');const [message,setMessage]=useState('Set your API URL; a physical phone needs your computer’s reachable address.');return <SafeAreaView style={styles.screen}><Text style={styles.title}>RT-App Mobile</Text><TextInput accessibilityLabel="API URL" style={styles.input} value={url} onChangeText={setUrl} autoCapitalize="none"/><Button title="Load home" onPress={async()=>{try{const response=await fetch(url);if(!response.ok)throw new Error('API unavailable');const home=await response.json();setMessage(home.title);}catch(e){setMessage(e.message);}}}/><Text style={styles.text}>{message}</Text></SafeAreaView>}\nconst styles=StyleSheet.create({screen:{flex:1,backgroundColor:'#14181c',padding:32,justifyContent:'center'},title:{color:'#b5d7c6',fontSize:32},text:{color:'#eee',marginTop:20},input:{color:'#eee',borderColor:'#566',borderWidth:1,padding:12,marginVertical:20}});\n`);
   settings.services.extra.push({id:'mobile',label:'Expo · mobile',command:['npm','run','dev','-w','@app/mobile','--','--port','${EXPO_PORT}'],cwd:'.',ports:[8081],portEnv:['EXPO_PORT'],dependencies:['api']});
  }
  await generateBackend(target,backendId,packageRoot);
  if(backendId!=='node-ts'){
   pkg.rtApp.backend='@app/backend-'+backendId;
   for(const script of ['setup','setup:terminal','lambda:build'])pkg.scripts[script]='rta native-deploy-pending';
   await save('package.json',pkg);
  }
  await save('rt-app.settings.json',settings);await writeFile(join(target,'mise.toml'),'[tools]\n'+Object.entries(settings.requirements).map(([key,value])=>key+' = '+JSON.stringify(value)).join('\n')+'\n');
  await writeFile(join(target,'README.md'),projectReadme({name,templateName:spec.name,backendId}));
  await writeFile(join(target,'CLAUDE.md'),claudeGuide({backendId})+'\n- Read TEMPLATE.md first: it is the prompt of the '+spec.name+' template and describes what this project should become.\n');
  await writeFile(join(target,'TEMPLATE.md'),spec.prompt);
  await rm(join(target,'PROJECT.md'),{force:true});
  complete=true;
  if(install){onLog('Installing project dependencies…');await run('npm',['install','--no-audit','--no-fund'],{cwd:target,env,onLog});if(backendId==='python'){onLog('Installing Python core in the project virtual environment…');await run('npm',['run','setup','--workspace','@app/backend-python'],{cwd:target,env,onLog});}}
  return {path:target,name,template:spec.id,backend:backendId,installed:install};
 }catch(error){if(!complete)await rm(target,{recursive:true,force:true});else error.message+=`\nProject files are preserved at ${target}. Run npm install there to retry; Python projects also need npm run setup --workspace @app/backend-python.`;throw error;}
}
