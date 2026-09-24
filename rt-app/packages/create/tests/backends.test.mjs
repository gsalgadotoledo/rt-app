import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createProject,backends} from '../index.mjs';
test('each backend records requirements, executable entry point and accurate deployment support',async()=>{
 const workspace=await mkdtemp(join(tmpdir(),'rt-backends-'));
 try{for(const b of backends){const result=await createProject({workspace,name:'app-'+b.id,backendId:b.id,install:false});const settings=JSON.parse(await readFile(join(result.path,'rt-app.settings.json')));assert.equal(settings.backend,b.id);assert.equal(JSON.parse(await readFile(join(result.path,'package.json'))).dependencies['@gsalgadotoledo/rt-app-core'],'0.1.0');if(b.id==='go')assert.match(await readFile(join(result.path,'apps/backend-go/go.mod'),'utf8'),/replace rt.local\/core-go/);if(b.id==='python')assert.match(await readFile(join(result.path,'apps/backend-python/setup.mjs'),'utf8'),/core-python/);for(const tool of b.tools)assert.ok(settings.requirements[tool]);const pkg=JSON.parse(await readFile(join(result.path,'package.json')));if(b.id==='node-ts')assert.equal(pkg.rtApp.backend,'@gsalgadotoledo/rt-app-server');else{assert.equal(pkg.rtApp.backend,'@app/backend-'+b.id);assert.match(await readFile(join(result.path,'apps/backend-'+b.id+'/run.mjs'),'utf8'),/spawn/);assert.match(pkg.scripts['lambda:build'],/native-deploy-pending/);await assert.rejects(readFile(join(result.path,'.github/workflows/deploy.yml')));}}await assert.rejects(createProject({workspace,name:'invalid-backend',backendId:'ruby',install:false}),/Unknown backend/);await assert.rejects(readFile(join(workspace,'invalid-backend/package.json')));
 }finally{await rm(workspace,{recursive:true,force:true});}
});
