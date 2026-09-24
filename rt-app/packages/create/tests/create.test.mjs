import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,access,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {templates,createProject,copyStarter,projectName} from '../index.mjs';
test('all built-in templates generate independently without credentials, state or fixed ports',async()=>{
 const workspace=await mkdtemp(join(tmpdir(),'rt-template-test-'));
 try{for(const item of await templates()){
  const result=await createProject({workspace,name:'test-'+item.id,templateId:item.id,install:false});const settings=JSON.parse(await readFile(join(result.path,'rt-app.settings.json')));
  const readme=await readFile(join(result.path,'README.md'),'utf8');assert.ok(readme.split('\n').length<25);await access(join(result.path,'CLAUDE.md'));await assert.rejects(access(join(result.path,'PROJECT.md')));await assert.rejects(access(join(result.path,'docs')));assert.equal(settings.project.template,item.id);assert.equal(settings.local,undefined);assert.equal(settings.requirements.node,'24');
  await assert.rejects(access(join(result.path,'rt-app')));await assert.rejects(access(join(result.path,'package-lock.json')));await assert.rejects(access(join(result.path,'.rt-app')));await assert.rejects(access(join(result.path,'node_modules')));await assert.rejects(access(join(result.path,'apps/ssr/.next')));
  for(const crud of item.crud??[])await access(join(result.path,'packages',crud.name,'src/schema.json'));
  if(item.kind==='electron')await access(join(result.path,'apps/desktop/main.mjs'));
  if(item.kind==='mobile')await access(join(result.path,'apps/mobile/App.js'));
  await assert.rejects(createProject({workspace,name:'test-'+item.id,install:false}),/EEXIST/);
 }}finally{await rm(workspace,{recursive:true,force:true});}
});
test('copy filtering excludes secrets and rejects symlinks; project names cannot escape workspace',async()=>{
 const root=await mkdtemp(join(tmpdir(),'rt-filter-'));try{const src=join(root,'src'),out=join(root,'out');await mkdir(join(src,'apps/a'),{recursive:true});await writeFile(join(src,'apps/a/.env.local'),'SECRET');await writeFile(join(src,'apps/a/data.sqlite'),'SECRET');await writeFile(join(src,'apps/a/index.js'),'safe');await mkdir(out);await copyStarter(src,out);assert.equal(await readFile(join(out,'apps/a/index.js'),'utf8'),'safe');await assert.rejects(access(join(out,'apps/a/.env.local')));await assert.rejects(access(join(out,'apps/a/data.sqlite')));await symlink('/tmp',join(src,'apps/a/link'));await assert.rejects(copyStarter(src,join(root,'second')),/symbolic link/);for(const name of ['../escape','/tmp/x','a/b','a b','con',''])assert.throws(()=>projectName(name));}finally{await rm(root,{recursive:true,force:true});}
});
