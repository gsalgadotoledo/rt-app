import {defineConfig} from 'vite';
import {readFileSync} from 'node:fs';
import {viteConfiguration,settingsEnv} from '@gsalgadotoledo/rt-app-config';
// Without rta dev, this project's ports come from rt-app.settings.json.
const settings=JSON.parse(readFileSync(new URL('../../rt-app.settings.json',import.meta.url),'utf8'));
export default defineConfig(viteConfiguration({...settingsEnv(settings),...process.env}));
