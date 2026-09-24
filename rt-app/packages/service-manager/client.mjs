import { packageFile } from '@gsalgadotoledo/rt-app-config/paths';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,mkdir,access,open,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';
import {connect} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {localUrls,environmentVariables,publicConfig} from '@gsalgadotoledo/rt-app-config';
const packageRoot=fileURLToPath(new URL('.',import.meta.url));
export const defaultBinary=resolve(packageRoot,'native/target/release',process.platform==='win32'?'rt-app-services.exe':'rt-app-services');
export function run(command,args,options={}) {return new Promise((yes,no)=>{const child=spawn(command,args,{stdio:'inherit',...options});child.once('error',no);child.once('exit',code=>code===0?yes():no(new Error(`${command} exited (${code})`)));});}
export async function ensureNative(binary=defaultBinary) {
 let rebuild=false;
 try{
  const built=await stat(binary);
  if(binary===defaultBinary){for(const name of ['native/src/main.rs','native/Cargo.toml','native/Cargo.lock']){if((await stat(join(packageRoot,name))).mtimeMs>built.mtimeMs)rebuild=true;}}
 }catch{rebuild=true;}
 if(rebuild){if(binary!==defaultBinary)throw new Error('Bundled supervisor binary is missing');await run('cargo',['build','--release','--locked','--manifest-path',join(packageRoot,'native/Cargo.toml')]);}
 return binary;
}
export function bindPorts(service) {
 const bindings=service.portEnv??[];
 if(bindings.some(key=>typeof key!=='string'||! /^[A-Z][A-Z0-9_]*$/.test(key))||bindings.length>(service.ports??[]).length)throw new Error('Invalid portEnv binding');
 const env={...service.env,...Object.fromEntries(bindings.map((key,i)=>[key,String(service.ports[i])]))};
 return {...service,env,command:service.command.map(arg=>arg.replace(/^\$\{([A-Z][A-Z0-9_]*)\}$/,(_match,key)=>{if(env[key]===undefined)throw new Error(`Missing command variable ${key}`);return env[key];}))};
}
export async function manifest(root,{noBuild=false,noMail=false,sharedMail,sharedEnv={},settings:providedSettings}={}) {
 const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
 const settings=providedSettings??JSON.parse(await readFile(join(root,'rt-app.settings.json'),'utf8'));
 const urls=Object.fromEntries(Object.entries(localUrls).map(([id,url])=>[id,`http://localhost:${settings.local?.ports?.[id]??new URL(url).port}`]));
 if(settings.version!==1)throw new Error('Unsupported RT-App settings version');
 const shared={PATH:process.env.PATH??'',...sharedEnv,...environmentVariables(publicConfig(Object.fromEntries(Object.entries(urls).map(([id,url])=>[`RT_APP_${id.toUpperCase()}_URL`,url])))),RT_APP_TARGET:'local',RT_APP_MODE:settings.runtime.local.mode,NEXT_TELEMETRY_DISABLED:'1'};
 const nativeBackend=settings.backend&&settings.backend!=='node-ts';
 const corePort=settings.local?.ports?.coreApi??4011;
 const credentials=['ADMIN_PASSWORD','DEMO_PASSWORD','RT_APP_JSON_FILE','ENABLE_TASKS','AWS_PROFILE','AWS_REGION','AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_SESSION_TOKEN','RT_APP_AWS_APP','OBSERVER_EMAIL_TRANSPORT','OBSERVER_EMAIL_FROM','OBSERVER_EMAIL_TO','OBSERVER_SMS_TO','OBSERVER_LOG_GROUP','OBSERVER_LOG_STREAM','SUBSCRIPTIONS_PROVIDER','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','STRIPE_PUBLISHABLE_KEY'];
 const services=[];
 if(settings.services?.defaults!==false){
  const {stdout}=await promisify(execFile)('npm',['query','.workspace','--json'],{cwd:root});
  const workspaces=JSON.parse(stdout);
  if(!noBuild)services.push({id:'build',label:'Build workspace',kind:'task',command:['npm','run','build'],cwd:'.',env:shared,ports:[],dependencies:[]});
  if(!noMail&&!sharedMail)services.push({id:'mail',label:'Mailpit · local email',command:[process.env.RT_APP_NODE_BINARY??'node', packageFile('@gsalgadotoledo/rt-app-cli','bin/rta.mjs',root),'mail'],cwd:'.',env:shared,ports:[1025,8025],url:'http://127.0.0.1:8025',readyUrl:'http://127.0.0.1:8025/readyz',dependencies:[]});
  if(nativeBackend)services.push({id:'core-api',label:'RT-App core · Node',command:['npm','run','dev','--workspace','@gsalgadotoledo/rt-app-server'],cwd:'.',env:{...shared,PORT:String(corePort),RT_APP_MAIL_TRANSPORT:noMail?'memory':'smtp',RT_APP_MAIL_SMTP_PORT:String(sharedMail?.smtp??1025)},inheritEnv:credentials,ports:[corePort],url:`http://localhost:${corePort}`,readyUrl:`http://localhost:${corePort}/`,dependencies:[...(!noBuild?['build']:[]),...(!noMail&&!sharedMail?['mail']:[])]});
  for(const role of ['backend','admin','spa','ssr']){
   const workspace=pkg.rtApp?.[role];if(!workspace)continue;
   if (role==='admin' && !workspaces.some(w=>w.name===workspace)) {
    services.push({id:'admin',label:'Admin',command:[process.env.RT_APP_NODE_BINARY??'node',packageFile('@gsalgadotoledo/rt-app-cli','bin/rta.mjs',root),'admin'],cwd:'.',env:shared,ports:[Number(new URL(urls.admin).port)],url:urls.admin,readyUrl:urls.admin+'/',dependencies:[...(!noBuild?['build']:[]),'api']});
    continue;
   }
   const entry=workspaces.find(w=>w.name===workspace);if(!entry)throw new Error(`Missing workspace ${workspace}; run npm install`);
   const script=entry.scripts?.dev?'dev':'start';if(!entry.scripts?.[script])throw new Error(`No dev/start script for ${workspace}`);
   const id=role==='backend'?'api':role,url=urls[id];
   services.push({id,label:{api:nativeBackend?`API · ${settings.backend}`:'API · Node TS',admin:'Admin',spa:'React SPA',ssr:'Next.js SSR'}[id],command:['npm','run',script,'--workspace',workspace],cwd:'.',env:{...shared,PORT:new URL(urls.api).port,...(nativeBackend&&role==='backend'?{RT_APP_CORE_API_URL:`http://127.0.0.1:${corePort}`} : {}),RT_APP_MAIL_TRANSPORT:noMail?'memory':'smtp',RT_APP_MAIL_SMTP_PORT:String(sharedMail?.smtp??1025)},inheritEnv:role==='backend'&&!nativeBackend?credentials:[],ports:[Number(new URL(url).port)],url,readyUrl:url+'/',dependencies:[...(!noBuild?['build']:[]),...(role==='backend'?(nativeBackend?['core-api']:(!noMail&&!sharedMail?['mail']:[])):['api'])]});
  }
 }
 for(const service of settings.services?.extra??[])services.push(bindPorts({...service,env:{...shared,...service.env}}));
 return {services};
}
export async function request(root,action,service,spec) {
 let registry;try{registry=JSON.parse(await readFile(join(root,'.rt-app/supervisor.json'),'utf8'));}catch{throw new Error('Supervisor is not running');}
 return new Promise((yes,no)=>{const socket=connect({host:'127.0.0.1',port:registry.port});let data='';socket.setTimeout(10000,()=>socket.destroy(new Error('Supervisor request timed out')));socket.once('connect',()=>socket.write(JSON.stringify({token:registry.token,action,service,spec})+'\n'));socket.on('data',chunk=>{data+=chunk;if(data.length>4000000)return socket.destroy(new Error('Response too large'));if(data.includes('\n')){socket.end();try{const value=JSON.parse(data.trim());value.ok?yes(value.data):no(new Error(value.error));}catch(error){no(error);}}});socket.once('error',()=>no(new Error('Supervisor is not running or unavailable')));socket.once('end',()=>{if(!data.includes('\n'))no(new Error('Supervisor closed the connection'));});});
}
export async function ensureDaemon(root,options={}) {
 root=resolve(root);
 try{await request(root,'status');return {started:false};}catch{}
 const binary=await ensureNative(options.binary??defaultBinary),config=options.config??await manifest(root,options);
 await mkdir(join(root,'.rt-app'),{recursive:true,mode:0o700});const path=join(root,'.rt-app/services.json');await writeFile(path,JSON.stringify(config,null,2)+'\n',{mode:0o600});
 const output=await open(join(root,'.rt-app/supervisor.log'),'a',0o600);
 const child=spawn(binary,['serve','--project',root,'--config',path],{cwd:root,detached:true,stdio:['ignore',output.fd,output.fd],env:process.env});let error;child.once('error',e=>{error=e;});child.unref();await output.close();
 for(let i=0;i<100;i++){if(error)throw error;try{await request(root,'status');return {started:true};}catch{}await delay(100);}
 throw new Error('Supervisor did not start. See .rt-app/supervisor.log');
}
export function client(root){return {snapshot:()=>request(root,'status'),action:(action,id)=>request(root,action,id),logs:id=>request(root,'logs',id)};}
