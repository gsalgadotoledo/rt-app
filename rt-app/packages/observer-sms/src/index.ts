import {SNSClient,PublishCommand} from '@aws-sdk/client-sns';
import type {ObserverOutputHandler,ObserverEvent} from '@gsalgadotoledo/rt-app-observer';
export class SmsOutput implements ObserverOutputHandler {
 readonly id='sms';
 constructor(private phone:string,private client=new SNSClient({maxAttempts:1})){if(!/^\+[1-9]\d{7,14}$/.test(phone))throw new Error('Observer SMS requires E.164 phone number');}
 async write(event:ObserverEvent,signal?:AbortSignal){await this.client.send(new PublishCommand({PhoneNumber:this.phone,Message:`${event.level.toUpperCase()} ${event.source}: ${event.message}`.slice(0,140)}),{abortSignal:signal});}
}
