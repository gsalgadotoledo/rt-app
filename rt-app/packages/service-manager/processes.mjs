import {execFile as execFileCallback} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';

/**
 * Development processes running on this computer (Node, Python, Go, Rust, Ruby, Java, Deno, Bun,
 * PHP), owned by the current user, with their listening ports and working folder. Used to see and
 * stop services the manager did not start. System and other users' processes are never listed.
 */

const RUNTIMES=[
 ['node',/(^|\/)(node|nodejs|npm|npx|pnpm|yarn|tsx|ts-node|next-server|vite)(\s|$)/],
 ['python',/(^|\/)(python\d?(\.\d+)?|uvicorn|gunicorn|flask|celery)(\s|$)/],
 ['go',/(^|\/)(go|air)(\s|$)|\/go-build\d+\//],
 ['rust',/(^|\/)(cargo|rustc)(\s|$)|\/target\/(debug|release)\//],
 ['ruby',/(^|\/)(ruby|rails|puma|bundle)(\s|$)/],
 ['java',/(^|\/)(java|gradle|mvn)(\s|$)/],
 ['deno',/(^|\/)deno(\s|$)/],
 ['bun',/(^|\/)bun(\s|$)/],
 ['php',/(^|\/)(php|php-fpm)(\s|$)/],
];

/** Runtime of a command line, or undefined for anything else. */
export function runtimeOf(args){for(const [runtime,pattern] of RUNTIMES)if(pattern.test(args))return runtime;}

/** Parse `ps -axo pid=,ppid=,uid=,pcpu=,rss=,etime=,args=`. */
export function parsePs(text){
 return text.split('\n').map(line=>line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.+)$/)).filter(Boolean)
  .map(([,pid,ppid,uid,cpu,rss,elapsed,args])=>({pid:Number(pid),ppid:Number(ppid),uid:Number(uid),cpu:Number(cpu),memoryMb:Math.round(Number(rss)/1024),elapsed,args}));
}

/** Parse `lsof -nP -iTCP -sTCP:LISTEN -F pn` into pid → ports. */
export function parseListening(text){
 const ports=new Map();let pid;
 for(const line of text.split('\n')){
  if(line.startsWith('p'))pid=Number(line.slice(1));
  else if(line.startsWith('n')&&pid){const port=Number(line.slice(line.lastIndexOf(':')+1));if(port){const list=ports.get(pid)??[];if(!list.includes(port))list.push(port);ports.set(pid,list);}}
 }
 return ports;
}

/** Parse `lsof -a -d cwd -F pn -p …` into pid → working directory. */
export function parseCwd(text){
 const cwd=new Map();let pid;
 for(const line of text.split('\n')){if(line.startsWith('p'))pid=Number(line.slice(1));else if(line.startsWith('n')&&pid)cwd.set(pid,line.slice(1));}
 return cwd;
}

export class MachineProcesses {
 constructor({exec=promisify(execFileCallback),uid=process.getuid?.()??0,self=process.pid,kill=(pid,signal)=>process.kill(pid,signal),alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}}}={}){
  this.exec=exec;this.uid=uid;this.self=self;this.kill=kill;this.alive=alive;
 }

 /**
  * Current user's development processes with ports, folder and launchd label. `known` marks the
  * ones that belong to a known project folder or supervisor (pids), so the UI can say "ours".
  */
 async list({projects=[],managedPids=new Set(),launchd=new Map()}={}){
  const {stdout}=await this.exec('ps',['-axo','pid=,ppid=,uid=,pcpu=,rss=,etime=,args='],{maxBuffer:16*1024*1024});
  const candidates=parsePs(stdout).filter(p=>p.uid===this.uid&&p.pid!==this.self).map(p=>({...p,runtime:runtimeOf(p.args)})).filter(p=>p.runtime);
  if(!candidates.length)return [];
  const pids=candidates.map(p=>p.pid).join(',');
  const [listening,cwds]=await Promise.all([
   this.exec('lsof',['-nP','-iTCP','-sTCP:LISTEN','-F','pn','-a','-p',pids]).then(r=>parseListening(r.stdout),()=>new Map()),
   this.exec('lsof',['-a','-d','cwd','-F','pn','-p',pids]).then(r=>parseCwd(r.stdout),()=>new Map()),
  ]);
  const byPid=new Map([...launchd].filter(([,v])=>v.pid).map(([label,v])=>[v.pid,label]));
  return candidates.map(p=>{
   const cwd=cwds.get(p.pid)??null;
   const project=projects.find(project=>cwd&&(cwd===project.path||cwd.startsWith(project.path+'/')));
   return {...p,ports:(listening.get(p.pid)??[]).sort((a,b)=>a-b),cwd,project:project?.name??null,managed:managedPids.has(p.pid),launchdLabel:byPid.get(p.pid)??null};
  }).sort((a,b)=>b.ports.length-a.ports.length||a.runtime.localeCompare(b.runtime)||a.pid-b.pid);
 }

 /** Stop a process: SIGTERM, then SIGKILL after `graceMs`. Only the current user's dev processes. */
 async stop(pid,{graceMs=5000}={}){
  const list=await this.list();
  const target=list.find(p=>p.pid===pid);
  if(!target)throw new Error('Not a running development process of this user');
  this.kill(pid,'SIGTERM');
  for(let waited=0;waited<graceMs;waited+=100){if(!this.alive(pid))return {pid,stopped:'SIGTERM'};await delay(100);}
  this.kill(pid,'SIGKILL');
  return {pid,stopped:'SIGKILL'};
 }
}
