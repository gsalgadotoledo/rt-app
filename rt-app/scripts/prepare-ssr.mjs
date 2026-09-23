import {writeFile} from 'node:fs/promises';
import {publicConfig,environmentVariables} from '@gsalgadotoledo/rt-app-config';
const config=publicConfig();
if(config.environment==='local')throw new Error('Amplify requires an explicit cloud environment');
const expected=process.env.RT_APP_REVISION;
if(expected && /^[a-f0-9]{40}$/.test(expected) && process.env.AWS_COMMIT_ID!==expected)throw new Error('Amplify checked out a different revision than the deployed API; refusing to publish');
// Amplify build variables are not automatically inherited by SSR compute.
// Copy only validated public configuration; never copy the full environment.
await writeFile('apps/ssr/.env.production',Object.entries(environmentVariables(config)).map(([key,value])=>`${key}=${JSON.stringify(value)}`).join('\n')+'\n',{mode:0o600});
