import {readdir,readFile,access} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {createHash} from 'node:crypto';
const ignored=new Set(['node_modules','.git','.rt-app','target','dist','build','.next','.venv','venv','release']);
export async function discover(root){
 const found=[];let count=0;const exists=async p=>{try{await access(p);return true;}catch{return false;}};
 async function visit(dir,depth){if(depth>4||++count>400)return;const entries=await readdir(dir,{withFileTypes:true});const files=new Set(entries.filter(e=>e.isFile()).map(e=>e.name));const cwd=relative(root,dir)||'.';
 function add(label,command,source){const id='discovered-'+createHash('sha256').update(cwd+JSON.stringify(command)).digest('hex').slice(0,10);found.push({id,label,command,cwd,source,ports:[],dependencies:[],enabled:true});}
 if(files.has('package.json')){try{const pkg=JSON.parse(await readFile(join(dir,'package.json'),'utf8'));const script=pkg.scripts?.dev?'dev':pkg.scripts?.start?'start':null;if(script)add(`${pkg.name??cwd}${pkg.dependencies?.electron||pkg.devDependencies?.electron?' · Electron':''}`,['npm','run',script],'package.json');}catch{}}
 if(files.has('go.mod')){if(files.has('main.go'))add(`Go · ${cwd}`,['go','run','.'],'go.mod + main.go');else{const commands=await readdir(join(dir,'cmd'),{withFileTypes:true}).catch(()=>[]);for(const entry of commands)if(entry.isDirectory()&&await exists(join(dir,'cmd',entry.name,'main.go')))add(`Go · ${entry.name}`,['go','run',`./cmd/${entry.name}`],'go.mod + cmd');}}
 if(files.has('manage.py'))add(`Django · ${cwd}`,['python3','manage.py','runserver','127.0.0.1:8000'],'manage.py');
 else if(files.has('pyproject.toml')||files.has('requirements.txt')){const entry=files.has('main.py')?'main.py':files.has('app.py')?'app.py':null;if(entry)add(`Python · ${cwd}`,['python3','-u',entry],'Python manifest');}
 for(const e of entries)if(e.isDirectory()&&!ignored.has(e.name)&&!e.name.startsWith('.'))await visit(join(dir,e.name),depth+1);
 }
 await visit(root,0);let pkg={};try{pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}const defaults=new Set(Object.values(pkg.rtApp??{}));
 return found.filter(s=>s.cwd!=='.'||s.source!=='package.json').filter(s=>!defaults.has(s.label)&&!s.cwd.startsWith('rt-app/'));
}
