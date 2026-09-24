import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {projectCommands,commandSpec} from '../commands.mjs';

test('command catalog reads all scripts and explicit Go/Python commands without running them',async t=>{
 const root=await mkdtemp(join(tmpdir(),'rt-commands-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 for(const [path,data] of Object.entries({
  'package.json':{name:'root',scripts:{build:'never execute',test:'exit 19'}},
  'apps/spa/package.json':{name:'spa',scripts:{dev:'vite',test:'node --test',build:'vite build'}},
  'apps/go/rt-app.commands.json':{version:1,name:'Go API',commands:{dev:{command:['go','run','.']},test:{command:['go','test','./...']}}},
  'node_modules/hidden/package.json':{scripts:{danger:'must not appear'}},
 })){
  await mkdir(join(root,path,'..'),{recursive:true});await writeFile(join(root,path),JSON.stringify(data));
 }
 const services=[{id:'spa',cwd:'.',command:['npm','run','dev','--workspace','spa'],env:{PORT:'5000'},inheritEnv:['TEST_SECRET']},{id:'admin',cwd:'.',command:['node','rta.mjs','admin']}];
 const groups=await projectCommands(root,services);
 assert.equal(groups.length,4);
 const spa=groups.find(g=>g.label==='spa');
 assert.deepEqual(await commandSpec(root,spa.commands.find(c=>c.name==='dev').id,services),{serviceId:'spa'});
 const spec=(await commandSpec(root,spa.commands.find(c=>c.name==='test').id,services)).spec;
 assert.deepEqual(spec.command,['npm','run','test']);assert.equal(spec.cwd,'apps/spa');
 assert.equal(spec.enabled,false);assert.deepEqual(spec.env,{PORT:'5000'});assert.deepEqual(spec.dependencies,[]);
 assert.equal(groups.find(g=>g.label==='Go API').commands.length,2);
 assert.equal(groups.find(g=>g.id==='installed-admin').commands[0].serviceId,'admin');
 await assert.rejects(commandSpec(root,'invented',services),/no longer exists/);
 await writeFile(join(root,'apps/go/rt-app.commands.json'),JSON.stringify({version:1,commands:{bad:{command:'shell string'}}}));
 await assert.rejects(projectCommands(root),/Invalid command/);
 await writeFile(join(root,'apps/go/rt-app.commands.json'),JSON.stringify({version:2}));
 await assert.rejects(projectCommands(root),/Invalid commands manifest/);
});

test('command discovery skips symlink directories outside the project',async t=>{
 const root=await mkdtemp(join(tmpdir(),'rt-commands-links-'));
 const outside=await mkdtemp(join(tmpdir(),'rt-outside-'));
 t.after(async()=>{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});});
 await writeFile(join(outside,'package.json'),JSON.stringify({scripts:{test:'exit 1'}}));
 await symlink(outside,join(root,'outside'),'dir');
 assert.deepEqual(await projectCommands(root),[]);
});
