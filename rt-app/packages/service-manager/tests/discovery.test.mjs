import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {discover} from '../discovery.mjs';
test('discovers a non-npm root and nested Go/Python/Electron without executing or entering dependencies',async()=>{
 const root=await mkdtemp(join(tmpdir(),'rt-discovery-'));
 try{for(const [path,content] of Object.entries({'go.mod':'module example','main.go':'package main','python/pyproject.toml':'','python/main.py':'raise Exception("must not execute")','desktop/package.json':JSON.stringify({name:'desktop',scripts:{dev:'electron .'},devDependencies:{electron:'*'}}),'node_modules/hidden/package.json':JSON.stringify({scripts:{dev:'should never run'}})})){await mkdir(join(root,path,'..'),{recursive:true});await writeFile(join(root,path),content);}
 const items=await discover(root);assert.equal(items.length,3);assert.ok(items.some(i=>i.command[0]==='go'));assert.ok(items.some(i=>i.command[0]==='python3'));assert.ok(items.some(i=>i.label.includes('Electron')));assert.deepEqual(await discover(root),items);
 }finally{await rm(root,{recursive:true,force:true});}
});
