import {createServer} from 'node:http';
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
const file=process.env.RT_APP_JSON_SERVER_FILE,port=Number(process.env.JSON_PORT??3001);
if(!file||!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid JSON server configuration');
await mkdir(dirname(file),{recursive:true,mode:0o700});let db;
try{db=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;db={};}
if(!db||typeof db!=='object'||Array.isArray(db))throw new Error('Invalid JSON database: expected an object');
let queue=Promise.resolve();
const server=createServer((req,res)=>{queue=queue.then(async()=>{
 const reply=(status,body)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(body));};
 if(![`localhost:${port}`,`127.0.0.1:${port}`].includes(req.headers.host))return reply(403,{error:'Invalid host'});
 if(req.headers.origin&&!['http://localhost:'+port,'http://127.0.0.1:'+port].includes(req.headers.origin))return reply(403,{error:'Origin not allowed'});
 const url=new URL(req.url,'http://localhost'),parts=url.pathname.split('/').filter(Boolean);
 if(req.method==='GET'&&url.pathname==='/health')return reply(200,{ok:true});
 if(req.method==='GET'&&!parts.length)return reply(200,{name:'RT-App JSON server',collections:Object.keys(db),usage:'GET/POST /collection; GET/PUT/DELETE /collection/id'});
 const [collection,id]=parts;if(parts.length>2||!collection||! /^[a-z][a-z0-9_-]*$/.test(collection)||['constructor','prototype','__proto__'].includes(collection))return reply(400,{error:'Invalid collection'});
 const rows=db[collection]??[];if(!Array.isArray(rows))return reply(500,{error:'Invalid stored collection'});
 if(req.method==='GET'){const value=id?rows.find(x=>x.id===id):rows.slice(Math.max(0,Number(url.searchParams.get('offset'))||0),Math.max(0,Number(url.searchParams.get('offset'))||0)+Math.min(100,Math.max(1,Number(url.searchParams.get('limit'))||25)));return reply(value?200:404,value??{error:'Not found'});}
 if(!['POST','PUT','DELETE'].includes(req.method))return reply(405,{error:'Method not allowed'});
 if(req.method==='POST'&&id||req.method!=='POST'&&!id)return reply(400,{error:'Invalid path'});
 let input={};if(req.method!=='DELETE'){if(!req.headers['content-type']?.startsWith('application/json'))return reply(415,{error:'JSON required'});let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>65536)return reply(413,{error:'Body too large'});}try{input=JSON.parse(raw);if(!input||Array.isArray(input)||typeof input!=='object')throw 0;}catch{return reply(400,{error:'Invalid JSON'});}}
 const next=structuredClone(db),items=next[collection]??[],index=items.findIndex(x=>x.id===id);let result;
 if(req.method==='POST'){result={...input,id:randomUUID()};items.push(result);}else{if(index<0)return reply(404,{error:'Not found'});if(req.method==='DELETE'){result=items.splice(index,1)[0];}else{result={...input,id};items[index]=result;}}
 next[collection]=items;const temp=file+'.tmp';await writeFile(temp,JSON.stringify(next)+'\n',{mode:0o600});await rename(temp,file);db=next;reply(req.method==='POST'?201:200,result);
 }).catch(()=>{if(!res.headersSent)res.writeHead(500);res.end('{"error":"Storage failure"}');});});
server.listen(port,'127.0.0.1',()=>console.log(`JSON server: http://localhost:${port}`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>process.exit(0)));
