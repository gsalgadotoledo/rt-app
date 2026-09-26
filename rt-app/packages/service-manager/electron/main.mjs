import {openProjectLocation} from './project-open.mjs';
import {app,BrowserWindow,ipcMain,shell,dialog,Menu,clipboard} from 'electron';
import {resolve,join} from 'node:path';
import {stat} from 'node:fs/promises';
import {createServiceTray} from './tray.mjs';
import {configureStartup,startupEnabled} from './startup.mjs';
import {ProjectWizard} from '../projects.mjs';
import {ServiceHub} from '../hub.mjs';
import {deployInfo,connectProject} from '../deploy.mjs';
let root,window,hub,tray,wizard,quitting=false;
const background=process.argv.includes('--background');
const quit=()=>{quitting=true;app.quit();};
const show=()=>{window?.show();window?.focus();};
app.on('before-quit',()=>{quitting=true;});
app.setName('RT-App Service Manager');
// Packaged apps get the RT icon from the bundle; development runs set it on the Dock.
if(process.platform==='darwin'&&!app.isPackaged)app.whenReady().then(()=>app.dock?.setIcon(join(app.getAppPath(),'electron/assets/icon/icon-1024.png')));
if(!app.requestSingleInstanceLock()){app.quit();}else{
 app.on('second-instance',(_event,argv)=>{if(!argv.includes('--background'))show();});
 app.on('activate',show);
 app.whenReady().then(async()=>{
 try{
  const index=process.argv.indexOf('--project');root=index>=0?resolve(process.argv[index+1]):undefined;
  // CLIs installed from the catalog (gh, flyctl) are available to project commands and deploys.
  {const {cliPaths}=await import('../catalog.mjs');const home=join(app.getPath('home'),'.rt-app','service-manager');process.env.PATH=[...await cliPaths(home),process.env.PATH].join(':');}
  hub=new ServiceHub({... (app.isPackaged?{binary:join(app.getAppPath(),'native/bin',process.platform==='win32'?'rt-app-services.exe':'rt-app-services')}:{})});await hub.initialize();
  wizard=new ProjectWizard(hub);await wizard.initialize();
  root??=hub.registry[0]?.path;
  {
   if(root){try{await hub.select(root);}catch(error){console.error('Could not open previous project: '+error.message);hub.root=null;}}
   Menu.setApplicationMenu(null);
   window=new BrowserWindow({show:!background,width:1130,height:740,minWidth:820,minHeight:570,title:'RT-App Service Manager',backgroundColor:'#14181c',webPreferences:{preload:join(app.getAppPath(),'electron/preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
   window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',event=>event.preventDefault());window.webContents.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
   const trusted=event=>{if(event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame)throw new Error('Invalid IPC sender');};
   ipcMain.handle('projects:status',(event,id,backendId)=>{trusted(event);return wizard.status(id,backendId);});
   ipcMain.handle('projects:drop-folder',async(event,path)=>{trusted(event);if(typeof path!=='string'||!path||!(await stat(path)).isDirectory())throw new Error('Drop a project or workspace folder');
    let existing=false;try{existing=(await stat(join(path,'rt-app.settings.json'))).isFile();}catch(error){if(error.code!=='ENOENT')throw error;}
    if(existing)return {kind:'project',snapshot:await hub.select(path)};
    await wizard.choose(path);return {kind:'workspace'};
   });
   ipcMain.handle('projects:workspace',async event=>{trusted(event);const chosen=await dialog.showOpenDialog(window,{title:'Choose a workspace for your projects',defaultPath:wizard.workspace||undefined,properties:['openDirectory','createDirectory']});return chosen.canceled?wizard.workspace:wizard.choose(chosen.filePaths[0]);});
   ipcMain.handle('projects:install-tools',(event,ids)=>{trusted(event);return wizard.install(ids);});
   ipcMain.handle('projects:create',(event,spec)=>{trusted(event);return wizard.create(spec);});
   ipcMain.handle('services:copy-text',(event,text)=>{trusted(event);if(typeof text!=='string')throw new Error('Invalid output');clipboard.writeText(text);});
   ipcMain.handle('projects:open-location',async(event,target,path)=>{trusted(event);return openProjectLocation({target,path,registry:hub.registry,shell});});
   ipcMain.handle('services:commands',event=>{trusted(event);return hub.commands();});
   ipcMain.handle('services:run-command',(event,id)=>{trusted(event);return hub.runCommand(id);});
   ipcMain.handle('services:status',event=>{trusted(event);return hub.snapshot();});
   ipcMain.handle('services:logs',(event,id)=>{trusted(event);if(typeof id!=='string')throw new Error('Invalid service');return hub.logs(id);});
   ipcMain.handle('services:action',(event,action,id)=>{trusted(event);if(!['start','stop','restart'].includes(action)||typeof id!=='string')throw new Error('Invalid action');return hub.action(action,id);});
   ipcMain.handle('services:open-url',async(event,id)=>{trusted(event);await shell.openExternal(await hub.url(id));});
   ipcMain.handle('services:select-project',async(event,path)=>{trusted(event);if(path!==undefined&&!(await hub.projects()).some(p=>p.path===path))throw new Error('Unknown project');if(!path){const selection=await dialog.showOpenDialog(window,{title:'Open RT-App project',properties:['openDirectory']});if(selection.canceled)return hub.snapshot();path=selection.filePaths[0];}return hub.select(path);});
   ipcMain.handle('services:catalog',(event,action,id)=>{trusted(event);return hub.catalogAction(action,id);});
   ipcMain.handle('services:discover',event=>{trusted(event);return hub.discover();});
   ipcMain.handle('services:add-discovered',(event,id)=>{trusted(event);return hub.addDiscovered(id);});
   // Deploy panel: read-only overview; editing keys and plans happens in the admin Deployments page.
   ipcMain.handle('deploy:info',event=>{trusted(event);if(!hub.root)throw new Error('Select a project first');return deployInfo(hub.root);});
   ipcMain.handle('deploy:connect-github',event=>{trusted(event);if(!hub.root)throw new Error('Select a project first');return connectProject(hub.root);});
   ipcMain.handle('deploy:open-admin',async event=>{trusted(event);const admin=new URL(await hub.url('admin'));admin.pathname='/settings/deployments';await shell.openExternal(admin.href);});
   // Delete: stop the project's services, forget it, move the folder to the Trash (recoverable).
   ipcMain.handle('projects:delete',async(event,path)=>{trusted(event);if(typeof path!=='string'||!path)throw new Error('Invalid project');const {removed}=await hub.deleteProject(path);await shell.trashItem(removed);return hub.snapshot();});
   // Background services (run at login), web admins and the machine's development processes.
   ipcMain.handle('services:background',(event,id,enabled)=>{trusted(event);if(typeof id!=='string'||typeof enabled!=='boolean')throw new Error('Invalid request');return hub.background(id,enabled);});
   const openLocal=async url=>{const u=new URL(url);if(u.protocol!=='http:'||!['localhost','127.0.0.1'].includes(u.hostname))throw new Error('Only local URLs can be opened');await shell.openExternal(u.href);};
   ipcMain.handle('services:open-admin',async(event,id)=>{trusted(event);if(typeof id!=='string')throw new Error('Invalid service');await openLocal(await hub.adminUrl(id));});
   ipcMain.handle('machine:list',event=>{trusted(event);return hub.machineProcesses();});
   ipcMain.handle('machine:stop',(event,pid)=>{trusted(event);return hub.stopProcess(pid);});
   ipcMain.handle('machine:detach',(event,label)=>{trusted(event);if(typeof label!=='string')throw new Error('Invalid label');return hub.detachAgent(label);});
   ipcMain.handle('machine:open-port',async(event,port)=>{trusted(event);if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid port');await openLocal(`http://localhost:${port}`);});
   ipcMain.handle('terraform:stacks',event=>{trusted(event);return hub.terraformStacks();});
   ipcMain.handle('terraform:variables',(event,id)=>{trusted(event);if(typeof id!=='string')throw new Error('Invalid stack');return hub.terraformVariables(id);});
   ipcMain.handle('terraform:set-variables',(event,id,values)=>{trusted(event);if(typeof id!=='string'||!values||typeof values!=='object'||Object.values(values).some(v=>typeof v!=='string'))throw new Error('Invalid variables');return hub.terraformSetVariables(id,values);});
   ipcMain.handle('terraform:globals',event=>{trusted(event);return hub.terraformGlobals();});
   ipcMain.handle('terraform:set-globals',(event,values)=>{trusted(event);if(!values||typeof values!=='object'||Object.values(values).some(v=>typeof v!=='string'))throw new Error('Invalid variables');return hub.terraformSetGlobals(values);});
   ipcMain.handle('terraform:run',(event,id,command)=>{trusted(event);if(typeof id!=='string'||typeof command!=='string')throw new Error('Invalid command');return hub.terraformRun(id,command);});
   ipcMain.handle('terraform:get-run',(event,id,runId)=>{trusted(event);if(typeof id!=='string'||typeof runId!=='string')throw new Error('Invalid run');return hub.terraformGetRun(id,runId);});
   ipcMain.handle('terraform:history',(event,id)=>{trusted(event);if(typeof id!=='string')throw new Error('Invalid stack');return hub.terraformHistory(id);});
   ipcMain.handle('terraform:open-link',async(event,link)=>{trusted(event);const url=new URL(String(link));if(url.protocol!=='https:')throw new Error('Only https links can be opened');await shell.openExternal(url.href);});
   ipcMain.handle('services:ports',(event,scope,ports)=>{trusted(event);return hub.setPorts(scope,ports);});
   window.on('close',event=>{if(!quitting){event.preventDefault();window.hide();}});
   tray=await createServiceTray({hub,show,quit});
   await window.loadFile(join(app.getAppPath(),'dist/index.html'));
   // Register once; an explicit user disable is preserved in the preferences file.
   if(app.isPackaged&&process.platform==='darwin'){
    const {readFile,writeFile}=await import('node:fs/promises');const path=join(hub.home,'desktop.json');
    let preferences;try{preferences=JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
    if(!preferences){await configureStartup(true,process.execPath);await writeFile(path,JSON.stringify({startupConfigured:true})+'\n',{mode:0o600});}
   }
   if(background)void tray.startAll();
  }
 }catch(error){console.error(error?.stack??error);dialog.showErrorBox('RT-App Service Manager',error.message);app.quit();}
 });
 app.on('window-all-closed',()=>{});
 app.on('will-quit',()=>tray?.destroy());
}
// The project daemon belongs to the CLI and desktop jointly. Closing a window does
// not stop another client's services; Stop all or `rta services shutdown` does.
