import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
const root=process.cwd(), output=join(root,'artifacts');
const run=(cmd,args,options={})=>execFileSync(cmd,args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],...options});
const workspaces=JSON.parse(run('npm',['query','.workspace','--json']));
if(!workspaces.length)throw Error('Run npm ci first');
const packages=new Map(workspaces.map(w=>{const path=resolve(w.location);return [w.name,{path,pkg:JSON.parse(readFileSync(join(path,'package.json')))}]}));
const order=[],visiting=new Set(),done=new Set();
function visit(name){if(done.has(name))return;if(visiting.has(name))throw Error('Dependency cycle: '+name);visiting.add(name);const {pkg}=packages.get(name);for(const dep of Object.keys({...pkg.dependencies,...pkg.optionalDependencies}))if(packages.has(dep))visit(dep);visiting.delete(name);done.add(name);if(!pkg.private)order.push(name);}
for(const name of packages.keys())visit(name);
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const action=process.argv[2];
if(action==='pack'){
 rmSync(join(output,'verified.json'),{force:true});
 mkdirSync(output,{recursive:true});const manifest=[];
 for(const name of order){
  const {path,pkg}=packages.get(name);
  for(const [dep,version] of Object.entries({...pkg.dependencies,...pkg.optionalDependencies}))if(packages.has(dep)&&version!==packages.get(dep).pkg.version)throw Error('Unpinned dependency: '+name+' -> '+dep);
  const result=JSON.parse(run('npm',['pack',path,'--ignore-scripts','--json','--pack-destination',output]))[0];
  for(const f of result.files)if(/(^|\/)(node_modules|\.git|\.rt-app|\.env[^/]*|target|release)(\/|$)|\.(tfstate|tfplan|log|db|sqlite)$/.test(f.path))throw Error('Forbidden release file: '+name+' '+f.path);
  const destinations=[];
  function exports(value){if(typeof value==='string'&&value.startsWith('./'))destinations.push(value.slice(2));else if(value&&typeof value==='object')Object.values(value).forEach(exports);}
  exports(pkg.exports);exports(pkg.main?.startsWith('./')?pkg.main:'./'+(pkg.main??''));exports(pkg.types);
  for(const target of destinations.filter(Boolean))if(!target.includes('*')&&!result.files.some(f=>f.path===target))throw Error('Missing export: '+name+' '+target);
  manifest.push({name,version:pkg.version,file:result.filename,sha256:hash(join(output,result.filename)),files:result.files.length});
  console.log('Packed '+name+' ('+result.files.length+' files)');
 }
 writeFileSync(join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
}else if(action==='verify'){
 rmSync(join(output,'verified.json'),{force:true});
 const manifest=JSON.parse(readFileSync(join(output,'manifest.json'))),temp=mkdtempSync(join(tmpdir(),'rt-app-package-test-'));
 try{
  for(const item of manifest)if(hash(join(output,item.file))!==item.sha256)throw Error('Artifact changed: '+item.name);
  writeFileSync(join(temp,'package.json'),JSON.stringify({name:'release-smoke',private:true,type:'module'}));
  run('npm',['install','--ignore-scripts','--no-audit','--no-fund',...manifest.map(p=>join(output,p.file))],{cwd:temp});
  run(process.execPath,['--input-type=module','-e',"const {createRTApp}=await import('@gsalgadotoledo/rt-app-core');if(typeof createRTApp!=='function')throw Error('Core export missing');const {createApplication}=await import('@gsalgadotoledo/rt-app-framework');if(typeof createApplication!=='function')throw Error('Framework export missing');"],{cwd:temp});
  run(process.execPath,[join(temp,'node_modules/@gsalgadotoledo/rt-app-cli/bin/rta.mjs'),'help'],{cwd:temp});
  run(process.execPath,['--input-type=module','-e',"const {createProject}=await import('@gsalgadotoledo/rt-app-create');await createProject({workspace:process.cwd(),name:'smoke-app',templateId:'admin-crm',install:false});"],{cwd:temp});
  run('npm',['install','--ignore-scripts','--no-audit','--no-fund',...manifest.map(p=>join(output,p.file))],{cwd:join(temp,'smoke-app')});
  if(existsSync(join(temp,'smoke-app','rt-app')))throw Error('Starter contains a source copy of the framework');
  run('npm',['run','build'],{cwd:join(temp,'smoke-app'),maxBuffer:20*1024*1024});
  run(process.execPath,[join(root,'rt-app/scripts/smoke-admin.mjs'),join(temp,'smoke-app')],{maxBuffer:20*1024*1024});
  run('npm',['test','--workspaces','--if-present'],{cwd:join(temp,'smoke-app'),maxBuffer:20*1024*1024});
  run('npm',['run','lambda:build'],{cwd:join(temp,'smoke-app'),maxBuffer:20*1024*1024});
  run(process.env.TF_CLI_PATH??'terraform',['-chdir=infra/aws','init','-backend=false','-input=false'],{cwd:join(temp,'smoke-app'),maxBuffer:20*1024*1024});
  run(process.env.TF_CLI_PATH??'terraform',['-chdir=infra/aws','validate'],{cwd:join(temp,'smoke-app')});
  console.log('Clean installation, core/framework imports, CLI, packaged generation and generated application build passed.');
  writeFileSync(join(output,'verified.json'),JSON.stringify({manifestSha256:hash(join(output,'manifest.json'))})+'\n');
 }finally{rmSync(temp,{recursive:true,force:true});}
}else if(action==='publish'){
 const path=join(output,'manifest.json'),manifest=JSON.parse(readFileSync(path));
 const verified=JSON.parse(readFileSync(join(output,'verified.json')));
 if(verified.manifestSha256!==hash(path))throw Error('Run release:verify after packing');
 for(const item of manifest)if(hash(join(output,item.file))!==item.sha256)throw Error('Artifact changed: '+item.name);
 // npm handles the interactive 2FA challenge or GitHub OIDC. Never persist tokens here.
 for (const item of manifest) {
  let published;
  try { published = JSON.parse(run('npm', ['view', item.name+'@'+item.version, 'dist.integrity', '--json'])); }
  catch (error) {
    if (!String(error.stderr).includes('E404')) throw error;
  }
  const integrity = 'sha512-' + createHash('sha512').update(readFileSync(join(output,item.file))).digest('base64');
  if (published) {
    if (published !== integrity) throw Error('Version already exists with different contents: '+item.name+'@'+item.version);
    console.log('Already published: '+item.name);
    continue;
  }
  execFileSync('npm',['publish',join(output,item.file),'--access','public','--tag','next','--ignore-scripts'],{cwd:root,stdio:'inherit'});
 }
}else throw Error('Usage: node scripts/release.mjs pack|verify|publish');
