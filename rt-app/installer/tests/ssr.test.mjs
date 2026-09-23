import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AmplifyClient} from '@aws-sdk/client-amplify';
import {publishSsr} from '../dist/ssr.js';
const options={region:'us-east-1',repository:'owner/repo',appId:'test',branch:'main',progress:()=>{}};
test('SSR reports missing repository authorization without claiming deployment',async t=>{
 const calls=[];t.mock.method(AmplifyClient.prototype,'send',async command=>{calls.push(command);return {app:{}};});
 assert.deepEqual(await publishSsr(options),{status:'awaiting_repository'});assert.equal(calls.length,1);
 await assert.rejects(()=>publishSsr({...options,requireReady:true}),/Connect/);
});
test('SSR connects once and waits for the exact release revision',async t=>{
 const revision='a'.repeat(40),calls=[];
 t.mock.method(AmplifyClient.prototype,'send',async command=>{
  calls.push(command);
  switch(command.constructor.name){
   case 'GetAppCommand':return {app:{}};
   case 'UpdateAppCommand':return {};
   case 'StartJobCommand':return {jobSummary:{jobId:'42'}};
   case 'GetJobCommand':return {job:{summary:{status:'SUCCEED',commitId:revision}}};
  }
 });
 assert.equal((await publishSsr({...options,revision,token:'setup-token'})).status,'ready');
 assert.equal(calls[1].input.accessToken,'setup-token');assert.equal(calls[2].input.commitId,revision);
});
test('SSR rejects a different repository and a failed build',async t=>{
 t.mock.method(AmplifyClient.prototype,'send',async()=>({app:{repository:'https://github.com/other/repo'}}));
 await assert.rejects(()=>publishSsr(options),/different repository/);
 t.mock.method(AmplifyClient.prototype,'send',async command=>command.constructor.name==='GetAppCommand'?{app:{repository:'https://github.com/owner/repo'}}:command.constructor.name==='StartJobCommand'?{jobSummary:{jobId:'42'}}:{job:{summary:{status:'FAILED'}}});
 await assert.rejects(()=>publishSsr(options),/FAILED/);
});
