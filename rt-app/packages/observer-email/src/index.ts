import nodemailer from 'nodemailer';
import {SESv2Client,SendEmailCommand} from '@aws-sdk/client-sesv2';
import type {ObserverOutputHandler,ObserverEvent} from '@gsalgadotoledo/rt-app-observer';
export class EmailOutput implements ObserverOutputHandler {
 readonly id='email';
 constructor(private from:string,private to:string,private client=new SESv2Client({maxAttempts:1})){if(!from.includes('@')||!to.includes('@'))throw new Error('Observer email requires valid from/to addresses');}
 async write(event:ObserverEvent,signal?:AbortSignal){await this.client.send(new SendEmailCommand({FromEmailAddress:this.from,Destination:{ToAddresses:[this.to]},Content:{Simple:{Subject:{Data:`[${event.level}] ${event.source}`},Body:{Text:{Data:JSON.stringify(event,null,2)}}}}}),{abortSignal:signal});}
}

/** Uses the local mail viewer; never connects to an arbitrary SMTP server. */
export class LocalEmailOutput implements ObserverOutputHandler {
 readonly id='email';private transport;
 constructor(private from:string,private to:string,port=1025){
  if(process.env.NODE_ENV==='production')throw new Error('Local observer email is disabled in production');
  if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid local SMTP port');
  this.transport=nodemailer.createTransport({host:'127.0.0.1',port,secure:false,ignoreTLS:true,connectionTimeout:1000,greetingTimeout:1000,socketTimeout:1000});
 }
 async write(event:ObserverEvent){await this.transport.sendMail({from:this.from,to:this.to,subject:`[${event.level}] ${event.source}`,text:JSON.stringify(event,null,2)});}
}
