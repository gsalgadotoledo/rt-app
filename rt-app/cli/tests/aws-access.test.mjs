import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const script=fileURLToPath(new URL('../aws-access.mjs',import.meta.url));
test('AWS access dry generation refuses root and preserves provisioned multi-environment topology',async()=>{
 const root=await mkdtemp(join(tmpdir(),'rt-access-'));const args=['--app','rt-app-test','--repository','org/repo','--principal','arn:aws:iam::123456789012:role/Operator'];
 try{await mkdir(join(root,'.rt-app'));await writeFile(join(root,'.rt-app/bootstrap.tfstate'),JSON.stringify({resources:[{type:'aws_iam_role',name:'deploy',instances:[{index_key:'stage',attributes:{name:'rt-app-test-stage-github'}}]}]}));
 const result=spawnSync(process.execPath,[script,...args],{cwd:root,encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/No AWS changes/);assert.equal(JSON.parse(await readFile(join(root,'.rt-app/aws-access.tfvars.json'))).multi_environment,true);
 const bad=spawnSync(process.execPath,[script,...args.slice(0,-1),'arn:aws:iam::123456789012:root'],{cwd:root,encoding:'utf8'});assert.notEqual(bad.status,0);
 }finally{await rm(root,{recursive:true,force:true});}
});
