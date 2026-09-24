import {spawn,spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=dirname(fileURLToPath(import.meta.url));
const python=join(root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
function run(command,args){return new Promise((resolve,reject)=>{const child=spawn(command,args,{cwd:root,stdio:'inherit'});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error('Python setup failed; install Python 3.11+ and run npm run setup in this workspace.')));});}
export async function ensurePython(){
 if(!existsSync(python))await run('python3',['-m','venv','.venv']);
 const check=spawnSync(python,['-c','import rt_app_core'],{cwd:root,stdio:'ignore'});
 if(check.status!==0)await run(python,['-m','pip','install','--no-deps','-e',join(root,'../../packages/core-python')]);
 return python;
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)await ensurePython();
