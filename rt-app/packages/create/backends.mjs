import {cp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
export const backends=[
 {id:'node-ts',name:'Node · TypeScript',tools:['node'],description:'Existing RT-App modules and Lambda deployment in TypeScript.'},
 {id:'python',name:'Python',tools:['node','python'],description:'Native Python API (health, feature flags and your modules) with server, Lambda and CLI modes; other routes use the Node core.'},
 {id:'go',name:'Go',tools:['node','go'],description:'Native Go API (health, feature flags and your modules) with server, Lambda and CLI modes; other routes use the Node core.'},
 {id:'java',name:'Java',tools:['node','java'],description:'JDK 21 local API + Node core for admin/auth/CRUD. AWS deployment pending.'}
];
export function backend(id='node-ts'){const spec=backends.find(b=>b.id===id);if(!spec)throw new Error('Unknown backend language');return spec;}
export async function generateBackend(target,id,packageRoot){
 const selected=backend(id);if(id==='node-ts')return;
 const directory=join(target,'apps','backend-'+id);await mkdir(directory,{recursive:true});await cp(join(packageRoot,'templates/backends',id),directory,{recursive:true});
 const commands={python:['python3','main.py'],go:['go','run','.','-mode=serve'],java:['java','--add-modules','jdk.httpserver','Main.java']};
 await writeFile(join(directory,'package.json'),JSON.stringify({name:'@app/backend-'+id,private:true,type:'module',scripts:{dev:'node run.mjs'}},null,2)+'\n');
 await writeFile(join(directory,'run.mjs'),`import {spawn} from 'node:child_process';\nconst command=${JSON.stringify(commands[id])};\nconst child=spawn(command[0],command.slice(1),{stdio:'inherit',env:process.env});\nfor(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));\nchild.on('error',error=>{console.error(error.message);process.exitCode=1});\nchild.on('exit',code=>process.exitCode=code??0);\n`);
 if(id==='python'){
  const pkg=JSON.parse(await readFile(join(directory,'package.json'),'utf8'));pkg.scripts.setup='node setup.mjs';await writeFile(join(directory,'package.json'),JSON.stringify(pkg,null,2)+'\n');
  await writeFile(join(directory,'run.mjs'),`import {spawn} from 'node:child_process';\nimport {ensurePython} from './setup.mjs';\nconst python=await ensurePython();\nconst child=spawn(python,['main.py'],{stdio:'inherit',env:process.env});\nfor(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));\nchild.on('error',error=>{console.error(error.message);process.exitCode=1});\nchild.on('exit',code=>process.exitCode=code??0);\n`);
 }
 // Generated native dev scripts watch sources; start remains a one-shot production-style launch.
 await cp(join(packageRoot,'templates/backends/watch.mjs'),join(directory,'watch.mjs'));
 const nativePackage=JSON.parse(await readFile(join(directory,'package.json'),'utf8'));
 nativePackage.scripts.start='node run.mjs';
 nativePackage.scripts.dev='node dev.mjs';
 if(id==='go'){nativePackage.scripts.test='go test ./...';nativePackage.scripts.build='go build ./...';}
 if(id==='python'){
  nativePackage.scripts.test='node test.mjs';
  await writeFile(join(directory,'test.mjs'),"import {spawn} from 'node:child_process';\nimport {ensurePython} from './setup.mjs';\nconst child=spawn(await ensurePython(),['-m','unittest','discover'],{stdio:'inherit'});\nchild.on('error',e=>{console.error(e.message);process.exitCode=1});\nchild.on('exit',code=>process.exitCode=code??1);\n");
 }
 await writeFile(join(directory,'package.json'),JSON.stringify(nativePackage,null,2)+'\n');
 const preparation=id==='python'?"import {ensurePython} from './setup.mjs';\nconst command=[await ensurePython(),'main.py'];":'const command='+JSON.stringify(commands[id])+';';
 await writeFile(join(directory,'dev.mjs'),"import {watchCommand} from './watch.mjs';\n"+preparation+"\nawait watchCommand(command, {roots:['.'"+(['go','python'].includes(id)?",'../../packages/core-"+id+"'":'')+"]});\n");
 // Refuse to silently publish only the TS core while omitting the selected application API.
 if(['go','python'].includes(id))await cp(join(packageRoot,'languages','core-'+id),join(target,'packages','core-'+id),{recursive:true});
 for(const path of ['.github/workflows/deploy.yml','.github/workflows/destroy.yml','.gitlab-ci.yml'])await rm(join(target,path),{force:true});
 await writeFile(join(directory,'README.md'),backendReadme(selected));
}

/** README of a generated native backend. */
function backendReadme(selected){
 const modes={
  python:'```sh\nnpm run dev                                            # from the project root (with the Node core)\npython main.py                                         # HTTP server on $PORT\npython -m rt_app.web lambda-local app:create_app       # the Lambda handler behind local HTTP\npython -m rt_app.web call app:create_app GET /hello     # one request from the command line\n```\n\nAWS Lambda: `lambda_function.handler`.',
  go:'```sh\nnpm run dev                          # from the project root (with the Node core)\ngo run . -mode=serve                 # HTTP server on $PORT\ngo run . -mode=lambda-local         # the Lambda handler behind local HTTP\ngo run . -mode=cli GET /hello        # one request from the command line\n```\n\nAWS Lambda: build with `GOOS=linux GOARCH=arm64 go build -tags lambda.norpc -o bootstrap .` (runs as Lambda automatically).',
 }[selected.id];
 if(!modes)return `# ${selected.name} API\n\nRun from the project root:\n\n\`\`\`sh\nnpm run dev\n\`\`\`\n\nAWS deployment pending. Existing admin/auth/CRUD routes use the Node core.\n`;
 return `# ${selected.name} API\n\nThe composition root is \`${selected.id==='python'?'app.py':'main.go'}\`: one line per component (store, feature flags, your modules). Change a line to swap an implementation.\n\nRoutes implemented natively answer here; every other route (admin, auth, users, CRUD…) is forwarded to the RT-App Node core (\`RT_APP_CORE_API_URL\`), so modules can move to ${selected.name} one at a time. The RT-App contracts keep each native module equivalent to its TypeScript reference.\n\n${modes}\n\nStores: memory by default; \`DATABASE_URL\` selects PostgreSQL and \`TABLE_NAME\` DynamoDB, using the same rows as the Node core.\n`;
}
