#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {homedir} from 'node:os';
import {join} from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import {mailConfig,mailpitLaunch,ensureMailpit} from '@gsalgadotoledo/rt-app-mail-local/runtime';
import {publicConfig,localUrls,environmentVariables} from '@gsalgadotoledo/rt-app-config';
import { packageFile } from '@gsalgadotoledo/rt-app-config/paths';
const [command='help', ...args] = process.argv.slice(2);
const json = args.includes('--json');
const root = process.cwd();
const run = (cmd, argv, env=process.env) => {
  const r=spawnSync(cmd,argv,{cwd:root,env,stdio:'inherit'});
  if(r.error) throw r.error;
  if(r.status!==0) process.exit(r.status??1);
};
const query = () => {
  const r=spawnSync('npm',['query','.workspace','--json'],{cwd:root,encoding:'utf8'});
  if(r.status!==0) throw new Error(r.stderr || 'Run npm install first');
  return JSON.parse(r.stdout).map(w=>({name:w.name,path:w.location,scripts:w.scripts??{}}));
};
async function urls() {
  let cloud=[];
  try { const data=JSON.parse(await readFile('.rt-app/installation.json','utf8')); cloud=data.deployments??[]; }
  catch(e) {if(e.code!=='ENOENT') throw e;}
  let settings={};try{settings=JSON.parse(await readFile('rt-app.settings.json','utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const configuredUrls=Object.fromEntries(Object.entries(localUrls).map(([id,url])=>[id,`http://localhost:${settings.local?.ports?.[id]??new URL(url).port}`]));
  let mailUrl=mailConfig().url.replace('127.0.0.1','localhost');try{const global=JSON.parse(await readFile(join(homedir(),'.rt-app/service-manager/settings.json'),'utf8'));mailUrl=`http://localhost:${global.ports.mail}`;}catch(e){if(e.code!=='ENOENT')throw e;}
  return {local:{...configuredUrls,...((process.env.RT_APP_MODE!=='aws'&&!args.includes('--no-mail'))?{mail:mailUrl}:{})},cloud};
}
function printUrls(value) {
  console.log('\nLocal URLs (available after startup):');
  for(const [name,url] of Object.entries(value.local)) console.log(`  ${name}: ${url}`);
  for(const env of value.cloud) console.log(`\n${env.environment}:\n  admin: ${env.adminUrl}\n  spa: ${env.publicUrl}\n  ssr: ${env.ssrUrl??'not provisioned'}${env.ssr?.status==='awaiting_repository'?' (awaiting GitHub connection)':''}\n  api: ${env.apiUrl}`);
  if(!value.cloud.length) console.log('\nAWS: not installed here. Run rta install to provision production.');
}
async function checkPorts(ports) {
  if(new Set(ports).size!==ports.length) throw new Error('Service ports must differ');
  for(const port of ports) await new Promise((resolve,reject)=>{
    const s=createServer();s.once('error',()=>reject(new Error(`Port ${port} is occupied; stop the existing server first`)));s.listen(port,'127.0.0.1',()=>s.close(resolve));
  });
}
try {
  if (command === 'build' || command === 'check') {
    run(process.execPath, [packageFile('@gsalgadotoledo/rt-app-framework', 'scripts/workspaces.mjs'), command]);
    if (command === 'build') {
      const { runAdmin } = await import('@gsalgadotoledo/rt-app-myadmin/runtime');
      await runAdmin({projectRoot: root, mode: 'build'});
    }
  } else if (command === 'prepare-ssr') {
    run(process.execPath,[packageFile('@gsalgadotoledo/rt-app-framework','scripts/prepare-ssr.mjs')]);
  } else if (command === 'next') {
    run(process.execPath,[packageFile('@gsalgadotoledo/rt-app-framework','scripts/next.mjs'),...args]);
  } else if (command === 'admin') {
    const { runAdmin } = await import('@gsalgadotoledo/rt-app-myadmin/runtime');
    await runAdmin({projectRoot: root});
  } else if ((command === 'deploy' && ['providers','plan','apply','status','credentials'].includes(args[0])) || command === 'github') {
    // Provider deployments (Render, Railway, Vercel, Neon…) and GitHub environments.
    const {deployCommand,githubCommand}=await import('@gsalgadotoledo/rt-app-deployments/cli');
    const stdin=async()=>{let text='';for await(const chunk of process.stdin)text+=chunk;return text;};
    await (command==='github'?githubCommand:deployCommand)(args,{root,stdin});
  } else if (command === 'deploy' || command === 'setup-terminal') {
    run(process.execPath,[fileURLToPath(new URL(command === 'deploy' ? '../deploy.mjs' : '../dist/index.js',import.meta.url)),...args]);
  } else if (command === 'native-deploy-pending') {
    throw new Error('AWS deployment for this backend is not implemented. Use local development.');
  } else if(command==='module') {
    const {runModuleCommand}=await import('../module-tools.mjs');
    await runModuleCommand(args);
  } else if(command==='migrate'||command==='seed') {
    // Module migrations/seeds against the database selected by RT_APP_MODE (json, dynamodb-local or aws).
    run(process.execPath,[join(root,`apps/server/dist/${command}.js`),...args]);
  } else if(command==='mcp') {
    run(process.execPath,[join(root,'apps/mcp/index.mjs')]);
  } else if(command==='cloud'||command==='aws-bootstrap') {
    if(args.length)throw new Error('Usage: rta cloud | rta aws-bootstrap');
    const settings=JSON.parse(await readFile(join(root,'rt-app.settings.json'),'utf8'));
    if(settings.backend&&settings.backend!=='node-ts')throw new Error('AWS deployment for this backend is not implemented yet. Use local development.');
    if(command==='cloud'&&!process.env.ADMIN_PASSWORD)throw new Error('Set ADMIN_PASSWORD before cloud installation.');
    const {bootstrapAws,deploymentEnvironment}=await import('../aws-bootstrap.mjs');
    const identity=await bootstrapAws({root});
    console.log(`AWS deployment user ready: ${identity.userName} (${identity.region}). Credentials stored privately in .rt-app/aws-identity.json.`);
    if(command==='cloud'){
      const env=deploymentEnvironment(process.env,identity);
      run('npm',['run','build'],env);
      run(process.execPath,[fileURLToPath(new URL('../dist/web.js',import.meta.url))],{...env,RT_APP_MULTI_ENVIRONMENT:'false'});
    }
  } else if(command==='aws-access') {
    run(process.execPath,[fileURLToPath(new URL('../aws-access.mjs',import.meta.url)),...args]);
  } else if(command==='create') {
    if(args[0]!=='crud') throw new Error('Usage: rta create crud <name> --fields "name:string" [--actions publish] [--json] [--dry-run]');
    const {parse,generate}=await import('./create-crud.mjs');
    const {spec,dryRun}=await parse(args.slice(1));
    const result=await generate(root,spec,{dryRun});
    console.log(json?JSON.stringify(result):`${dryRun?'Preview':'Created'}: ${result.created}\n${result.note}\nNext: ${result.next.join(' && ')}`);
  } else if(command==='tools') {
    console.log(JSON.stringify({name:'RT-App',tools:[
      {command:'rta create crud <name>',description:'Copy an editable CRUD package into packages/, register local/Lambda endpoints and admin UI. Explicit permissions; no public access.',options:['--fields name:string,price:number,active:boolean,notes:string?','--title Products','--actions publish,archive','--spec ./crud.json','--dry-run','--json']},
      {command:'rta migrate [status|up|down]',description:'Show, apply or revert module migrations on the RT_APP_MODE database. down refuses irreversible migrations; one runner at a time',options:['--to <id>','--step <n>','--json']},
      {command:'rta seed [status|run]',description:'Run module seeds allowed in this environment (demo seeds: local, develop, stage). Requires DEMO_PASSWORD; deployed environments also CONFIRM_DEMO_SEED=yes',options:['--module <id>','--rerun','--json']},
      {command:'rta deploy <providers|plan|apply|status|credentials>',description:'Deploy roles (api, ssr, frontend, files, database) to the providers configured in rt-app.settings.json deploy (Render, Railway, Fly.io, DigitalOcean, Heroku, Vercel, Neon, Supabase; AWS through Terraform)',options:['--env develop|stage|prod','--role api','--json']},
      {command:'rta github <connect|sync>',description:'Create/push the GitHub repo; create develop/stage/prod environments and push credentials as environment secrets (gh CLI)',options:['--public','--name owner/repo','--env stage']},
      {command:'rta module list',description:'Discover documented module actions. Invoke: rta module <name> @input.json'},
      {command:'rta mcp',description:'Start the project MCP stdio server; running API required'},
      {command:'rta desktop',description:'Open the local service manager desktop window'},
      {command:'rta services <status|start|stop|restart|logs|shutdown> [service|all] --json',description:'Manage the same local Rust supervisor from agents or terminal; no cloud deployment'},
      {command:'rta dev',description:'Start local JSON backend, admin, SPA, SSR and Mailpit inbox; stop with SIGINT',options:['--no-build','--no-mail']},
      {command:'rta mail',description:'Start the local Mailpit inbox; downloads its verified binary on first use',options:['--install-only']},
      {command:'rta urls --json',description:'Read configured local and saved AWS URLs; does not verify liveness'},
      {command:'rta workspaces --json',description:'List npm workspaces including registered nested packages'},
      {command:'rta run <workspace> <script>',description:'Run a registered workspace script'},
      {command:'rta cloud',description:'Create or reuse a deployment IAM user using bootstrap credentials, then open the AWS installation wizard'},
      {command:'rta install',description:'Open authenticated AWS installation wizard; default production only',options:['--multi-environment']}
    ]},null,2));
  } else if(command==='urls') {const value=await urls(); json?console.log(JSON.stringify(value,null,2)):printUrls(value);}
  else if(command==='workspaces') { const value=query(); console.log(json?JSON.stringify(value,null,2):value.map(w=>`${w.name}\t${w.path}\t${Object.keys(w.scripts).join(', ')}`).join('\n')); }
  else if(command==='run') {
    const [workspace,script]=args;
    if(!query().some(w=>w.name===workspace&&Object.hasOwn(w.scripts,script))) throw new Error('Unknown workspace/script');
    run('npm',['run',script,'--workspace',workspace]);
  } else if(command==='install') {
    if(args.some(a=>a!=='--multi-environment')) throw new Error('Usage: rta install [--multi-environment]');
    const {savedIdentity,deploymentEnvironment}=await import('../aws-bootstrap.mjs');const identity=await savedIdentity(root);const env=identity?deploymentEnvironment(process.env,identity):process.env;
    run('npm',['run','build'],env);
    run(process.execPath,[fileURLToPath(new URL('../dist/web.js',import.meta.url))],{...env,RT_APP_MULTI_ENVIRONMENT:String(args.includes('--multi-environment'))});
  } else if(command==='mail') {
    if(args.some(a=>a!=='--install-only')) throw new Error('Usage: rta mail [--install-only]');
    if(args.includes('--install-only')) console.log(await ensureMailpit(root));
    else {
      const config=mailConfig();await checkPorts([config.smtpPort,config.uiPort]);
      const launch=await mailpitLaunch(root);
      const child=spawn(launch.command,launch.args,{env:launch.env,stdio:'inherit'});
      process.on('SIGINT',()=>child.kill('SIGTERM'));process.on('SIGTERM',()=>child.kill('SIGTERM'));
      child.once('error',e=>{console.error(e.message);process.exitCode=1;});
      child.once('exit',code=>{process.exitCode=code??0;});
      console.log(`Local inbox: ${launch.url}`);
    }
  } else if(command==='dev') {
    const {devCommand}=await import('@gsalgadotoledo/rt-app-service-manager/cli');
    await devCommand(root,args);
  } else if(command==='services') {
    const {servicesCommand}=await import('@gsalgadotoledo/rt-app-service-manager/cli');
    await servicesCommand(root,args);
  } else if(command==='desktop') {
    const {desktopCommand}=await import('@gsalgadotoledo/rt-app-service-manager/cli');
    await desktopCommand(root);
  } else if(command==='help') console.log('RT-App CLI\n  rta build\n  rta check\n  rta admin\n  rta deploy <outputs.json>\n  rta deploy providers|plan|apply|status|credentials [--env stage] [--role api] [--json]\n  rta github connect|sync [--env stage]\n  rta migrate [status|up|down] [--to <id>] [--step <n>] [--json]\n  rta seed [status|run] [--module <id>] [--rerun] [--json]\n  rta module list\n  rta module <action> [@input.json]\n  rta mcp\n  rta cloud\n  rta aws-bootstrap\n  rta create crud <name> [--fields name:string] [--actions publish] [--spec file] [--dry-run] [--json]\n  rta dev [--no-build] [--no-mail]\n  rta mail [--install-only]\n  rta desktop\n  rta services <status|daemon|start|stop|restart|logs|shutdown> [service|all] [--json]\n  rta install [--multi-environment]\n  rta urls [--json]\n  rta workspaces [--json]\n  rta run <workspace> <script>\n  rta tools --json');
  else throw new Error(`Unknown command: ${command}`);
} catch(e){console.error(e.message);process.exitCode=1;}
