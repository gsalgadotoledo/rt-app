import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {localSecret} from '../dist/local-secret.js';
test('local authentication key persists independently of the admin password and fails on corrupt storage',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'rta-local-key-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=join(dir,'db.json');
 const first=await localSecret(file);assert.equal(await localSecret(file),first);assert.equal(first.length,96);assert.equal((await stat(file+'.key')).mode&0o777,0o600);
 await writeFile(file+'.key','broken');await assert.rejects(localSecret(file),/Invalid local auth key/);
});
