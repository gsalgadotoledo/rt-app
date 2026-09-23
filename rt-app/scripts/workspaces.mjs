import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const workspaces = new Map();
const query = spawnSync('npm', ['query', '.workspace', '--json'], {encoding:'utf8'});
if (query.status !== 0) throw new Error(query.stderr || 'Run npm install first');
for (const entry of JSON.parse(query.stdout)) {
  const dir = entry.location;
  const pkg = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'));
  if (workspaces.has(pkg.name)) throw new Error(`Duplicate workspace: ${pkg.name}`);
  workspaces.set(pkg.name, {dir, pkg});
}
const order = [], active = new Set(), done = new Set();
function visit(name, path = []) {
  if (active.has(name)) throw new Error(`Workspace cycle: ${[...path, name].join(' -> ')}`);
  if (done.has(name)) return;
  active.add(name);
  const { dir, pkg } = workspaces.get(name);
  for (const dependency of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies })) {
    if (!workspaces.has(dependency)) continue;
    if (dir.startsWith('rt-app') && workspaces.get(dependency).dir.startsWith('apps/')) {
      throw new Error(`Library ${name} must not depend on app ${dependency}`);
    }
    visit(dependency, [...path, name]);
  }
  active.delete(name); done.add(name); order.push(name);
}
for (const name of workspaces.keys()) visit(name);
console.log(`Architecture OK: ${order.length} workspaces, no manifest cycles or packages -> apps dependencies.`);
if (process.argv[2] === 'build') {
  for (const name of order) {
    if (!workspaces.get(name).pkg.scripts?.build) continue;
    const result = spawnSync('npm', ['run', 'build', '-w', name], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
