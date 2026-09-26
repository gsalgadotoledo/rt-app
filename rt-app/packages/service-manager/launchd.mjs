import {execFile as execFileCallback} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile,rm,readFile,readdir} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

/**
 * Background services: user LaunchAgents (~/Library/LaunchAgents), never system daemons or sudo.
 * A service "runs always" when its agent is installed: it starts at login and restarts if it exits.
 * Agents we create use the dev.rtapp.svc. prefix; other agents are only disabled, never deleted.
 */

export const PREFIX='dev.rtapp.svc.';

const escape=value=>String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

/** Stable agent label for a project service. */
export function agentLabel(project,serviceId){return PREFIX+createHash('sha256').update(project+'\0'+serviceId).digest('hex').slice(0,12);}

/** launchd property list: runs `command` in `cwd` with `env`, at login, restarted when it exits. */
export function agentPlist({label,command,cwd,env={},logFile}){
 if(!label.startsWith(PREFIX)||!/^[a-z0-9.]+$/.test(label))throw new Error('Invalid agent label');
 if(!Array.isArray(command)||!command.length||command.some(part=>typeof part!=='string'))throw new Error('Invalid command');
 const strings=values=>values.map(v=>`\t\t<string>${escape(v)}</string>`).join('\n');
 const dict=Object.entries(env).map(([k,v])=>`\t\t<key>${escape(k)}</key>\n\t\t<string>${escape(v)}</string>`).join('\n');
 return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${escape(label)}</string>
\t<key>ProgramArguments</key>
\t<array>
${strings(command)}
\t</array>
\t<key>WorkingDirectory</key>
\t<string>${escape(cwd)}</string>
\t<key>EnvironmentVariables</key>
\t<dict>
${dict}
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<dict>
\t\t<key>SuccessfulExit</key>
\t\t<false/>
\t</dict>
\t<key>ThrottleInterval</key>
\t<integer>10</integer>
\t<key>StandardOutPath</key>
\t<string>${escape(logFile)}</string>
\t<key>StandardErrorPath</key>
\t<string>${escape(logFile)}</string>
</dict>
</plist>
`;
}

/** Parse `launchctl list` (PID, status, label) into a label → {pid, status} map. */
export function parseLaunchctlList(text){
 const agents=new Map();
 for(const line of text.split('\n').slice(1)){
  const [pid,status,label]=line.split('\t');
  if(label)agents.set(label.trim(),{pid:pid==='-'?null:Number(pid),status:status==='-'?null:Number(status)});
 }
 return agents;
}

export class LaunchAgents {
 constructor({home=homedir(),managerHome=join(homedir(),'.rt-app','service-manager'),uid=process.getuid?.()??0,exec=promisify(execFileCallback)}={}){
  this.dir=join(home,'Library/LaunchAgents');this.managerHome=managerHome;this.uid=uid;this.exec=exec;
 }
 get domain(){return `gui/${this.uid}`;}
 path(label){return join(this.dir,label+'.plist');}
 async registry(){try{return JSON.parse(await readFile(join(this.managerHome,'background.json'),'utf8'));}catch(e){if(e.code==='ENOENT')return [];throw e;}}
 async saveRegistry(items){await mkdir(this.managerHome,{recursive:true,mode:0o700});await writeFile(join(this.managerHome,'background.json'),JSON.stringify(items,null,2)+'\n',{mode:0o600});}

 /** label → {pid,status} for every agent launchd knows in the user domain. */
 async loaded(){const {stdout}=await this.exec('launchctl',['list']);return parseLaunchctlList(stdout);}

 /** Install and start an agent for a project service (replacing an older definition). */
 async enable({project,serviceId,name,command,cwd,env}){
  const label=agentLabel(project,serviceId),logs=join(this.managerHome,'logs');
  await mkdir(this.dir,{recursive:true});await mkdir(logs,{recursive:true,mode:0o700});
  await this.exec('launchctl',['bootout',`${this.domain}/${label}`]).catch(()=>{});
  await writeFile(this.path(label),agentPlist({label,command,cwd,env,logFile:join(logs,label+'.log')}),{mode:0o644});
  await this.exec('launchctl',['bootstrap',this.domain,this.path(label)]);
  const items=(await this.registry()).filter(i=>i.label!==label);
  await this.saveRegistry([...items,{label,project,serviceId,name,command,cwd}]);
  return label;
 }

 /** Stop and remove one of our agents (the service no longer runs at login). */
 async disable(label){
  if(!label.startsWith(PREFIX))throw new Error('Only RT-App agents can be removed; use detach for others');
  await this.exec('launchctl',['bootout',`${this.domain}/${label}`]).catch(()=>{});
  await rm(this.path(label),{force:true});
  await this.saveRegistry((await this.registry()).filter(i=>i.label!==label));
 }

 /** Stop any user agent and keep it from starting again (reversible with `launchctl enable`). */
 async detach(label){
  if(!/^[A-Za-z0-9._-]+$/.test(label))throw new Error('Invalid agent label');
  if(label.startsWith(PREFIX))return this.disable(label);
  await this.exec('launchctl',['bootout',`${this.domain}/${label}`]).catch(()=>{});
  await this.exec('launchctl',['disable',`${this.domain}/${label}`]);
 }

 /** Our background services with their live state. */
 async list(){
  const [items,loaded]=await Promise.all([this.registry(),this.loaded().catch(()=>new Map())]);
  return items.map(i=>({...i,loaded:loaded.has(i.label),pid:loaded.get(i.label)?.pid??null,lastExit:loaded.get(i.label)?.status??null}));
 }

 /** User LaunchAgent plists that are not ours (for the processes view). */
 async others(){
  let files=[];try{files=await readdir(this.dir);}catch(e){if(e.code!=='ENOENT')throw e;}
  return files.filter(f=>f.endsWith('.plist')&&!f.startsWith(PREFIX)).map(f=>f.slice(0,-6));
 }
}
