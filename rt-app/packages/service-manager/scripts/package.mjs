import {packager} from '@electron/packager';
import {build} from 'esbuild';
import {mkdtemp,mkdir,cp,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {run,ensureNative} from '../client.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
await run('npm',['run','build'],{cwd:root});const binary=await ensureNative();
const staging=await mkdtemp(join(tmpdir(),'rt-app-desktop-'));
try{
 await mkdir(join(staging,'electron'),{recursive:true});await mkdir(join(staging,'native/bin'),{recursive:true});
 await cp(join(root,'electron/assets'),join(staging,'electron/assets'),{recursive:true});
 await run(process.execPath,[join(root,'../create/scripts/prepare.mjs')],{cwd:resolve(root,'../../..')});
 const generator=join(staging,'node_modules/@gsalgadotoledo/rt-app-create');await mkdir(generator,{recursive:true});
 for(const name of ['package.json','runtime.mjs','toolchain.json','templates','starter','languages','LICENSE'])await cp(join(root,'../create',name),join(generator,name),{recursive:true});
 await build({entryPoints:[join(root,'../create/index.mjs')],outfile:join(generator,'index.mjs'),bundle:true,platform:'node',format:'esm'});
 await cp(join(root,'json-server.mjs'),join(staging,'json-server.mjs'));
 await cp(join(root,'dist'),join(staging,'dist'),{recursive:true});await cp(join(root,'electron/preload.cjs'),join(staging,'electron/preload.cjs'));
 await cp(binary,join(staging,'native/bin',process.platform==='win32'?'rt-app-services.exe':'rt-app-services'));
 await build({entryPoints:[join(root,'electron/main.mjs')],outfile:join(staging,'main.mjs'),bundle:true,platform:'node',format:'esm',external:['electron','@gsalgadotoledo/rt-app-create','@gsalgadotoledo/rt-app-create/runtime']});
 await writeFile(join(staging,'package.json'),JSON.stringify({name:'rt-app-service-manager',productName:'RT-App Service Manager',version:'0.1.0',type:'module',main:'main.mjs'}));
 const version=JSON.parse(await readFile(join(root,'package.json'))).devDependencies.electron;
 const paths=await packager({dir:staging,out:join(root,'release'),name:'RT-App Service Manager',electronVersion:version,platform:process.platform,arch:process.arch,overwrite:true,asar:false,appBundleId:'dev.rtapp.services',prune:false});
 console.log(paths.join('\n'));
}finally{await rm(staging,{recursive:true,force:true});}
