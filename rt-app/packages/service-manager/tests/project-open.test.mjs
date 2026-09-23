import test from 'node:test';
import assert from 'node:assert/strict';
import {openProjectLocation} from '../electron/project-open.mjs';
const base={target:'editor',path:'/project with spaces',registry:[{path:'/project with spaces'}],platform:'darwin'};
test('editor prefers Cursor without launching VS Code when successful',async()=>{
 const calls=[];await openProjectLocation({...base,run:async(...args)=>calls.push(args)});
 assert.equal(calls.length,1);assert.equal(calls[0][1][1],'com.todesktop.230313mzl4w4u92');assert.equal(calls[0][1][2],base.path);
});
test('unavailable Cursor falls back to VS Code',async()=>{
 const calls=[];await openProjectLocation({...base,run:async(...args)=>{calls.push(args);if(calls.length===1)throw Error('not installed');}});
 assert.equal(calls.length,2);assert.equal(calls[1][1][1],'com.microsoft.VSCode');
});
test('missing editors open the folder; unregistered paths never launch',async()=>{
 const folders=[];
 await openProjectLocation({...base,run:async()=>{throw Error('missing');},shell:{openPath:async path=>{folders.push(path);return '';}}});
 assert.deepEqual(folders,[base.path]);
 await assert.rejects(openProjectLocation({...base,path:'/other',run:async()=>assert.fail('must not launch')}),/registered project/);
});
test('folder launch failures are reported',async()=>{
 await assert.rejects(openProjectLocation({...base,run:async()=>{throw Error('missing');},shell:{openPath:async()=> 'Folder unavailable'}}),/Folder unavailable/);
});
