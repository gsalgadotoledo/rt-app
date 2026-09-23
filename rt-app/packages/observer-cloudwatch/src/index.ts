import {CloudWatchLogsClient,PutLogEventsCommand} from '@aws-sdk/client-cloudwatch-logs';
import type {ObserverOutputHandler,ObserverEvent} from '@gsalgadotoledo/rt-app-observer';
/** Group and stream must already exist, managed by infrastructure. */
export class CloudWatchOutput implements ObserverOutputHandler {
 readonly id='cloudwatch';
 constructor(private group:string,private stream:string,private client=new CloudWatchLogsClient({maxAttempts:1})){if(!group||!stream)throw new Error('Observer CloudWatch requires a log group and stream');}
 async write(event:ObserverEvent,signal?:AbortSignal){await this.client.send(new PutLogEventsCommand({logGroupName:this.group,logStreamName:this.stream,logEvents:[{timestamp:Date.parse(event.at),message:JSON.stringify(event)}]}),{abortSignal:signal});}
}
