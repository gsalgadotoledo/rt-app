import test from 'node:test';
import assert from 'node:assert/strict';
import {PHASE_DEVELOPMENT_SERVER,PHASE_PRODUCTION_BUILD,PHASE_PRODUCTION_SERVER} from 'next/constants.js';
import config from '../next.config.mjs';
test('development output is isolated from builds and production keeps the Amplify directory',()=>{
 const dev=config(PHASE_DEVELOPMENT_SERVER),build=config(PHASE_PRODUCTION_BUILD),start=config(PHASE_PRODUCTION_SERVER);
 assert.notEqual(dev.distDir,build.distDir);
 assert.equal(build.distDir,'.next');
 assert.equal(start.distDir,build.distDir);
 assert.ok(!dev.distDir.startsWith(build.distDir+'/'));
});
