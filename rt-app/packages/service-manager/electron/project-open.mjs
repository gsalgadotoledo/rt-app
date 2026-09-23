import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
const editors={vscode:{name:'Visual Studio Code',bundle:'com.microsoft.VSCode',command:'code'},cursor:{name:'Cursor',bundle:'com.todesktop.230313mzl4w4u92',command:'cursor'}};
export async function openProjectLocation({target,path,registry,shell,run=exec,platform=process.platform}) {
 if(typeof path!=='string'||!registry.some(project=>project.path===path))throw new Error('Select a registered project first.');
 if(target==='folder'){const error=await shell.openPath(path);if(error)throw new Error(error);return;}
 const candidates=target==='editor'?[editors.cursor,editors.vscode]:[editors[target]];
 if(!candidates[0])throw new Error('Unknown editor.');
 for(const editor of candidates){
  try{
   if(platform==='darwin')await run('/usr/bin/open',['-b',editor.bundle,path],{timeout:15000});
   else if(platform==='win32')throw new Error('Editor launcher is not configured for Windows.');
   else await run(editor.command,[path],{timeout:15000});
   return;
  }catch{}
 }
 if(target==='editor'){
  const error=await shell.openPath(path);
  if(error)throw new Error('Could not open the project folder: '+error);
  return;
 }
 throw new Error('Could not open '+candidates[0].name+'. Check its installation and try again.');
}
