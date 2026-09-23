import {test} from 'node:test';
import assert from 'node:assert/strict';
import {publicConfig,environmentVariables,browserApiUrl,viteConfiguration} from '../index.js';
test('local defaults and public allowlist exclude secrets',()=>{
 const config=publicConfig({AWS_SECRET_ACCESS_KEY:'secret',ADMIN_PASSWORD:'private'});
 assert.equal(config.urls.ssr,'http://127.0.0.1:5176');assert.equal(browserApiUrl(config),'/api');
 const exposed=JSON.stringify(config);assert.doesNotMatch(exposed,/secret|private|PASSWORD|AWS/);
 assert.deepEqual(publicConfig(environmentVariables(config)),config);
});
test('each cloud environment requires explicit HTTPS URLs and no credentials',()=>{
 for(const environment of ['develop','stage','prod']) {
  const env={RT_APP_ENVIRONMENT:environment};
  assert.throws(()=>publicConfig(env),/Missing/);
  for(const role of ['API','ADMIN','SPA','SSR'])env[`RT_APP_${role}_URL`]=`https://${role.toLowerCase()}.${environment}.example.test`;
  const config=publicConfig(env);assert.equal(browserApiUrl(config),env.RT_APP_API_URL);
  assert.equal(JSON.parse(viteConfiguration(env).define.__RT_APP_CONFIG__).environment,environment);
  assert.throws(()=>publicConfig({...env,RT_APP_API_URL:'http://localhost:4010'}),/HTTPS/);
  assert.throws(()=>publicConfig({...env,RT_APP_API_URL:'https://user:password@example.test'}),/Invalid/);
 }
});

test('runtime selection detects Lambda, respects explicit target, never infers AWS from keys',async()=>{
 const {runtimeConfig}=await import('../index.js');const settings={runtime:{local:{mode:'json'},aws:{mode:'aws'}}};
 assert.equal(runtimeConfig(settings,{AWS_ACCESS_KEY_ID:'test',AWS_SECRET_ACCESS_KEY:'test'}).target,'local');
 assert.equal(runtimeConfig(settings,{AWS_LAMBDA_FUNCTION_NAME:'api'}).mode,'aws');
 assert.equal(runtimeConfig(settings,{AWS_LAMBDA_RUNTIME_API:'127.0.0.1:9001'}).target,'aws');
 assert.equal(runtimeConfig(settings,{RT_APP_TARGET:'aws'}).mode,'aws');
 assert.equal(runtimeConfig(settings,{RT_APP_MODE:'memory'}).mode,'memory');
 assert.throws(()=>runtimeConfig(settings,{AWS_LAMBDA_FUNCTION_NAME:'api',RT_APP_TARGET:'local'}),/cannot use local/);
 assert.throws(()=>runtimeConfig(settings,{RT_APP_TARGET:'invalid'}),/Invalid/);
});

test('Vite binds the configured port and injects matching frontend/API URLs',()=>{
 const config=viteConfiguration({RT_APP_API_URL:'http://localhost:14010',RT_APP_SPA_URL:'http://localhost:15175'});
 assert.equal(config.server.port,15175);assert.equal(config.server.proxy['/api'].target,'http://localhost:14010');
 assert.equal(JSON.parse(config.define.__RT_APP_CONFIG__).urls.spa,'http://localhost:15175');
});
