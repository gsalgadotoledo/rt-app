import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {packageManager,listWorkspaces,scriptCommand} from '../client.mjs';

async function project(t,files){
 const root=await mkdtemp(join(tmpdir(),'sm-pm-'));t.after(()=>rm(root,{recursive:true,force:true}));
 for(const [path,content] of Object.entries(files)){await mkdir(join(root,path,'..'),{recursive:true});await writeFile(join(root,path),typeof content==='string'?content:JSON.stringify(content));}
 return root;
}

test('packageManager: declared field first, then lock/workspace files, npm by default',async t=>{
 assert.equal(await packageManager(await project(t,{'package.json':{packageManager:'pnpm@10.0.0'}})),'pnpm');
 assert.equal(await packageManager(await project(t,{'package.json':{},'pnpm-workspace.yaml':'packages: []\n'})),'pnpm');
 assert.equal(await packageManager(await project(t,{'package.json':{},'yarn.lock':''})),'yarn');
 assert.equal(await packageManager(await project(t,{'package.json':{packageManager:'yarn@4.1.0'},'pnpm-lock.yaml':''})),'yarn','the declared manager wins');
 assert.equal(await packageManager(await project(t,{'package.json':{}})),'npm');
});

test('listWorkspaces reads pnpm-workspace.yaml globs without running pnpm',async t=>{
 const root=await project(t,{
  'package.json':{name:'root',packageManager:'pnpm@10.0.0'},
  'pnpm-workspace.yaml':"packages:\n  - apps/*\n  - 'packages/*' # shared\n  - native/crates/bridge\n  - '!apps/ignored'\nonlyBuiltDependencies:\n  - esbuild\n",
  'apps/server/package.json':{name:'@x/server',scripts:{dev:'node server.js'}},
  'apps/spa/package.json':{name:'@x/spa'},
  'apps/node_modules/package.json':{name:'never'},
  'packages/ui/package.json':{name:'@x/ui'},
  'native/crates/bridge/package.json':{name:'@x/bridge'},
  'docs/package.json':{name:'@x/docs'},
 });
 const workspaces=await listWorkspaces(root);
 assert.deepEqual(workspaces.map(w=>w.name).sort(),['@x/bridge','@x/server','@x/spa','@x/ui']);
 assert.deepEqual(workspaces.find(w=>w.name==='@x/server'),{name:'@x/server',scripts:{dev:'node server.js'},location:join('apps','server')});
});

test('listWorkspaces reads yarn workspaces from package.json',async t=>{
 const root=await project(t,{'package.json':{name:'root',workspaces:{packages:['apps/*']}},'yarn.lock':'','apps/api/package.json':{name:'@y/api'}});
 assert.deepEqual((await listWorkspaces(root)).map(w=>w.name),['@y/api']);
});

test('scriptCommand uses each manager\'s workspace syntax',()=>{
 assert.deepEqual(scriptCommand('npm','dev','@x/api'),['npm','run','dev','--workspace','@x/api']);
 assert.deepEqual(scriptCommand('pnpm','dev','@x/api'),['pnpm','--filter','@x/api','run','dev']);
 assert.deepEqual(scriptCommand('yarn','dev','@x/api'),['yarn','workspace','@x/api','run','dev']);
 assert.deepEqual(scriptCommand('pnpm','build'),['pnpm','run','build']);
});
