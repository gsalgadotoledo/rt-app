import {copyStarter, packageRoot} from '../index.mjs';
import {resolve,join} from 'node:path';
import {rm,mkdir} from 'node:fs/promises';
const repository=resolve(packageRoot,'../../..');
const destination=join(packageRoot,'starter');
await rm(destination,{recursive:true,force:true});
await mkdir(destination);
await copyStarter(join(repository,'templates/hello-world'),destination);
// Reuse one framework source tree; never maintain a second editable core in templates.
await copyStarter(repository,destination,["rt-app"]);
console.log("Prepared sanitized starter: "+destination);
