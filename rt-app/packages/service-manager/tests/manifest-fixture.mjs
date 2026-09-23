import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Exercise npm workspace discovery without coupling the test to the repository layout.
export async function manifestFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'rt-manifest-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rtApp = {};
  for (const role of ['backend', 'admin', 'spa', 'ssr']) {
    rtApp[role] = 'fixture-' + role;
    await mkdir(join(root, role));
    await writeFile(join(root, role, 'package.json'), JSON.stringify({
      name: rtApp[role], version: '1.0.0', scripts: { dev: 'node index.js' },
    }));
  }
  await writeFile(join(root, 'package.json'), JSON.stringify({
    private: true, workspaces: ['backend', 'admin', 'spa', 'ssr'], rtApp,
  }));
  await writeFile(join(root, 'rt-app.settings.json'), JSON.stringify({
    version: 1, runtime: { local: { mode: 'json' } },
  }));
  await promisify(execFile)('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: root });
  return root;
}
