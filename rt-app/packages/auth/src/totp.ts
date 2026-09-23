import {createHmac, randomBytes, timingSafeEqual, createCipheriv, createDecipheriv, createHash} from 'node:crypto';
const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function totpSecret(){let bits='';for(const b of randomBytes(20))bits+=b.toString(2).padStart(8,'0');return bits.match(/.{5}/g)!.map(b=>alphabet[parseInt(b,2)]).join('');}
export function totpCode(secret:string,step=Math.floor(Date.now()/30000)){
 const bits=[...secret].map(c=>alphabet.indexOf(c).toString(2).padStart(5,'0')).join('');
 const key=Buffer.from(bits.match(/.{8}/g)!.map(b=>parseInt(b,2))),counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(step));
 const hash=createHmac('sha1',key).update(counter).digest(),offset=hash[19]&15;
 return String((hash.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,'0');
}
export function totpStep(secret:string,code:unknown,last=-1){
 if(typeof code!=='string'||!/^\d{6}$/.test(code))return undefined;
 const now=Math.floor(Date.now()/30000);
 for(const step of [now,now-1,now+1])if(step>last&&timingSafeEqual(Buffer.from(totpCode(secret,step)),Buffer.from(code)))return step;
 return undefined;
}
/** Encrypt provider sessions and TOTP seeds; plaintext never enters a JSON/DynamoDB row. */
export class AuthVault {
 private key:Buffer;
 constructor(secret:string){this.key=createHash('sha256').update('rt-app-auth-vault:'+secret).digest();}
 seal(value:unknown){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);const data=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64url');}
 open(value:string):any{const b=Buffer.from(value,'base64url'),cipher=createDecipheriv('aes-256-gcm',this.key,b.subarray(0,12));cipher.setAuthTag(b.subarray(12,28));return JSON.parse(Buffer.concat([cipher.update(b.subarray(28)),cipher.final()]).toString());}
}
