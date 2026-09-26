import {readFile,readdir,access,appendFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {discover} from './discovery.mjs';

/**
 * Projects of any stack. RT-App projects are identified by rt-app.settings.json; any other folder
 * is a "generic" project when it contains a known manifest. Generic projects get their services
 * from conventions (package.json scripts, go.mod, pyproject/requirements, Cargo.toml, Makefile).
 */

const exists=async path=>{try{await access(path);return true;}catch{return false;}};

/** Runtime markers checked at the project root, in display order. */
const MARKERS=[
 ['node',['package.json']],
 ['python',['pyproject.toml','requirements.txt','manage.py','Pipfile']],
 ['go',['go.mod']],
 ['rust',['Cargo.toml']],
 ['cpp',['CMakeLists.txt','Makefile','meson.build']],
];

export const RUNTIME_LABELS={node:'Node',python:'Python',go:'Go',rust:'Rust',cpp:'C/C++'};

/** Kind and runtimes of a folder, or undefined when it is not a project. Reads only root files. */
export async function detectProject(path){
 if(await exists(join(path,'rt-app.settings.json'))){
  try{const settings=JSON.parse(await readFile(join(path,'rt-app.settings.json'),'utf8'));if(settings.version===1)return {kind:'rt-app',runtimes:[settings.backend&&settings.backend!=='node-ts'?settings.backend.replace('-ts',''):'node']};}catch{}
 }
 const runtimes=[];
 for(const [runtime,files] of MARKERS)for(const file of files)if(await exists(join(path,file))){runtimes.push(runtime);break;}
 return runtimes.length?{kind:'generic',runtimes}:undefined;
}

/** Display name: package.json name, Cargo/pyproject name, else the folder name. */
export async function projectName(path,fallback){
 try{const pkg=JSON.parse(await readFile(join(path,'package.json'),'utf8'));if(pkg.name)return pkg.name;}catch{}
 for(const file of ['Cargo.toml','pyproject.toml']){try{const match=(await readFile(join(path,file),'utf8')).match(/^\s*name\s*=\s*"([^"]+)"/m);if(match)return match[1];}catch{}}
 return fallback;
}

const id=(cwd,command)=>'svc-'+createHash('sha256').update(cwd+JSON.stringify(command)).digest('hex').slice(0,10);

/**
 * Runnable services of a generic project: the root package.json dev/start script, Rust `cargo run`,
 * a Makefile `run` target, plus everything discovery finds in subfolders (Go, Python, Django, Node).
 * Nothing is executed while detecting.
 */
export async function genericServices(root){
 const found=[];
 const add=(label,command,cwd,source)=>found.push({id:id(cwd,command),label,command,cwd,source,ports:[],dependencies:[],enabled:true});
 try{const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));const script=pkg.scripts?.dev?'dev':pkg.scripts?.start?'start':null;if(script)add(`${pkg.name??'app'} · npm run ${script}`,['npm','run',script],'.','package.json');}catch{}
 if(await exists(join(root,'Cargo.toml')))add('Rust · cargo run',['cargo','run'],'.','Cargo.toml');
 try{const makefile=await readFile(join(root,'Makefile'),'utf8');if(/^run\s*:/m.test(makefile))add('make run',['make','run'],'.','Makefile');}catch{}
 for(const service of await discover(root))if(!found.some(s=>s.id===service.id))found.push(service);
 // Root-level Go/Python entries from discovery already have cwd ".", keep one entry per command.
 return found.filter((s,i)=>found.findIndex(o=>o.cwd===s.cwd&&JSON.stringify(o.command)===JSON.stringify(s.command))===i);
}

/** Supervisor configuration for a generic project (no ports are assumed; the process picks them). */
export function genericManifest(services,env={}){
 return {services:services.filter(s=>s.enabled!==false).map(s=>({id:s.id,label:s.label,command:s.command,cwd:s.cwd,env:{PATH:env.PATH??process.env.PATH??'',...s.env},ports:s.ports??[],dependencies:[],enabled:true,kind:'service'}))};
}

/**
 * Keep the manager's .rt-app/ folder out of git without touching tracked files: a local-only
 * exclude entry in .git/info/exclude (never the project's .gitignore).
 */
export async function excludeFromGit(root){
 if(!await exists(join(root,'.git')))return false;
 const file=join(root,'.git/info/exclude');
 let current='';try{current=await readFile(file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
 if(/^\/?\.rt-app\/?$/m.test(current))return false;
 await mkdir(join(root,'.git/info'),{recursive:true});
 await appendFile(file,(current&&!current.endsWith('\n')?'\n':'')+'# RT-App Service Manager (local supervisor state)\n.rt-app/\n');
 return true;
}

/** One level of a workspace folder: every project with its kind and runtimes. */
export async function scanWorkspace(workspace){
 let entries=[];try{entries=await readdir(workspace,{withFileTypes:true});}catch(e){if(e.code!=='ENOENT')throw e;}
 const projects=[];
 for(const entry of entries.filter(e=>e.isDirectory()&&!e.name.startsWith('.')).sort((a,b)=>a.name.localeCompare(b.name))){
  const path=join(workspace,entry.name),info=await detectProject(path);
  if(info)projects.push({path,name:await projectName(path,entry.name),...info});
 }
 return projects;
}
