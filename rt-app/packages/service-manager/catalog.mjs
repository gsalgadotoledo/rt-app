import {mkdir,readFile,writeFile,rename,rm,mkdtemp,access,readdir,symlink} from 'node:fs/promises';
import {join,resolve,dirname,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
const exec=promisify(execFile);
export const catalog=[
 {id:'postgres',name:'PostgreSQL',kind:'service',port:5432,description:'Portable PostgreSQL binaries from @embedded-postgres (npm). Private local cluster; no system installation.'},
 {id:'mongodb',name:'MongoDB Community',kind:'service',port:27017,description:'Official portable macOS archive. Loopback-only development database.'},
 {id:'redis',name:'Redis',kind:'service',port:6379,description:'Verified official source, compiled into the tools directory. Requires Xcode Command Line Tools.'},
 {id:'json',name:'JSON HTTP server',kind:'service',port:3001,description:'Optional local HTTP CRUD server with persistent JSON. Separate from each project’s embedded JSON store.'},
 {id:'sqlite',name:'SQLite',kind:'embedded',description:'Local database file and system SQLite CLI. Embedded: no server process or port.'},
];
const hostAllowed=new Set(['registry.npmjs.org','downloads.mongodb.org','fastdl.mongodb.org','raw.githubusercontent.com','download.redis.io']);
async function download(url,max=350*1024*1024){if(!hostAllowed.has(new URL(url).hostname)||new URL(url).protocol!=='https:')throw new Error('Untrusted download URL');const r=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(120000)});if(!r.ok)throw new Error(`Download failed: ${r.status}`);const chunks=[];let size=0;for await(const c of r.body){size+=c.length;if(size>max)throw new Error('Download exceeds size limit');chunks.push(c);}return Buffer.concat(chunks);}
const json=async url=>JSON.parse((await download(url,12*1024*1024)).toString());
export function verify(bytes,algorithm,expected,encoding='hex'){if(createHash(algorithm).update(bytes).digest(encoding)!==expected)throw new Error('Download checksum mismatch');}
async function extract(bytes,dir){const archive=join(dir,'download.tgz');await writeFile(archive,bytes);const {stdout}=await exec('tar',['-tzf',archive],{maxBuffer:8*1024*1024});if(stdout.split('\n').some(p=>p.startsWith('/')||p.split('/').includes('..')))throw new Error('Unsafe archive path');await exec('tar',['-xzf',archive,'--strip-components','1','-C',dir],{maxBuffer:8*1024*1024});await rm(archive);}
async function find(dir,name){for(const entry of await readdir(dir,{withFileTypes:true})){const p=join(dir,entry.name);if(entry.name===name&&entry.isFile())return p;if(entry.isDirectory()){const found=await find(p,name);if(found)return found;}}}
async function hydratePostgres(dir){
 const links=JSON.parse(await readFile(join(dir,'native/pg-symlinks.json'),'utf8'));
 for(const {source,target} of links){const from=resolve(dir,source),to=resolve(dir,target);if(!from.startsWith(dir+'/')||!to.startsWith(dir+'/'))throw new Error('Unsafe PostgreSQL library link');try{await symlink(relative(dirname(to),from),to);}catch(e){if(e.code!=='EEXIST')throw e;}}
}
export async function installTool(home,id,report=()=>{}){
 if(!catalog.some(t=>t.id===id))throw new Error('Unknown catalog entry');
 if(process.platform!=='darwin')throw new Error('Managed tool installation currently supports macOS');
 const tools=join(home,'tools'),dest=join(tools,id);await mkdir(tools,{recursive:true,mode:0o700});
 try{const installed=JSON.parse(await readFile(join(dest,'installed.json'),'utf8'));await access(installed.binary);if(id==='postgres')await hydratePostgres(dest);return installed;}catch(e){if(e.code!=='ENOENT')throw e;}
 const stage=await mkdtemp(join(tools,`.${id}-`));let info;
 try{
  if(id==='postgres'){
   report('Resolving latest portable PostgreSQL package…');const meta=await json(`https://registry.npmjs.org/@embedded-postgres%2f${process.platform}-${process.arch}/latest`);
   const [algorithm,hash]=meta.dist.integrity.split('-');if(algorithm!=='sha512')throw new Error('Expected SHA-512 integrity');report(`Downloading PostgreSQL ${meta.version}…`);const bytes=await download(meta.dist.tarball);verify(bytes,algorithm,hash,'base64');await extract(bytes,stage);await hydratePostgres(stage);
   const binary=await find(stage,'postgres'),initdb=await find(stage,'initdb');if(!binary||!initdb)throw new Error('PostgreSQL binaries missing');
   info={id,version:meta.version,binary:binary.replace(stage,dest),initdb:initdb.replace(stage,dest),source:meta.dist.tarball,integrity:meta.dist.integrity};
  }else if(id==='mongodb'){
   report('Resolving latest MongoDB Community archive…');const data=await json('https://downloads.mongodb.org/current.json');let release,archive;
   for(const v of data.versions.filter(v=>/^\d+\.\d+\.\d+$/.test(v.version)).sort((a,b)=>b.version.localeCompare(a.version,undefined,{numeric:true}))){const item=v.downloads.find(d=>d.target==='macos'&&d.edition==='base'&&d.arch===(process.arch==='arm64'?'arm64':'x86_64'));if(item){release=v.version;archive=item.archive;break;}}
   if(!archive?.sha256)throw new Error('No compatible MongoDB archive');report(`Downloading MongoDB ${release}…`);const bytes=await download(archive.url);verify(bytes,'sha256',archive.sha256);await extract(bytes,stage);info={id,version:release,binary:join(dest,'bin/mongod'),source:archive.url,integrity:archive.sha256};
  }else if(id==='redis'){
   await exec('xcrun',['--find','clang']);report('Resolving latest Redis source release…');const hashes=(await download('https://raw.githubusercontent.com/redis/redis-hashes/master/README')).toString();const releases=[...hashes.matchAll(/^hash redis-(\d+\.\d+\.\d+)\.tar\.gz sha256 ([a-f0-9]{64}) /gm)].sort((a,b)=>b[1].localeCompare(a[1],undefined,{numeric:true}));if(!releases.length)throw new Error('No verified Redis release');const [,version,hash]=releases[0],url=`https://download.redis.io/releases/redis-${version}.tar.gz`;report(`Downloading Redis ${version}…`);const bytes=await download(url);verify(bytes,'sha256',hash);await extract(bytes,stage);report('Compiling Redis (this may take a few minutes)…');await exec('make',['-C','src','-j','4','redis-server','redis-cli','BUILD_TLS=no','MALLOC=libc'],{cwd:stage,timeout:600000,maxBuffer:16*1024*1024});info={id,version,binary:join(dest,'src/redis-server'),source:url,integrity:hash};
  }else if(id==='json'){
   await writeFile(join(stage,'server.mjs'),await readFile(fileURLToPath(new URL('./json-server.mjs',import.meta.url))));info={id,version:'1',binary:join(dest,'server.mjs'),source:'RT-App'};
  }else{
   await exec('/usr/bin/sqlite3',['--version']);info={id,version:'system',binary:'/usr/bin/sqlite3',source:'macOS SQLite'};
  }
  await writeFile(join(stage,'installed.json'),JSON.stringify(info,null,2)+'\n');await rename(stage,dest);report('Installed');return info;
 }catch(e){await rm(stage,{recursive:true,force:true});throw new Error(`${id}: ${String(e.message).slice(-4000)}`);}
}
export async function toolService(home,info,port){
 const data=join(home,'data',info.id);await mkdir(data,{recursive:true,mode:0o700});
 const base={id:info.id,label:catalog.find(t=>t.id===info.id).name,catalogId:info.id,cwd:'.',ports:[port],portEnv:[`${info.id.toUpperCase()}_PORT`],dependencies:[],env:{},enabled:true};
 if(info.id==='postgres'){
  const cluster=join(data,'cluster');try{await access(join(cluster,'PG_VERSION'));}catch(e){if(e.code!=='ENOENT')throw e;await exec(info.initdb,['-D',cluster,'--username=rtapp','--auth-local=trust','--auth-host=trust','--encoding=UTF8','--locale=C'],{timeout:60000,maxBuffer:2*1024*1024});}
  // Socket remains private, TCP binds only to IPv4 loopback. Local development trust is explicit in the catalog.
  base.command=[info.binary,'-D',cluster,'-h','127.0.0.1','-k',data,'-p','${POSTGRES_PORT}'];
 }else if(info.id==='mongodb')base.command=[info.binary,'--dbpath',data,'--bind_ip','127.0.0.1','--port','${MONGODB_PORT}'];
 else if(info.id==='redis')base.command=[info.binary,'--bind','127.0.0.1','--protected-mode','yes','--port','${REDIS_PORT}','--dir',data,'--appendonly','yes','--daemonize','no'];
 else if(info.id==='json'){base.command=['node',info.binary];base.env={RT_APP_JSON_SERVER_FILE:join(data,'db.json')};base.url=`http://localhost:${port}`;base.readyUrl=`http://localhost:${port}/health`;}
 else{const file=join(data,'database.sqlite');try{await access(file);}catch(e){if(e.code!=='ENOENT')throw e;await exec(info.binary,[file,'VACUUM;']);}return null;}
 return base;
}
