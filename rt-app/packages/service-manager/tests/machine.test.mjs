import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {detectProject,projectName,genericServices,genericManifest,excludeFromGit,scanWorkspace} from '../stacks.mjs';
import {LaunchAgents,agentLabel,agentPlist,parseLaunchctlList,PREFIX} from '../launchd.mjs';
import {MachineProcesses,runtimeOf,parsePs,parseListening,parseCwd} from '../processes.mjs';
import {adminFor} from '../admins.mjs';

async function folder(t,files){
 const root=await mkdtemp(join(tmpdir(),'sm-stack-'));t.after(()=>rm(root,{recursive:true,force:true}));
 for(const [path,content] of Object.entries(files)){await mkdir(join(root,path,'..'),{recursive:true});await writeFile(join(root,path),content);}
 return root;
}

test('stacks: projects of any language are detected by their manifests',async t=>{
 const ws=await folder(t,{
  'rt/rt-app.settings.json':JSON.stringify({version:1}),'rt/package.json':'{"name":"rt"}',
  'py/pyproject.toml':'[project]\nname = "py-api"\n','go-api/go.mod':'module x','go-api/main.go':'package main',
  'rusty/Cargo.toml':'[package]\nname = "rusty"\n','cpp/Makefile':'run:\n\t./app\n','web/package.json':JSON.stringify({name:'web',scripts:{dev:'vite'}}),
  'notes/readme.md':'# not a project','.hidden/package.json':'{}',
 });
 const projects=await scanWorkspace(ws);
 assert.deepEqual(projects.map(p=>[p.name,p.kind,p.runtimes.join('+')]),[['cpp','generic','cpp'],['go-api','generic','go'],['py-api','generic','python'],['rt','rt-app','node'],['rusty','generic','rust'],['web','generic','node']]);
 assert.equal(await detectProject(join(ws,'notes')),undefined);
 assert.deepEqual(await detectProject(await folder(t,{'rt-app.settings.json':JSON.stringify({version:1,backend:'python'})})),{kind:'rt-app',runtimes:['python']});
 assert.equal(await projectName(join(ws,'notes'),'fallback'),'fallback');
 assert.deepEqual(await scanWorkspace(join(ws,'missing')),[]);
});

test('stacks: generic services come from conventions and never execute anything',async t=>{
 const root=await folder(t,{'package.json':JSON.stringify({name:'web',scripts:{start:'node server.js'}}),'Cargo.toml':'','Makefile':'run:\n\techo','api/go.mod':'module x','api/main.go':'package main'});
 const services=await genericServices(root);
 assert.deepEqual(services.map(s=>[s.cwd,s.command.join(' ')]),[['.','npm run start'],['.','cargo run'],['.','make run'],['api','go run .']]);
 const manifest=genericManifest([...services,{...services[0],id:'off',enabled:false}],{PATH:'/bin'});
 assert.equal(manifest.services.length,4);
 assert.deepEqual(manifest.services[0].env,{PATH:'/bin'});
 assert.deepEqual(await genericServices(await folder(t,{'Makefile':'build:\n\tcc'})),[],'no run target, nothing to start');
});

test('stacks: .rt-app is excluded locally from git once, without touching .gitignore',async t=>{
 const root=await folder(t,{'.git/HEAD':'ref','.gitignore':'node_modules\n'});
 assert.equal(await excludeFromGit(root),true);
 assert.equal(await excludeFromGit(root),false);
 assert.match(await readFile(join(root,'.git/info/exclude'),'utf8'),/^\.rt-app\/$/m);
 assert.equal(await readFile(join(root,'.gitignore'),'utf8'),'node_modules\n');
 assert.equal(await excludeFromGit(await folder(t,{'a':''})),false,'not a git repo');
 const withExclude=await folder(t,{'.git/info/exclude':'*.log'});
 assert.equal(await excludeFromGit(withExclude),true);
 assert.equal(await readFile(join(withExclude,'.git/info/exclude'),'utf8'),'*.log\n# RT-App Service Manager (local supervisor state)\n.rt-app/\n');
});

test('launchd: plist, labels and parsing',()=>{
 const label=agentLabel('/p','api');
 assert.ok(label.startsWith(PREFIX));assert.equal(label,agentLabel('/p','api'));assert.notEqual(label,agentLabel('/p','web'));
 const plist=agentPlist({label,command:['node','a&b.js'],cwd:'/p/<x>',env:{PATH:'/bin'},logFile:'/l.log'});
 assert.match(plist,/<string>a&amp;b.js<\/string>/);assert.match(plist,/<string>\/p\/&lt;x&gt;<\/string>/);assert.match(plist,/<key>RunAtLoad<\/key>\n\t<true\/>/);
 assert.throws(()=>agentPlist({label:'com.evil',command:['x'],cwd:'/',logFile:'/l'}),/Invalid agent label/);
 assert.throws(()=>agentPlist({label,command:[],cwd:'/',logFile:'/l'}),/Invalid command/);
 const list=parseLaunchctlList('PID\tStatus\tLabel\n123\t0\tdev.rtapp.svc.abc\n-\t78\tcom.other\n');
 assert.deepEqual(list.get('dev.rtapp.svc.abc'),{pid:123,status:0});assert.deepEqual(list.get('com.other'),{pid:null,status:78});
});

