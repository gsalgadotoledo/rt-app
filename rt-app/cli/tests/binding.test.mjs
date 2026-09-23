import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('installation binding permits expansion and rejects shrinking or legacy resource renames',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'rta-binding-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const moduleURL=new URL('../dist/host.js',import.meta.url).href;
 const identity={account:'123456789012',app:'rt-app-test',region:'us-east-1',repository:'owner/repo'};
 const bind=multiEnvironment=>spawnSync(process.execPath,['--input-type=module','-e',`import {host} from ${JSON.stringify(moduleURL)};await host.bindInstallation(${JSON.stringify({...identity,multiEnvironment})});`],{cwd:dir,encoding:'utf8'});
 assert.equal(bind(false).status,0);assert.equal(bind(true).status,0);
 const shrink=bind(false);assert.equal(shrink.status,1);assert.match(shrink.stderr,/Removing environments/);
 await writeFile(join(dir,'.rt-app/bootstrap.tfstate'),JSON.stringify({resources:[{type:'aws_iam_role',name:'deploy',instances:[{index_key:'dev'}]}]}));
 const legacy=bind(true);assert.equal(legacy.status,1);assert.match(legacy.stderr,/Legacy dev\/prod/);
});
