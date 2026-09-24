import { readFile, readdir, realpath } from 'node:fs/promises';
import { resolve, relative, join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';

const ignored = new Set(['node_modules', '.git', '.rt-app', 'dist', 'build', 'target', '.next', '.venv', 'venv']);
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 16);

/** Read command declarations without evaluating manifests or executing package scripts. */
export async function projectCommands(root, services = []) {
  root = await realpath(root);
  const groups = [];
  let visited = 0;
  async function visit(dir, depth) {
    if (depth > 4 || ++visited > 400) return;
    const entries = await readdir(dir, { withFileTypes: true });
    const files = new Set(entries.filter(e => e.isFile()).map(e => e.name));
    const cwd = relative(root, dir) || '.';
    const commands = [];
    let label = cwd;
    if (files.has('package.json')) {
      const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
      label = pkg.name || cwd;
      for (const [name, script] of Object.entries(pkg.scripts ?? {})) {
        if (typeof script !== 'string' || !script.trim()) continue;
        const service = services.find(s => s.kind !== 'task' && s.command?.[0] === 'npm' && s.command[1] === 'run' && s.command[2] === name &&
          (s.command.includes('--workspace') ? s.command[s.command.indexOf('--workspace') + 1] === pkg.name : (s.cwd || '.') === cwd));
        commands.push({ name, command: ['npm', 'run', name], description: script, serviceId: service?.id ?? (cwd === '.' && script.trim() === 'rta dev' && services.some(s => s.id === 'api') ? 'all' : cwd === '.' && script.trim() === 'rta admin' && services.some(s => s.id === 'admin') ? 'admin' : undefined) });
      }
    }
    // Python and Go have no universal package.json scripts field. This local contract also works for other runtimes.
    if (files.has('rt-app.commands.json')) {
      const spec = JSON.parse(await readFile(join(dir, 'rt-app.commands.json'), 'utf8'));
      if (spec.version !== 1 || !spec.commands || Array.isArray(spec.commands) || typeof spec.commands !== 'object') throw new Error(`Invalid commands manifest: ${cwd}`);
      label = spec.name || label;
      for (const [name, item] of Object.entries(spec.commands)) {
        if (!item || !Array.isArray(item.command) || !item.command.length || item.command.some(a => typeof a !== 'string' || !a || a.includes('\0')))
          throw new Error(`Invalid command ${cwd}: ${name}`);
        const service = services.find(s => s.kind !== 'task' && (s.cwd || '.') === cwd && JSON.stringify(s.command) === JSON.stringify(item.command));
        commands.push({ name, command: item.command, description: String(item.description || ''), serviceId: service?.id });
      }
    }
    if (commands.length) groups.push({ id: hash(cwd), label, cwd, commands: commands.map(c => ({ ...c, id: hash(cwd + JSON.stringify(c.command)) })) });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && !ignored.has(entry.name)) await visit(join(dir, entry.name), depth + 1);
    }
  }
  await visit(root, 0);
  // Installed admin is served by the core CLI rather than a copied editable workspace.
  const admin = services.find(s => s.id === 'admin');
  if (admin && !groups.some(g => g.commands.some(c => c.serviceId === 'admin'))) {
    groups.push({ id: 'installed-admin', label: 'Admin · installed core', cwd: admin.cwd, commands: [{ id: 'installed-admin-dev', name: 'dev', command: admin.command, description: 'Managed admin development server', serviceId: 'admin' }] });
  }
  return groups;
}

/** Resolve again at execution time; the renderer supplies only an ID, never executable arguments. */
export async function commandSpec(root, id, services) {
  const groups = await projectCommands(root, services);
  const group = groups.find(g => g.commands.some(c => c.id === id));
  const command = group?.commands.find(c => c.id === id);
  if (!command) throw new Error('Command no longer exists; refresh the command list');
  const cwd = await realpath(resolve(root, group.cwd));
  const inside = relative(await realpath(root), cwd);
  if (inside.startsWith('..') || isAbsolute(inside)) throw new Error('Command directory must be inside the project');
  if (command.serviceId) return { serviceId: command.serviceId };
  const workspace = groups.find(g => g.id === group.id);
  const matching = services.find(s => s.command?.includes('--workspace') && s.command[s.command.indexOf('--workspace') + 1] === workspace.label)
    ?? services.find(s => (s.cwd || '.') === group.cwd);
  return { spec: {
    id: `run-${command.id}`, label: `${group.label} · ${command.name}`, command: command.command,
    cwd: group.cwd, kind: 'task', enabled: false, dependencies: [], ports: [],
    env: matching?.env ?? {}, inheritEnv: matching?.inheritEnv ?? [],
  } };
}
