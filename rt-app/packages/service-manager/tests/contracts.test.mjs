import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {findConfigs,describe,ContractRunner,summarize,toolPaths,CONFIG_CANDIDATES} from '../contracts.mjs';

// The temporary project is outside the monorepo, so its host imports the package by file URL.
const CONFORMANCE=new URL('../../../../node_modules/@gsalgadotoledo/rt-app-conformance/dist/index.js',import.meta.url).href;
const HOST=`import {runHost} from '@gsalgadotoledo/rt-app-conformance';\nawait runHost({subjects:{calc:()=>({add:(a,b)=>a+b})}});\n`;

async function project(t){
 const root=await mkdtemp(join(tmpdir(),'sm-contracts-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(join(root,'spec/contracts'),{recursive:true});
 await writeFile(join(root,'spec/host.mjs'),HOST.replace("'@gsalgadotoledo/rt-app-conformance'",JSON.stringify(CONFORMANCE)));
 await writeFile(join(root,'spec/contracts/calc.contract.yaml'),`contract: 1\nmodule: calc\ndescription: Adds numbers.\ncases:\n  - { name: adds, tags: [math], call: add, args: [1, 2], expect: { value: 3 } }\n  - { name: wrong, call: add, args: [1, 1], expect: { value: 3 } }\n  - { name: todo, call: add, args: [2, 2] }\n`);
 await writeFile(join(root,'spec/contracts.json'),JSON.stringify({contracts:['contracts'],reference:'js',targets:{js:{host:{command:[process.execPath,'host.mjs']}},other:{host:{command:[process.execPath,'host.mjs']}}}}));
 return root;
}
const settle=async(runner,config,id)=>{for(let i=0;i<300;i++){const r=await runner.getRun(config,id);if(r&&r.state!=='running')return r;await new Promise(r=>setTimeout(r,20));}throw new Error('run did not finish');};

test('contracts: configs are found in projects and described as cases',async t=>{
 const root=await project(t);
 assert.deepEqual(CONFIG_CANDIDATES,['contracts.json','spec/contracts.json','rt-app/spec/contracts.json']);
 const [config]=await findConfigs([{path:root,name:'shop'},{path:join(root,'missing'),name:'x'}]);
 assert.deepEqual([config.project,config.name],['shop','spec/contracts.json']);
 const d=await describe(config.path);
 assert.equal(d.reference,'js');
 assert.deepEqual(d.targets.map(t=>t.name),['js','other']);
 assert.deepEqual(d.contracts[0].cases.map(c=>[c.name,c.steps[0].call,c.steps[0].expect]),[['adds','add(1,2)','3'],['wrong','add(1,1)','3'],['todo','add(2,2)','(not recorded)']]);
 assert.ok((await toolPaths('/h')).includes('/opt/homebrew/bin'));
});

test('contracts: run targets, keep history, record only with the reference',async t=>{
 const root=await project(t),home=await mkdtemp(join(tmpdir(),'sm-contracts-home-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const runner=new ContractRunner({home,paths:[]});
 const [config]=await findConfigs([{path:root,name:'shop'}]);
 const run=await settle(runner,config,(await runner.run(config,{targets:['js','other']})).id);
 assert.equal(run.state,'failed');
 assert.deepEqual(summarize(run.results),{js:{passed:1,failed:1,missing:0,unrecorded:1,skipped:0},other:{passed:1,failed:1,missing:0,unrecorded:1,skipped:0}});
 assert.equal(run.results[0].file,'contracts/calc.contract.yaml');
 const filtered=await settle(runner,config,(await runner.run(config,{targets:['js'],filter:'math'})).id);
 assert.deepEqual([filtered.state,filtered.results.length],['passed',1]);
 const recorded=await settle(runner,config,(await runner.run(config,{record:true,targets:['other']})).id);
 assert.deepEqual([recorded.targets,recorded.recorded],[['js'],1],'record always uses the reference target');
 assert.match(await readFile(join(root,'spec/contracts/calc.contract.yaml'),'utf8'),/args: \[ 2, 2 \], expect: \{ value: 4 \}/);
 const history=await runner.history(config);
 assert.equal(history.length,3);assert.equal('results' in history[0],false);
 assert.equal((await runner.getRun(config,history[2].id)).results.length,6);
 await assert.rejects(runner.run(config,{targets:['nope']}),/at least one target/);
});

test('contracts: configs added by hand',async t=>{
 const root=await project(t),home=await mkdtemp(join(tmpdir(),'sm-contracts-home-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const runner=new ContractRunner({home});
 await runner.addConfig(join(root,'spec/contracts.json'));
 assert.deepEqual(await runner.extra(),[join(root,'spec/contracts.json')]);
 const configs=await findConfigs([],await runner.extra());
 assert.equal(configs[0].added,true);
 await writeFile(join(root,'empty.json'),JSON.stringify({contracts:[],targets:{}}));
 await assert.rejects(runner.addConfig(join(root,'empty.json')),/no targets/);
 await runner.removeConfig(join(root,'spec/contracts.json'));
 assert.deepEqual(await runner.extra(),[]);
});