test('launchd: enable, list, disable and detach use the user domain only',async t=>{
 const home=await folder(t,{}),calls=[];
 const exec=async(cmd,args)=>{calls.push([cmd,...args].join(' '));if(args[0]==='list')return {stdout:'PID\tStatus\tLabel\n555\t0\t'+agentLabel('/proj','api')+'\n'};return {stdout:''};};
 const agents=new LaunchAgents({home,managerHome:join(home,'.rt-app'),uid:501,exec});
 const label=await agents.enable({project:'/proj',serviceId:'api',name:'API',command:['node','server.js'],cwd:'/proj',env:{PATH:'/bin'}});
 await access(join(home,'Library/LaunchAgents',label+'.plist'));
 assert.ok(calls.includes(`launchctl bootstrap gui/501 ${join(home,'Library/LaunchAgents',label+'.plist')}`));
 assert.deepEqual((await agents.list()).map(a=>[a.name,a.loaded,a.pid]),[['API',true,555]]);
 await writeFile(join(home,'Library/LaunchAgents/com.other.app.plist'),'');
 assert.deepEqual(await agents.others(),['com.other.app']);
 await agents.detach('com.other.app');
 assert.ok(calls.includes('launchctl disable gui/501/com.other.app'),'others are disabled, not deleted');
 await access(join(home,'Library/LaunchAgents/com.other.app.plist'));
 await assert.rejects(agents.detach('bad label;rm'),/Invalid agent label/);
 await assert.rejects(agents.disable('com.other.app'),/Only RT-App agents/);
 await agents.detach(label);
 await assert.rejects(access(join(home,'Library/LaunchAgents',label+'.plist')));
 assert.deepEqual(await agents.list(),[]);
});

test('processes: runtimes, parsing and the current user only',async()=>{
 assert.equal(runtimeOf('/usr/local/bin/node server.js'),'node');assert.equal(runtimeOf('python3 -m uvicorn app:app'),'python');
 assert.equal(runtimeOf('/private/var/folders/x/go-build123/b001/exe/main'),'go');assert.equal(runtimeOf('./target/release/api'),'rust');
 assert.equal(runtimeOf('/usr/sbin/sshd'),undefined);assert.equal(runtimeOf('/Applications/Nodes.app/x'),undefined);
 const ps='  10     1   501   1.5  20480 01:02 node /p/server.js\n  11     1     0   0.0   1024 00:10 node /root.js\n  12     1   501   0.0   2048 00:05 /usr/sbin/sshd\n  13     1   501   0.0   4096 00:05 python3 app.py\n';
 assert.equal(parsePs(ps).length,4);
 assert.deepEqual([...parseListening('p10\nn*:3000\nn127.0.0.1:3000\nn[::1]:3001\np13\nn*:8000\n')],[[10,[3000,3001]],[13,[8000]]]);
 assert.deepEqual([...parseCwd('p10\nn/p\np13\nn/q\n')],[[10,'/p'],[13,'/q']]);
 const killed=[];let alive=new Set([10]);
 const machine=new MachineProcesses({uid:501,self:999,exec:async(cmd,args)=>cmd==='ps'?{stdout:ps}:args.includes('-iTCP')?{stdout:'p10\nn*:3000\n'}:{stdout:'p10\nn/p/app\np13\nn/elsewhere\n'},kill:(pid,signal)=>{killed.push([pid,signal]);if(signal==='SIGKILL')alive.delete(pid);},alive:pid=>alive.has(pid)});
 const list=await machine.list({projects:[{path:'/p',name:'shop'}],managedPids:new Set([10]),launchd:new Map([['com.x',{pid:13}]])});
 assert.deepEqual(list.map(p=>[p.pid,p.runtime,p.ports,p.project,p.managed,p.launchdLabel]),[[10,'node',[3000],'shop',true,null],[13,'python',[],null,false,'com.x']],'root-owned and non-dev processes are excluded');
 assert.deepEqual(await machine.stop(10,{graceMs:200}),{pid:10,stopped:'SIGKILL'});
 assert.deepEqual(killed,[[10,'SIGTERM'],[10,'SIGKILL']]);
 await assert.rejects(machine.stop(11),/Not a running development process/,'another user\'s process is never killed');
 alive=new Set();assert.deepEqual(await machine.stop(13,{graceMs:200}),{pid:13,stopped:'SIGTERM'});
 const empty=new MachineProcesses({uid:501,exec:async()=>({stdout:'  12     1   501   0.0   2048 00:05 /usr/sbin/sshd\n'})});
 assert.deepEqual(await empty.list(),[]);
});

test('admins: open own UI, start or install a tool, or explain',()=>{
 assert.deepEqual(adminFor({id:'mail',url:'http://localhost:8025'}),{kind:'url',url:'http://localhost:8025'});
 assert.deepEqual(adminFor({id:'postgres',catalogId:'postgres'}),{kind:'install',tool:'pgweb',name:'pgweb',description:'Web-based PostgreSQL browser (single binary, official release).'});
 assert.deepEqual(adminFor({id:'postgres'},{installed:['pgweb']}),{kind:'start',tool:'pgweb',name:'pgweb'});
 assert.deepEqual(adminFor({id:'postgres'},{installed:['pgweb'],running:{pgweb:'http://localhost:8081'}}),{kind:'url',url:'http://localhost:8081'});
 assert.equal(adminFor({id:'redis'}).kind,'none');
 assert.equal(adminFor({id:'api'}).kind,'none');
});
