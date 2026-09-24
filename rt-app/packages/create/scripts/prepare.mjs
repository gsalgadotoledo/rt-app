import {copyStarter, packageRoot} from '../index.mjs';
import {resolve,join} from 'node:path';
import {rm,mkdir} from 'node:fs/promises';

const repository=resolve(packageRoot,'../../..');
const destination=join(packageRoot,'starter');
await rm(destination,{recursive:true,force:true});
await mkdir(destination);
await copyStarter(join(repository,'templates/hello-world'),destination);
// Only language reference libraries are shipped as source until their own registries are enabled.
const languages=join(packageRoot,'languages');
await rm(languages,{recursive:true,force:true});
await mkdir(languages);
await copyStarter(join(repository,'rt-app'),languages,['core-go','core-python']);
console.log('Prepared application-only starter: '+destination);
