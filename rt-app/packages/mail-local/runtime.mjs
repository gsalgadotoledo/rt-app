import {mkdir,mkdtemp,readFile,writeFile,rename,chmod,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import release from './mailpit-release.json' with {type:'json'};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function mailConfig(env=process.env) {
  const port=(value,fallback)=>{const n=Number(value??fallback);if(!Number.isInteger(n)||n<1024||n>65535)throw new Error('Local mail ports must be integers between 1024 and 65535');return n;};
  const smtpPort=port(env.RT_APP_MAIL_SMTP_PORT,1025),uiPort=port(env.RT_APP_MAIL_UI_PORT,8025);
  if(smtpPort===uiPort)throw new Error('Local mail SMTP and UI ports must differ');
  return {smtpPort,uiPort,url:`http://127.0.0.1:${uiPort}`};
}
export function mailpitAsset(platform=process.platform,arch=process.arch) {
  const os={darwin:'darwin',linux:'linux',win32:'windows'}[platform],cpu={x64:'amd64',arm64:'arm64',ia32:'386',arm:'arm'}[arch];
  const name=`mailpit-${os}-${cpu}.${platform==='win32'?'zip':'tar.gz'}`;
  if(!release.assets[name])throw new Error(`Mailpit has no bundled release for ${platform}/${arch}`);
  return {name,...release.assets[name]};
}
export function verifyArchive(bytes,asset) {
  if(bytes.length!==asset.size||digest(bytes)!==asset.sha256)throw new Error('Mailpit download failed checksum verification');
}
export async function ensureMailpit(root=process.cwd()) {
  if(process.env.NODE_ENV==='production')throw new Error('Local mail tools are disabled in production');
  const asset=mailpitAsset(),directory=resolve(root,'.rt-app/tools/mailpit',release.version,`${process.platform}-${process.arch}`);
  const executable=join(directory,process.platform==='win32'?'mailpit.exe':'mailpit');
  try {
    const [binary,expected]=await Promise.all([readFile(executable),readFile(join(directory,'binary.sha256'),'utf8')]);
    if(digest(binary)===expected.trim())return executable;
    throw new Error('Cached Mailpit binary is damaged; remove its versioned cache directory and retry');
  }catch(error){if(error.code!=='ENOENT')throw error;}
  await mkdir(directory,{recursive:true,mode:0o700});
  const staging=await mkdtemp(join(directory,'.install-'));
  try {
    console.error(`Installing Mailpit ${release.version} from the official GitHub release…`);
    const response=await fetch(`https://github.com/axllent/mailpit/releases/download/${release.version}/${asset.name}`,{signal:AbortSignal.timeout(60000)});
    if(!response.ok)throw new Error(`Mailpit download failed (${response.status}). Retry rta mail --install-only when online.`);
    const chunks=[];let size=0;
    for await(const chunk of response.body){size+=chunk.length;if(size>asset.size)throw new Error('Mailpit download exceeded the expected size');chunks.push(chunk);}
    const bytes=Buffer.concat(chunks);verifyArchive(bytes,asset);
    const archive=join(staging,asset.name);await writeFile(archive,bytes,{mode:0o600});
    const filename=process.platform==='win32'?'mailpit.exe':'mailpit';
    const extraction=spawnSync('tar',['-xf',archive,'-C',staging,filename],{encoding:'utf8'});
    if(extraction.error||extraction.status!==0)throw new Error('Cannot extract Mailpit. Install tar (included in macOS, Linux and modern Windows), then retry.');
    const binary=await readFile(join(staging,filename));
    await chmod(join(staging,filename),0o700);
    await rename(join(staging,filename),executable);
    await writeFile(join(directory,'binary.sha256'),digest(binary),{mode:0o600});
    return executable;
  }finally{await rm(staging,{recursive:true,force:true});}
}
export async function mailpitLaunch(root=process.cwd(),env=process.env) {
  if(env.NODE_ENV==='production')throw new Error('Local mail tools are disabled in production');
  const config=mailConfig(env),command=await ensureMailpit(root);
  const data=resolve(root,'.rt-app/mail');await mkdir(data,{recursive:true,mode:0o700});
  // Ignore inherited Mailpit settings: external relaying/forwarding must never be enabled here.
  const environment=Object.fromEntries(Object.entries(env).filter(([key])=>!key.startsWith('MP_')));
  return {command,args:['--listen',`127.0.0.1:${config.uiPort}`,'--smtp',`127.0.0.1:${config.smtpPort}`,
    '--allowed-hosts',`127.0.0.1:${config.uiPort},localhost:${config.uiPort}`,
    '--database',join(data,'mailpit.db'),'--max','500','--disable-version-check','--smtp-disable-rdns','--label','RT-App local inbox'],env:environment,...config};
}
