import {PHASE_DEVELOPMENT_SERVER} from 'next/constants.js';
import {readFileSync} from 'node:fs';
import {publicConfig,settingsEnv} from '@gsalgadotoledo/rt-app-config';
// Without rta dev, this project's ports come from rt-app.settings.json (also for page rendering).
Object.assign(process.env,settingsEnv(JSON.parse(readFileSync(new URL('../../rt-app.settings.json',import.meta.url),'utf8'))));
export default phase => ({
  // A production build must never overwrite a running dev server's modules.
  distDir: phase === PHASE_DEVELOPMENT_SERVER ? '.next-dev' : '.next',
  poweredByHeader:false,
  transpilePackages:['@gsalgadotoledo/rt-app-auth','@gsalgadotoledo/rt-app-admin-ui','@gsalgadotoledo/rt-app-config'],
  async rewrites() {
    const config=publicConfig();
    return config.environment==='local' ? [{source:'/api/:path*',destination:`${config.urls.api}/:path*`}] : [];
  },
});
