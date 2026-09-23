import {mkdir,open,readFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
export async function localSecret(database:string){
 const file=resolve(database)+'.key';await mkdir(dirname(file),{recursive:true,mode:0o700});
 try{const f=await open(file,'wx',0o600);try{await f.writeFile(randomBytes(48).toString('hex'));await f.sync();}finally{await f.close();}}
 catch(e:any){if(e.code!=='EEXIST')throw e;}
 const key=await readFile(file,'utf8');if(!/^[a-f0-9]{96}$/.test(key))throw new Error('Invalid local auth key; restore it with the matching database');return key;
}
