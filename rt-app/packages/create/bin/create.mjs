#!/usr/bin/env node
import {createProject,templates} from '../index.mjs';
import {Toolchains} from '../runtime.mjs';
const args=process.argv.slice(2);const get=key=>{const index=args.indexOf('--'+key);return index<0?undefined:args[index+1];};
try{
 if(args.includes('--list'))console.log(JSON.stringify(await templates(),null,2));
 else if(args.includes('--install-tools')){const tools=new Toolchains();await tools.install((get('install-tools')??'node').split(','),text=>process.stderr.write(text+'\n'));}
 else if(args.includes('--help')||!args.length)console.log('rt-app-create --workspace /path --name my-app --template fullstack --backend node-ts|python|go|java [--no-install]\nrt-app-create --list\nrt-app-create --install-tools node,go,python,java\n\nFor new projects prefer: npm create @gsalgadotoledo/rt-app my-app');
 else{const result=await createProject({workspace:get('workspace'),name:get('name'),templateId:get('template')??'fullstack',backendId:get('backend')??'node-ts',install:!args.includes('--no-install'),env:await new Toolchains().environment(),onLog:text=>process.stderr.write(text+'\n')});console.log(JSON.stringify(result));}
}catch(error){console.error(error.message);process.exitCode=1;}
