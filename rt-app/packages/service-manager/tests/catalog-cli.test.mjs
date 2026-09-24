import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {catalog,githubClis,downloadFollowing,checksumFor,installGithubCli,cliPaths,toolService} from '../catalog.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

function releaseFetch({tamper=false,version='2.101.0'}={}){
 const asset=Buffer.from('zip-bytes'),name=githubClis.gh.asset(version,'arm64'),checks=githubClis.gh.checksums(version);
 const routes={
  'https://api.github.com/repos/cli/cli/releases/latest':{status:200,body:JSON.stringify({tag_name:'v'+version,assets:[{name,browser_download_url:'https://github.com/cli/cli/releases/download/a'},{name:checks,browser_download_url:'https://github.com/cli/cli/releases/download/c'}]})},
  'https://github.com/cli/cli/releases/download/a':{status:302,location:'https://release-assets.githubusercontent.com/a'},
  'https://github.com/cli/cli/releases/download/c':{status:302,location:'https://release-assets.githubusercontent.com/c'},
  'https://release-assets.githubusercontent.com/a':{status:200,body:asset},
  'https://release-assets.githubusercontent.com/c':{status:200,body:`${tamper?'0'.repeat(64):sha(asset)}  ${name}\n${'1'.repeat(64)}  other.zip\n`},
 };
 return async(url,init)=>{assert.equal(init.redirect,'manual');const r=routes[url];if(!r)throw new Error('unexpected '+url);return new Response(r.body??null,{status:r.status,headers:r.location?{location:r.location}:{}});};
}

test('catalog lists gh and flyctl as CLIs with official release naming',()=>{
 assert.deepEqual(catalog.filter(t=>t.kind==='cli').map(t=>t.id),['gh','flyctl']);
 assert.equal(githubClis.gh.asset('2.101.0','arm64'),'gh_2.101.0_macOS_arm64.zip');
 assert.equal(githubClis.gh.asset('2.101.0','x64'),'gh_2.101.0_macOS_amd64.zip');
 assert.equal(githubClis.flyctl.asset('0.4.108','arm64'),'flyctl_0.4.108_macOS_arm64.tar.gz');
 assert.equal(githubClis.flyctl.asset('0.4.108','x64'),'flyctl_0.4.108_macOS_x86_64.tar.gz');
 assert.equal(githubClis.flyctl.checksums('0.4.108'),'flyctl_0.4.108_checksums.txt');
});

test('release install follows allowed redirects and verifies the checksum',async()=>{
 const reports=[];
 const result=await installGithubCli('gh','/stage',{fetchImpl:releaseFetch(),arch:'arm64',report:m=>reports.push(m)});
 assert.deepEqual([result.version,result.asset,result.bytes.toString()],['2.101.0','gh_2.101.0_macOS_arm64.zip','zip-bytes']);
 assert.equal(reports.length,2);
 await assert.rejects(installGithubCli('gh','/stage',{fetchImpl:releaseFetch({tamper:true}),arch:'arm64'}),/checksum mismatch/);
 await assert.rejects(installGithubCli('gh','/stage',{fetchImpl:releaseFetch({version:'latest'}),arch:'arm64'}),/Unexpected release version/);
});

test('downloads refuse untrusted hosts, plain HTTP, redirect loops and oversized bodies',async()=>{
 await assert.rejects(downloadFollowing('https://evil.example/x'),/Untrusted/);
 await assert.rejects(downloadFollowing('http://github.com/x'),/Untrusted/);
 const toEvil=async()=>new Response(null,{status:302,headers:{location:'https://evil.example/payload'}});
 await assert.rejects(downloadFollowing('https://github.com/x',{fetchImpl:toEvil}),/Untrusted/);
 const loop=async()=>new Response(null,{status:302,headers:{location:'https://github.com/x'}});
 await assert.rejects(downloadFollowing('https://github.com/x',{fetchImpl:loop}),/Too many redirects/);
 await assert.rejects(downloadFollowing('https://github.com/x',{fetchImpl:async()=>new Response('no',{status:404})}),/404/);
 await assert.rejects(downloadFollowing('https://github.com/x',{fetchImpl:async()=>new Response('12345'),max:4}),/too large/);
 assert.throws(()=>checksumFor('abc  file.zip','file.zip'),/No checksum/);
 assert.throws(()=>checksumFor('','file.zip'),/No checksum/);
});

test('installed CLIs are added to PATH and never become services',async t=>{
 const home=await mkdtemp(join(tmpdir(),'sm-cli-'));t.after(()=>rm(home,{recursive:true,force:true}));
 assert.deepEqual(await cliPaths(home),[]);
 await mkdir(join(home,'tools/gh/bin'),{recursive:true});await writeFile(join(home,'tools/gh/bin/gh'),'');
 assert.deepEqual(await cliPaths(home),[join(home,'tools/gh/bin')]);
 assert.equal(await toolService(home,{id:'gh',binary:join(home,'tools/gh/bin/gh')},undefined),null);
});
