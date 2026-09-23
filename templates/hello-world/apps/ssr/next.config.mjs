import {PHASE_DEVELOPMENT_SERVER} from 'next/constants.js';
import {publicConfig} from '@gsalgadotoledo/rt-app-config';
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
