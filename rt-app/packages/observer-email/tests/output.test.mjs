import test from 'node:test';import assert from 'node:assert/strict';import {EmailOutput} from '../dist/index.js';
test('AWS adapter forwards sanitized events and cancellation to the configured client',async()=>{
 const commands=[],client={send:async(command,options)=>{commands.push({input:command.input,options});return {};}};
 const signal=new AbortController().signal;
 await new EmailOutput('sender@example.test','ops@example.test',client).write({id:'test',at:new Date().toISOString(),level:'error',kind:'log',category:'payments',source:'app',message:'Declined',data:{}},signal);
 assert.equal(commands.length,1);assert.equal(commands[0].options.abortSignal,signal);assert.match(JSON.stringify(commands[0].input),/Declined/);
});
