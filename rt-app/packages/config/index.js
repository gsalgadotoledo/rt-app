/** Only public, explicitly allowlisted configuration crosses into a browser. */
export const localUrls = Object.freeze({api:'http://127.0.0.1:4010',admin:'http://127.0.0.1:5174',spa:'http://127.0.0.1:5175',ssr:'http://127.0.0.1:5176'});
export function publicConfig(env = process.env) {
  const environment = env.RT_APP_ENVIRONMENT ?? 'local';
  if (!['local','develop','stage','prod'].includes(environment)) throw new Error('Invalid RT_APP_ENVIRONMENT');
  const urls = {};
  for (const role of Object.keys(localUrls)) {
    const value = env[`RT_APP_${role.toUpperCase()}_URL`] || (environment === 'local' ? localUrls[role] : undefined);
    if (!value) throw new Error(`Missing RT_APP_${role.toUpperCase()}_URL for ${environment}`);
    const url = new URL(value);
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(`Invalid ${role} URL`);
    if (environment !== 'local' && url.protocol !== 'https:') throw new Error('Cloud URLs must use HTTPS');
    urls[role] = url.href.replace(/\/$/, '');
  }
  return Object.freeze({environment,urls:Object.freeze(urls)});
}
export function environmentVariables(config) {
  return Object.fromEntries([['RT_APP_ENVIRONMENT',config.environment],...Object.entries(config.urls).map(([role,url])=>[`RT_APP_${role.toUpperCase()}_URL`,url])]);
}
export function browserApiUrl(config) { return config.environment === 'local' ? '/api' : config.urls.api; }
export function viteConfiguration(env = process.env, role = 'spa') {
  const config = publicConfig(env);
  return {define:{__RT_APP_CONFIG__:JSON.stringify(config)},server:{host:'127.0.0.1',port:Number(new URL(config.urls[role]).port),strictPort:true,proxy:{'/api':{target:config.urls.api,rewrite:path=>path.replace(/^\/api/,'')}}}};
}

/**
 * Resolve where and how the application runs. AWS credentials alone never turn a development
 * process into a cloud runtime. `portable` is a deployed process outside AWS (Render, Railway,
 * Fly.io, DigitalOcean, Heroku): Postgres through DATABASE_URL and secrets from the environment.
 */
export function runtimeConfig(settings, env = process.env) {
  const lambda = Boolean(env.AWS_LAMBDA_FUNCTION_NAME || env.AWS_LAMBDA_RUNTIME_API);
  const explicit = env.RT_APP_TARGET;
  if (explicit && !['local','aws','portable'].includes(explicit)) throw new Error('Invalid RT_APP_TARGET');
  if (lambda && (explicit === 'local' || explicit === 'portable' || (env.RT_APP_MODE && env.RT_APP_MODE !== 'aws'))) throw new Error('Lambda cannot use local data adapters');
  const target = lambda ? 'aws' : (explicit ?? (env.RT_APP_MODE === 'aws' ? 'aws' : env.RT_APP_MODE === 'portable' ? 'portable' : 'local'));
  const profile = settings?.runtime?.[target] ?? (target === 'portable' ? {mode:'portable'} : undefined);
  if (!profile) throw new Error(`Missing ${target} runtime settings`);
  const mode = env.RT_APP_MODE ?? profile.mode;
  if (target === 'aws' && mode !== 'aws') throw new Error('AWS requires the cloud adapter');
  if (target === 'portable' && mode !== 'portable') throw new Error('Portable deployments require the portable adapter');
  if (target === 'local' && !['json','memory','dynamodb-local','postgres'].includes(mode)) throw new Error('Unsupported local adapter');
  return {target,mode};
}
