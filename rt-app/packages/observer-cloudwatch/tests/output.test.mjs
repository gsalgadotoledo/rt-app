import test from 'node:test';import assert from 'node:assert/strict';import {CloudWatchOutput} from '../dist/index.js';
test('AWS adapter forwards sanitized events and cancellation to the configured client',async()=>{
 const commands=[],client={send:async(command,options)=>{commands.push({input:command.input,options});return {};}};
 const signal=new AbortController().signal;
 await new CloudWatchOutput('/test/observer','events',client).write({id:'test',at:new Date().toISOString(),level:'error',kind:'log',category:'payments',source:'app',message:'Declined',data:{}},signal);
 assert.equal(commands.length,1);assert.equal(commands[0].options.abortSignal,signal);assert.match(JSON.stringify(commands[0].input),/Declined/);
});

import {CloudWatchLogReader} from '../dist/index.js';
test('search scopes the group, preserves empty pagination and escapes filter values',async()=>{
 let input;const reader=new CloudWatchLogReader('/test/observer',{send:async command=>{input=command.input;return {events:[],nextToken:'next'};}});
 const page=await reader.search({day:'2026-09-24',category:'pay"ment'});
 assert.equal(page.cursor,'next');assert.equal(input.logGroupName,'/test/observer');assert.equal(input.limit,100);assert.ok(input.filterPattern.includes(JSON.stringify('pay"ment')));
});
