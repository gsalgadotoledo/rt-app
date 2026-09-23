import {mkdir,writeFile,unlink,access} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
export const label='dev.rtapp.services';
const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
export function launchAgent(executable,path){return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${escape(executable)}</string><string>--background</string></array><key>RunAtLoad</key><true/><key>ProcessType</key><string>Interactive</string><key>EnvironmentVariables</key><dict><key>PATH</key><string>${escape(path)}</string></dict></dict></plist>\n`;}
export async function startupEnabled(){try{await access(join(homedir(),'Library/LaunchAgents',label+'.plist'));return true;}catch{return false;}}
export async function configureStartup(enabled,executable){
 if(process.platform!=='darwin')throw new Error('Automatic login is currently supported on macOS');
 const directory=join(homedir(),'Library/LaunchAgents'),file=join(directory,label+'.plist'),domain=`gui/${process.getuid()}`;
 // Do not unload a running launch agent: doing so would kill the tray and its IPC.
 if(!enabled){await exec('launchctl',['disable',`${domain}/${label}`]);await unlink(file).catch(e=>{if(e.code!=='ENOENT')throw e;});return;}
 await mkdir(directory,{recursive:true});await writeFile(file,launchAgent(executable,process.env.PATH??'/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'),{mode:0o600});
 await exec('plutil',['-lint',file]);await exec('launchctl',['enable',`${domain}/${label}`]);
 try{await exec('launchctl',['print',`${domain}/${label}`]);}catch{await exec('launchctl',['bootstrap',domain,file]);}
}
