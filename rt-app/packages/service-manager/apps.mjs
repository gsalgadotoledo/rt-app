import {readFile,readdir,stat} from 'node:fs/promises';
import {join,resolve,relative,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {listWorkspaces,packageManager,scriptCommand} from './client.mjs';

/**
 * Launchable apps inside a project (Electron, Tauri, React Native, Expo, Capacitor) and the web page
 * of its git remote. Detection only reads package.json files and folders; nothing is executed here.
 */

const hash=value=>createHash('sha256').update(value).digest('hex').slice(0,12);

/** Kind of app a package is, from its dependencies (and a src-tauri folder for Tauri). */
async function appKind(dir,pkg){
 const deps={...pkg.dependencies,...pkg.devDependencies};
 if(deps.electron||deps['electron-vite']||deps['electron-forge']||deps['@electron-forge/cli'])return 'electron';
 if(deps['@tauri-apps/cli']||deps['@tauri-apps/api'])return 'tauri';
 try{if((await stat(join(dir,'src-tauri'))).isDirectory())return 'tauri';}catch{}
 if(deps.expo)return 'expo';
 if(deps['react-native'])return 'react-native';
 if(deps['@capacitor/core']||deps['@capacitor/cli'])return 'capacitor';
 return null;
}

const KIND_LABEL={electron:'Electron',tauri:'Tauri','react-native':'React Native',expo:'Expo',capacitor:'Capacitor'};

/** Scripts worth a button, in order: how to run it in development and on devices. */
function launchScripts(kind,scripts={}){
 const pick=(...names)=>names.find(n=>scripts[n]);
 const out=[];
 const dev=pick('dev','start','electron:dev','tauri:dev','serve');
 if(dev)out.push({action:'dev',script:dev,label:kind==='expo'||kind==='react-native'?'Start Metro / dev server':'Run in development'});
 for(const [action,names,label] of [['ios',['ios','run:ios','expo:ios'],'Run on iOS'],['android',['android','run:android','expo:android'],'Run on Android'],['preview',['preview'],'Preview production build']])
  {const s=pick(...names);if(s&&s!==dev)out.push({action,script:s,label});}
 return out;
}

/** Packaged macOS apps (.app) produced by electron-builder, Forge, Tauri… under the usual output folders. */
async function builtApps(dir){
 const found=[];
 async function visit(folder,depth){
  if(depth>4||found.length>=6)return;
  let entries;try{entries=await readdir(folder,{withFileTypes:true});}catch{return;}
  for(const e of entries){
   if(!e.isDirectory()||e.name==='node_modules'||e.name.startsWith('.'))continue;
   const path=join(folder,e.name);
   if(e.name.endsWith('.app')){const info=await stat(path);found.push({path,name:basename(e.name,'.app'),builtAt:info.mtime.toISOString()});}
   else await visit(path,depth+1);
  }
 }
 for(const out of ['dist','release','out','build','src-tauri/target/release/bundle/macos'])await visit(join(dir,out),0);
 return found.sort((a,b)=>b.builtAt.localeCompare(a.builtAt));
}

/**
 * Apps of a project with how to launch them.
 * @param services the project's supervisor services (to reuse a matching one instead of a new task)
 * @returns {Promise<{id,name,label,kind,kindLabel,location,serviceId,actions:{action,script,label}[],builds:{path,name,builtAt}[]}[]>}
 */
export async function detectApps(root,services=[]){
 const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
 let workspaces=[];try{workspaces=await listWorkspaces(root,{pkg});}catch{}
 const candidates=[{name:pkg.name,location:'.',root:true},...workspaces.map(w=>({name:w.name,location:w.location}))];
 const apps=[];
 for(const c of candidates){
  const dir=resolve(root,c.location??'.');
  let manifest;try{manifest=c.root?pkg:JSON.parse(await readFile(join(dir,'package.json'),'utf8'));}catch{continue;}
  const kind=await appKind(dir,manifest);
  if(!kind)continue;
  const location=relative(root,dir)||'.';
  const service=services.find(s=>s.command?.includes(manifest.name)||(!c.root&&(s.cwd||'.')===location));
  apps.push({
   id:hash(location),name:manifest.name??location,label:manifest.productName??manifest.build?.productName??manifest.name??location,
   kind,kindLabel:KIND_LABEL[kind],location,root:Boolean(c.root),
   serviceId:service?.id??null,serviceLabel:service?.label??null,
   actions:launchScripts(kind,manifest.scripts),
   builds:kind==='react-native'||kind==='expo'?[]:await builtApps(dir),
  });
 }
 return apps;
}

/**
 * Supervisor task that runs an app action with the project's package manager (inside the project).
 * The renderer only sends the app id and the action name; the command is rebuilt here.
 */
export async function appTask(root,app,action,services=[]){
 const step=app.actions.find(a=>a.action===action);
 if(!step)throw new Error('This app has no '+action+' script');
 const manager=await packageManager(root);
 const command=app.root?scriptCommand(manager,step.script):scriptCommand(manager,step.script,app.name);
 const api=services.find(s=>s.id==='api');
 return {id:`run-app-${app.id}-${action}`,label:`${app.label} · ${step.label}`,command,cwd:'.',kind:'task',enabled:false,dependencies:[],ports:[],env:api?.env??{},inheritEnv:[]};
}

/**
 * Web page of a git remote URL, e.g. git@github.com:me/app.git → https://github.com/me/app.
 * Credentials in https URLs are dropped. Returns null for local paths and unknown forms.
 */
export function remoteWebUrl(remote){
 const url=String(remote??'').trim();
 let host,path;
 const scp=url.match(/^[\w.-]+@([^:/]+):(.+)$/);
 if(scp){[,host,path]=scp;}
 else{
  let parsed;try{parsed=new URL(url);}catch{return null;}
  if(!['https:','http:','ssh:','git:','git+ssh:'].includes(parsed.protocol))return null;
  host=parsed.hostname;path=parsed.pathname;
 }
 path=path.replace(/^\/+/,'').replace(/\.git$/,'').replace(/\/+$/,'');
 if(!host||!path)return null;
 // Azure DevOps SSH remotes carry a v3/ prefix: v3/org/project/repo → org/project/_git/repo.
 if(host==='ssh.dev.azure.com'){const [, org, project, repo]=path.split('/');return {url:`https://dev.azure.com/${org}/${project}/_git/${repo}`,provider:'azure',host:'dev.azure.com',path:`${org}/${project}/${repo}`};}
 const provider=/github/.test(host)?'github':/gitlab/.test(host)?'gitlab':/bitbucket/.test(host)?'bitbucket':/dev\.azure|visualstudio/.test(host)?'azure':'git';
 return {url:`https://${host}/${path}`,provider,host,path};
}

/** Link to a branch on the provider's site (falls back to the repository page). */
export function branchWebUrl(web,branch){
 if(!web||!branch)return web?.url??null;
 const b=encodeURIComponent(branch).replace(/%2F/g,'/');
 if(web.provider==='github')return `${web.url}/tree/${b}`;
 if(web.provider==='gitlab')return `${web.url}/-/tree/${b}`;
 if(web.provider==='bitbucket')return `${web.url}/src/${b}`;
 if(web.provider==='azure')return `${web.url}?version=GB${encodeURIComponent(branch)}`;
 return web.url;
}

/** origin (or the first remote) of the project as a web page, with the current branch. */
export async function repository(root,{run=promisify(execFile)}={}){
 const git=args=>run('git',args,{cwd:root,timeout:4000}).then(r=>String(r.stdout).trim()).catch(()=>'');
 const remotes=(await git(['remote'])).split('\n').filter(Boolean);
 if(!remotes.length)return null;
 const name=remotes.includes('origin')?'origin':remotes[0];
 const web=remoteWebUrl(await git(['remote','get-url',name]));
 if(!web)return null;
 const branch=await git(['rev-parse','--abbrev-ref','HEAD']);
 return {remote:name,...web,branch:branch&&branch!=='HEAD'?branch:null,branchUrl:branchWebUrl(web,branch&&branch!=='HEAD'?branch:null)};
}
