import test from 'node:test';
import assert from 'node:assert/strict';
import {EmailOutput} from '@gsalgadotoledo/rt-app-observer-email';
import {SmsOutput} from '@gsalgadotoledo/rt-app-observer-sms';
import {CloudWatchOutput} from '@gsalgadotoledo/rt-app-observer-cloudwatch';
const event={id:'event-1',at:new Date().toISOString(),level:'error',kind:'log',source:'api',message:'Failed',data:{}};
test('AWS output adapters use the configured destinations without sending real messages',async()=>{
 const commands=[],client={send:async(command,options)=>{commands.push({input:command.input,options});return {};}};
 const signal=new AbortController().signal;
 await new EmailOutput('verified@example.test','ops@example.test',client).write(event,signal);
 assert.deepEqual(commands[0].input.Destination.ToAddresses,['ops@example.test']);assert.equal(commands[0].options.abortSignal,signal);
 await new SmsOutput('+15555550123',client).write(event,signal);assert.equal(commands[1].input.PhoneNumber,'+15555550123');
 await new CloudWatchOutput('/observer','events',client).write(event,signal);assert.equal(commands[2].input.logGroupName,'/observer');assert.equal(commands[2].input.logEvents[0].timestamp,Date.parse(event.at));
});
