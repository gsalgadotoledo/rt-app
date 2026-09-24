import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProviderRegistry} from '@gsalgadotoledo/rt-app-deploy';
import {awsProvider} from '@gsalgadotoledo/rt-app-deployments';
import {deployInfo,connectProject} from '../deploy.mjs';
import {initializerCommand,streamCommand,ProjectWizard} from '../projects.mjs';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';

test('deploy overview lists providers, targets and key presence without values',async t=>{
 const root=await mkdtemp(join(tmpdir(),'sm-deploy-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(join(root,'rt-app.settings.json'),JSON.stringify({version:1,deploy:{environments:{stage:{api:{provider:'aws'}}}}}));
 const run=(cmd,args)=>cmd==='git'?{status:0,stdout:'https://github.com/acme/shop.git',stderr:''}:{status:0,stdout:'',stderr:''};
 const info=await deployInfo(root,{run,registry:new ProviderRegistry().register(awsProvider)});
 assert.deepEqual(info.environments.map(e=>[e.id,e.branch]),[['develop','develop'],['stage','stage'],['prod','main']]);
 assert.deepEqual(info.environments[1].targets,{api:{provider:'aws'}});
 assert.equal(info.repository,'acme/shop');
 assert.equal(info.roles.length,5);
 assert.deepEqual(connectProject(root,{run}),{repository:'acme/shop',created:false});
 const full=await deployInfo(root,{run});
 assert.ok(['render','vercel','neon','railway','flyio','digitalocean','heroku','supabase'].every(id=>full.providers.some(p=>p.id===id)));
});

test('initializer command is the pinned npx package unless explicitly overridden',()=>{
 const [npx,yes,pkg]=initializerCommand({});
 assert.deepEqual([npx,yes],['npx','--yes']);assert.match(pkg,/^@gsalgadotoledo\/create-rt-app@\d+\.\d+\.\d+/);
 assert.deepEqual(initializerCommand({RT_APP_CREATE_COMMAND:'["node","/x/create-rt-app.mjs"]'}),['node','/x/create-rt-app.mjs']);
 for(const bad of ['not json','[]','[1]','{"a":1}'])assert.throws(()=>initializerCommand({RT_APP_CREATE_COMMAND:bad}),/JSON array/);
});

function fakeSpawn(lines,code,calls){return (command,args,options)=>{calls.push({command,args,cwd:options.cwd});const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();setImmediate(()=>{child.stdout.write(lines.join('\n'));child.stderr.write('warn: partial');child.stdout.end();child.stderr.end();setImmediate(()=>child.emit('close',code));});return child;};}

test('streamCommand forwards complete lines from stdout and stderr',async()=>{
 const log=[],calls=[];
 assert.equal(await streamCommand('npx',['a'],{cwd:'/w',env:{},log:l=>log.push(l),spawn:fakeSpawn(['one','','two'],0,calls)}),0);
 assert.deepEqual(log.sort(),['one','two','warn: partial'].sort());
});

test('wizard creates through the initializer, logs the command and opens the project',async t=>{
 const home=await mkdtemp(join(tmpdir(),'sm-home-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const selected=[],calls=[];
 const wizard=new ProjectWizard({home,select:async p=>selected.push(p)},{env:{RT_APP_CREATE_COMMAND:'["node","/bin/create-rt-app.mjs"]'},spawn:fakeSpawn(['Created shop'],0,calls)});
 wizard.tools={status:async()=>[{id:'node',required:true,ready:true}],environment:async()=>({PATH:'/tools'})};
 const settle=async()=>{while(wizard.job.state==='running')await new Promise(r=>setTimeout(r,5));};
 wizard.create({name:'shop',templateId:'fullstack'});await settle();
 assert.match(wizard.job.error,/Choose a workspace first/);
 wizard.workspace=home;
 wizard.create({name:'shop',templateId:'saas-credits'});await settle();
 assert.equal(wizard.job.state,'done',wizard.job.error);
 assert.deepEqual(calls[0],{command:'node',args:['/bin/create-rt-app.mjs','shop','--template','saas-credits','--backend','node-ts','--dir',home],cwd:home});
 assert.equal(wizard.job.log[0],`$ node /bin/create-rt-app.mjs shop --template saas-credits --backend node-ts --dir ${home}`);
 assert.deepEqual(selected,[join(home,'shop')]);
 wizard.spawn=fakeSpawn(['npm error 404'],1,[]);
 wizard.create({name:'shop2',templateId:'fullstack'});await settle();
 assert.match(wizard.job.error,/exit 1/);
 wizard.tools.status=async()=>[{id:'node',required:true,ready:false}];
 wizard.create({name:'shop3',templateId:'fullstack'});await settle();
 assert.match(wizard.job.error,/Install missing requirements/);
 const status=await wizard.status('saas-credits');
 assert.ok(status.templates.find(t=>t.id==='saas-credits').prompt.includes('consumeUsage'));
 assert.equal(status.initializer,'node /bin/create-rt-app.mjs');
});

test('settings.json createCommand selects a local initializer unless the environment overrides it',async t=>{
 const home=await mkdtemp(join(tmpdir(),'sm-settings-'));t.after(()=>rm(home,{recursive:true,force:true}));
 await writeFile(join(home,'settings.json'),JSON.stringify({version:1,createCommand:['node','/repo/create-rt-app.mjs']}));
 const wizard=new ProjectWizard({home},{env:{}});wizard.activateTools=async()=>{};
 await wizard.initialize();
 assert.deepEqual(initializerCommand(wizard.env),['node','/repo/create-rt-app.mjs']);
 const pinned=new ProjectWizard({home},{env:{RT_APP_CREATE_COMMAND:'["x"]'}});pinned.activateTools=async()=>{};
 await pinned.initialize();
 assert.deepEqual(initializerCommand(pinned.env),['x']);
 const fresh=new ProjectWizard({home:join(home,'missing')},{env:{}});fresh.activateTools=async()=>{};
 await fresh.initialize();
 assert.equal(fresh.env.RT_APP_CREATE_COMMAND,undefined);
});
