import {Tray,Menu,nativeImage,app,dialog} from 'electron';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {ServiceHub} from '../hub.mjs';
import {request} from '../client.mjs';
import {configureStartup,startupEnabled} from './startup.mjs';
export async function createServiceTray({hub,show,quit}){
 const icon=nativeImage.createFromPath(join(app.getAppPath(),'electron/assets/trayTemplate.png')).resize({width:18,height:18});icon.setTemplateImage(true);
 const tray=new Tray(icon);tray.setToolTip('RT-App services');
 let busy=false,error='',signature='',timer;
 async function projects(){return JSON.parse(await readFile(join(hub.home,'projects.json'),'utf8').catch(e=>{if(e.code==='ENOENT')return '[]';throw e;}));}
 async function state(root){try{return (await request(root,'status')).services;}catch{try{return JSON.parse(await readFile(join(root,'.rt-app/services.json'),'utf8')).services.map(s=>({...s,state:'offline'}));}catch{return [];}}}
 async function projectAction(project,action,id){
  if(action==='stop'){try{return await request(project.path,'stop',id);}catch(e){if(e.message.includes('not running'))return;throw e;}}
  const target=new ServiceHub({home:hub.home,...hub.options});await target.initialize();await target.select(project.path);return target.action(action,id);
 }
 async function globalAction(action,id){if(action!=='stop'){const registered=await projects();if(registered[0]){const target=new ServiceHub({home:hub.home,...hub.options});await target.initialize();await target.select(registered[0].path);}}return request(hub.home,action,id);}
 async function all(action){
  const failures=[];const registered=await projects();
  if(action!=='stop'){try{await globalAction(action,'all');}catch(e){failures.push(`Global services: ${e.message}`);}}
  for(const project of registered){try{await projectAction(project,action,'all');}catch(e){failures.push(`${project.name}: ${e.message}`);}}
  if(action==='stop'){try{await request(hub.home,action,'all');}catch(e){if(!e.message.includes('not running'))failures.push(e.message);}}
  if(failures.length)throw new Error(failures.join('\n'));
 }
 async function execute(fn,{silent=false}={}){if(busy)return;busy=true;error='';await refresh();try{await fn();}catch(e){error=e.message;console.error(error);if(!silent)dialog.showErrorBox('RT-App services',error);}finally{busy=false;await refresh();}}
 function serviceItems(services,action){return services.map(s=>({label:`${s.label} · ${s.state}`,submenu:[{label:'Start',enabled:!busy&&!['running','starting','waiting'].includes(s.state),click:()=>void execute(()=>action('start',s.id))},{label:'Stop',enabled:!busy&&['running','starting','waiting','stopping'].includes(s.state),click:()=>void execute(()=>action('stop',s.id))},{label:'Restart',enabled:!busy,click:()=>void execute(()=>action('restart',s.id))}]}));}
 async function refresh(){
  if(tray.isDestroyed())return;
  const registered=await projects(),enabled=await startupEnabled();const global=await state(hub.home);const entries=await Promise.all(registered.map(async p=>({...p,services:await state(p.path)})));
  const next=JSON.stringify({enabled,busy,error,global:global.map(s=>[s.id,s.state]),entries:entries.map(p=>[p.path,p.services.map(s=>[s.id,s.state])])});if(next===signature)return;signature=next;
  tray.setContextMenu(Menu.buildFromTemplate([
   {label:'RT-App · Service manager',enabled:false},
   {label:'Open dashboard',click:show},
   ...(error?[{label:`Error: ${error.split('\n')[0].slice(0,90)}`,click:()=>dialog.showErrorBox('RT-App services',error)}]:[]),
   {type:'separator'},
   {label:busy?'Working…':'Start all services',enabled:!busy,click:()=>void execute(()=>all('start'))},
   {label:'Stop all services',enabled:!busy,click:()=>void execute(()=>all('stop'))},
   {label:'Restart all services',enabled:!busy,click:()=>void execute(()=>all('restart'))},
   {type:'separator'},
   {label:'Global services',submenu:serviceItems(global,(action,id)=>globalAction(action,id))},
   ...entries.map(p=>({label:p.name,submenu:[{label:'Start project',enabled:!busy,click:()=>void execute(()=>projectAction(p,'start','all'))},{label:'Stop project',enabled:!busy,click:()=>void execute(()=>projectAction(p,'stop','all'))},{type:'separator'},...serviceItems(p.services,(action,id)=>projectAction(p,action,id))]})),
   {type:'separator'},
   {label:'Start at login · all registered projects',type:'checkbox',checked:enabled,enabled:app.isPackaged&&process.platform==='darwin'&&!busy,click:item=>void execute(()=>configureStartup(item.checked,process.execPath))},
   {label:'Quit manager (keep services running)',click:quit},
   {label:'Stop everything and quit',enabled:!busy,click:()=>void execute(async()=>{await all('stop');quit();})},
  ]));
 }
 await refresh();timer=setInterval(()=>void refresh().catch(e=>{error=e.message;}),3000);timer.unref();
 tray.on('double-click',show);
 return {startAll:()=>execute(()=>all('start'),{silent:true}),destroy(){clearInterval(timer);tray.destroy();}};
}
