import {cp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
export const backends=[
 {id:'node-ts',name:'Node · TypeScript',tools:['node'],description:'Existing RT-App modules and Lambda deployment in TypeScript.'},
 {id:'python',name:'Python',tools:['node','python'],description:'Native local API + Node core for admin/auth/CRUD. AWS deployment pending.'},
 {id:'go',name:'Go',tools:['node','go'],description:'Native local API + Node core for admin/auth/CRUD. AWS deployment pending.'},
 {id:'java',name:'Java',tools:['node','java'],description:'JDK 21 local API + Node core for admin/auth/CRUD. AWS deployment pending.'}
];
export function backend(id='node-ts'){const spec=backends.find(b=>b.id===id);if(!spec)throw new Error('Unknown backend language');return spec;}
export async function generateBackend(target,id,packageRoot){
 const selected=backend(id);if(id==='node-ts')return;
 const directory=join(target,'apps','backend-'+id);await mkdir(directory,{recursive:true});await cp(join(packageRoot,'templates/backends',id),directory,{recursive:true});
 const commands={python:['python3','main.py'],go:['go','run','.'],java:['java','--add-modules','jdk.httpserver','Main.java']};
 await writeFile(join(directory,'package.json'),JSON.stringify({name:'@app/backend-'+id,private:true,type:'module',scripts:{dev:'node run.mjs'}},null,2)+'\n');
 await writeFile(join(directory,'run.mjs'),`import {spawn} from 'node:child_process';\nconst command=${JSON.stringify(commands[id])};\nconst child=spawn(command[0],command.slice(1),{stdio:'inherit',env:process.env});\nfor(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));\nchild.on('error',error=>{console.error(error.message);process.exitCode=1});\nchild.on('exit',code=>process.exitCode=code??0);\n`);
 if(id==='python'){
  const pkg=JSON.parse(await readFile(join(directory,'package.json'),'utf8'));pkg.scripts.setup='node setup.mjs';await writeFile(join(directory,'package.json'),JSON.stringify(pkg,null,2)+'\n');
  await writeFile(join(directory,'run.mjs'),`import {spawn} from 'node:child_process';\nimport {ensurePython} from './setup.mjs';\nconst python=await ensurePython();\nconst child=spawn(python,['main.py'],{stdio:'inherit',env:process.env});\nfor(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));\nchild.on('error',error=>{console.error(error.message);process.exitCode=1});\nchild.on('exit',code=>process.exitCode=code??0);\n`);
 }
 // Refuse to silently publish only the TS core while omitting the selected application API.
 if(['go','python'].includes(id))await cp(join(packageRoot,'languages','core-'+id),join(target,'packages','core-'+id),{recursive:true});
 for(const path of ['.github/workflows/deploy.yml','.gitlab-ci.yml'])await rm(join(target,path),{force:true});
 await writeFile(join(directory,'README.md'),`# ${selected.name} API\n\nRun from the project root:\n\n\`\`\`sh\nnpm run dev\n\`\`\`\n\nAWS deployment pending. Existing admin/auth/CRUD routes use the Node core.\n`);
}
