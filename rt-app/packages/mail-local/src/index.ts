import nodemailer from 'nodemailer';
import type {Mailer,LocalMailbox} from '@gsalgadotoledo/rt-app-auth';
import {HttpError} from '@gsalgadotoledo/rt-app-contracts';
export interface LocalEmail { to:string; subject:string; text:string; html?:string; }
/** Development-only SMTP adapter. The host is intentionally fixed to loopback. */
export class LocalSmtpMailer implements Mailer {
  private transport;
  private capture?: LocalMailbox;
  constructor({port=1025,capture}:{port?:number;capture?:LocalMailbox}={}) {
    if(process.env.NODE_ENV==='production')throw new Error('Local SMTP is disabled in production');
    if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid local SMTP port');
    this.capture=capture;
    this.transport=nodemailer.createTransport({host:'127.0.0.1',port,secure:false,ignoreTLS:true,
      connectionTimeout:3000,greetingTimeout:3000,socketTimeout:5000,disableFileAccess:true,disableUrlAccess:true});
  }
  async send(message:LocalEmail) {
    try {await this.transport.sendMail({from:'RT-App <no-reply@rt-app.test>',...message});}
    catch {throw new HttpError(503,'Local inbox is unavailable. Start it with npm run mail or restart npm run dev.');}
  }
  async sendCode(email:string,code:string,purpose:string) {
    await this.send({to:email,subject:`RT-App: ${purpose}`,text:`Your code is ${code}. It expires in 10 minutes. If you did not request it, ignore this email.`});
    await this.capture?.sendCode(email,code,purpose);
  }
}
