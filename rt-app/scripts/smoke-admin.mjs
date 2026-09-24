import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';

// Run only against the installed release fixture, never the user's running projects.
const root = process.argv[2];
const listener = createServer().listen(0, '127.0.0.1');
await once(listener, 'listening');
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const child = spawn(process.execPath, [join(root, 'node_modules/@gsalgadotoledo/rt-app-cli/bin/rta.mjs'), 'admin'], {
  cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
  env: {...process.env, RT_APP_ADMIN_URL:'http://127.0.0.1:'+port},
});
let logs = '';
child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-10000); });
child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-10000); });
const exit = once(child, 'exit');
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(logs);
    try {
      const response = await fetch('http://127.0.0.1:'+port+'/modules/users', {signal:AbortSignal.timeout(1000)});
      if (response.ok && (await response.text()).includes('id="root"')) { ready = true; break; }
    } catch {}
    await delay(100);
  }
  if (!ready) throw new Error('Installed admin did not serve a deep route: '+logs);
  const module = await fetch('http://127.0.0.1:'+port+'/src/browser.tsx');
  if (!module.ok) throw new Error('Admin entry point failed to transform: '+await module.text());
  console.log('Installed admin serves deep routes and transforms its entry point.');
} finally {
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  await exit;
  clearTimeout(timer);
}
