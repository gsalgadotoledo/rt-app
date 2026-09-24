import { createRequire } from 'node:module';
import {ServiceHub} from './hub.mjs';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {ensureDaemon,ensureNative,request,run} from './client.mjs';
const packageRoot=fileURLToPath(new URL('.',import.meta.url));
export async function servicesCommand(root,args){
 const [action='status',id,...values]=args.filter(a=>a!=='--json');
 if(action==='shutdown'){if(id==='global'){const hub=new ServiceHub();console.log(JSON.stringify(await request(hub.home,'shutdown')));}else console.log(JSON.stringify(await request(root,'shutdown')));return;}
 const hub=new ServiceHub();await hub.initialize();await hub.select(root);
 let result;
 if(action==='ports'){const keys=id==='global'?['smtp','mail']:['api','admin','spa','ssr'];if(values.length!==keys.length)throw new Error(`Usage: services ports ${id} ${keys.join(' ')}`);const snapshot=await hub.snapshot();result=await hub.setPorts(id,{...(id==='global'?snapshot.globalPorts:snapshot.projectPorts),...Object.fromEntries(keys.map((k,i)=>[k,Number(values[i])]))});}
 else if(action==='discover')result=await hub.discover();
 else if(action==='add-discovered')result=await hub.addDiscovered(id);
 else if(action==='catalog'){if(!id||id==='list')result=(await hub.snapshot()).catalog;else{result=await hub.catalogAction(id,values[0]);if(id==='add'){while(true){const item=(await hub.snapshot()).catalog.find(x=>x.id===values[0]);if(!item?.job||['ready','error'].includes(item.job.state)){result=item;break;}await new Promise(r=>setTimeout(r,500));}}}}
 else if(['status','daemon'].includes(action))result=await hub.snapshot();
 else if(action==='logs')result=await hub.logs(id);
 else result=await hub.action(action,id??'all');
 console.log(JSON.stringify(result,null,2));
}
export async function desktopCommand(root){
 await ensureNative();
 let electron;
 try { electron=createRequire(join(root,'package.json'))('electron'); } catch { throw new Error('Install Electron in this project: npm install --save-dev electron@44.4.4'); }
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 await run(electron,[packageRoot,'--project',root],{env});
}
export async function devCommand(root,args){
 if(args.some(a=>!['--no-build','--no-mail'].includes(a)))throw new Error('Usage: rta dev [--no-build] [--no-mail]');
 const hub=new ServiceHub({noBuild:args.includes('--no-build'),noMail:args.includes('--no-mail')});await hub.initialize();await hub.select(root);
 await hub.action('start','all');console.log('RT-App native supervisor started. Open npm run desktop for controls. Ctrl+C stops these services.');
 const seen=new Map();let stopping=false;
 const stop=async()=>{if(stopping)return;stopping=true;await hub.action('stop','all').catch(()=>{});};
 process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
 while(!stopping){const snapshot=await hub.snapshot();for(const service of snapshot.services){if(seen.get(service.id)!==service.state){console.log(`[${service.id}] ${service.state}${service.url?' · '+service.url:''}${service.error?' · '+service.error:''}`);seen.set(service.id,service.state);}}await new Promise(r=>setTimeout(r,700));}
}
