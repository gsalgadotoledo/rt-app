import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {detectApps,appTask,remoteWebUrl,branchWebUrl,repository} from '../apps.mjs';

async function project(t,files){
 const root=await mkdtemp(join(tmpdir(),'sm-apps-'));t.after(()=>rm(root,{recursive:true,force:true}));
 for(const [path,content] of Object.entries(files)){await mkdir(join(root,path,'..'),{recursive:true});if(content!==null)await writeFile(join(root,path),typeof content==='string'?content:JSON.stringify(content));}
 return root;
}

test('detectApps finds Electron, Tauri, Expo and React Native workspaces and reuses matching services',async t=>{
 const root=await project(t,{
  'package.json':{name:'root',packageManager:'pnpm@10.0.0'},
  'pnpm-workspace.yaml':'packages:\n  - apps/*\n',
  'apps/desktop/package.json':{name:'@x/desktop',productName:'My Desktop',devDependencies:{electron:'40'},scripts:{dev:'electron-vite dev',preview:'electron-vite preview'}},
  'apps/desktop/dist/mac-arm64/My Desktop.app/Contents/Info.plist':'<plist/>',
  'apps/tray/package.json':{name:'@x/tray',scripts:{dev:'tauri dev'}},
  'apps/tray/src-tauri/tauri.conf.json':'{}',
  'apps/mobile/package.json':{name:'@x/mobile',dependencies:{expo:'52','react-native':'0.76'},scripts:{start:'expo start',ios:'expo run:ios',android:'expo run:android'}},
  'apps/native/package.json':{name:'@x/native',dependencies:{'react-native':'0.76'},scripts:{start:'react-native start'}},
  'apps/web/package.json':{name:'@x/web',dependencies:{react:'19'},scripts:{dev:'vite'}},
 });
 const apps=await detectApps(root,[{id:'desktop',label:'Desktop',command:['pnpm','--filter','@x/desktop','dev'],cwd:'.'}]);
 const by=Object.fromEntries(apps.map(a=>[a.name,a]));
 assert.deepEqual(Object.keys(by).sort(),['@x/desktop','@x/mobile','@x/native','@x/tray'],'plain web apps are not listed');
 assert.equal(by['@x/desktop'].kind,'electron');
 assert.equal(by['@x/desktop'].label,'My Desktop');
 assert.equal(by['@x/desktop'].serviceId,'desktop');
 assert.deepEqual(by['@x/desktop'].builds.map(b=>b.name),['My Desktop']);
 assert.equal(by['@x/tray'].kind,'tauri');
 assert.equal(by['@x/mobile'].kind,'expo');
 assert.deepEqual(by['@x/mobile'].actions.map(a=>a.action),['dev','ios','android']);
 assert.equal(by['@x/native'].kind,'react-native');
 const task=await appTask(root,by['@x/mobile'],'ios',[{id:'api',env:{RT_APP_API_URL:'http://localhost:4010'}}]);
 assert.deepEqual(task.command,['pnpm','--filter','@x/mobile','run','ios'],'the project package manager runs the script');
 assert.equal(task.kind,'task');
 assert.deepEqual(task.env,{RT_APP_API_URL:'http://localhost:4010'},'apps get the API service environment');
 await assert.rejects(appTask(root,by['@x/native'],'ios'),/no ios script/);
});

test('remoteWebUrl turns git remotes into web pages and drops credentials',()=>{
 assert.deepEqual(remoteWebUrl('git@github.com:me/app.git'),{url:'https://github.com/me/app',provider:'github',host:'github.com',path:'me/app'});
 assert.equal(remoteWebUrl('https://token:x@gitlab.com/group/sub/app.git').url,'https://gitlab.com/group/sub/app');
 assert.equal(remoteWebUrl('ssh://git@gitlab.example.com:2222/team/app.git').url,'https://gitlab.example.com/team/app');
 assert.equal(remoteWebUrl('git@bitbucket.org:team/app.git').provider,'bitbucket');
 assert.equal(remoteWebUrl('git@ssh.dev.azure.com:v3/org/proj/repo').url,'https://dev.azure.com/org/proj/_git/repo');
 assert.equal(remoteWebUrl('/Users/me/repos/app.git'),null,'local remotes have no web page');
 assert.equal(remoteWebUrl('file:///tmp/app'),null);
});

test('branchWebUrl uses each provider\'s branch path',()=>{
 assert.equal(branchWebUrl(remoteWebUrl('git@github.com:me/app.git'),'feat/x'),'https://github.com/me/app/tree/feat/x');
 assert.equal(branchWebUrl(remoteWebUrl('git@gitlab.com:me/app.git'),'main'),'https://gitlab.com/me/app/-/tree/main');
 assert.equal(branchWebUrl(remoteWebUrl('git@bitbucket.org:me/app.git'),'dev'),'https://bitbucket.org/me/app/src/dev');
 assert.equal(branchWebUrl(remoteWebUrl('git@github.com:me/app.git'),null),'https://github.com/me/app');
});

test('repository prefers origin, reports null without remotes',async()=>{
 const fake=answers=>async(bin,args)=>({stdout:answers[args.join(' ')]??''});
 assert.equal(await repository('/p',{run:fake({})}),null);
 const repo=await repository('/p',{run:fake({'remote':'upstream\norigin','remote get-url origin':'git@github.com:me/app.git','rev-parse --abbrev-ref HEAD':'main'})});
 assert.deepEqual([repo.remote,repo.url,repo.branchUrl],['origin','https://github.com/me/app','https://github.com/me/app/tree/main']);
 const detached=await repository('/p',{run:fake({'remote':'upstream','remote get-url upstream':'https://github.com/me/app','rev-parse --abbrev-ref HEAD':'HEAD'})});
 assert.deepEqual([detached.remote,detached.branch,detached.branchUrl],['upstream',null,'https://github.com/me/app']);
});
