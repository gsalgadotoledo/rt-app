import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {watchCommand} from '../templates/backends/watch.mjs';

test('native dev watcher reloads source, ignores dependencies and stops its child', {timeout:10000}, async()=>{
 const root=await mkdtemp(join(tmpdir(),'rt-native-watch-'));const output=join(root,'runs.txt');const controller=new AbortController();
 let work;
 const runs=async()=>{try{return (await readFile(output,'utf8')).trim().split('\n').filter(Boolean);}catch{return [];}};
 async function wait(n){for(let i=0;i<100;i++){if((await runs()).length>=n)return;await delay(30);}throw new Error('Watcher did not restart');}
 try{
  await writeFile(join(root,'main.go'),'first');await mkdir(join(root,'node_modules'));
  work=watchCommand([process.execPath,'-e',`require('node:fs').appendFileSync(${JSON.stringify(output)},process.pid+'\\n');setInterval(()=>{},1000)`],{roots:[root],interval:30,signal:controller.signal});
  await wait(1);await writeFile(join(root,'node_modules/ignore.py'),'ignored');await delay(100);assert.equal((await runs()).length,1);
  await writeFile(join(root,'main.go'),'second-longer');await wait(2);
  controller.abort();await work;
  for(const pid of await runs())assert.throws(()=>process.kill(Number(pid),0));
 }finally{controller.abort();await work;await rm(root,{recursive:true,force:true});}
});
