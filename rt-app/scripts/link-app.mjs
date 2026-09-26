#!/usr/bin/env node
/**
 * Use this local core in an application while developing, without publishing.
 *
 *   npm run link:app -- ~/Desktop/rt-apps/my-app     # symlink every @gsalgadotoledo package to this checkout
 *   npm run link:app -- ~/Desktop/rt-apps/my-app --status
 *   npm run unlink:app -- ~/Desktop/rt-apps/my-app   # back to the published versions (npm install)
 *
 * Every installed @gsalgadotoledo/* package of the app (root and nested node_modules) that exists
 * in this monorepo is replaced by a symlink to its folder here. Packages resolve their own
 * dependencies from this checkout. Rebuild the core after changes (`npm run build`, or
 * `npm run build --workspace <package>`); the app picks up the new dist on its next start.
 * The app's package.json and package-lock.json are not modified.
 */
import {execFileSync, spawnSync} from 'node:child_process';
import {existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const SCOPE = '@gsalgadotoledo';
const core = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** name → folder of every package in this monorepo (generated starters excluded). */
export function corePackages(root = core) {
  const files = execFileSync('git', ['ls-files', '*package.json'], {cwd: root, encoding: 'utf8'}).split('\n').filter(f => f && !f.includes('/starter/') && !f.startsWith('templates/'));
  const packages = new Map();
  for (const file of files) {
    const pkg = JSON.parse(readFileSync(join(root, file), 'utf8'));
    if (pkg.name?.startsWith(SCOPE + '/') && !pkg.private) packages.set(pkg.name, join(root, dirname(file)));
  }
  return packages;
}

/** Every node_modules/@gsalgadotoledo folder of the app, skipping the linked packages themselves. */
function scopeFolders(app) {
  const found = [];
  const visit = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try { entries = readdirSync(dir, {withFileTypes: true}); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '.git' || entry.name === '.rt-app') continue;
      const path = join(dir, entry.name);
      if (entry.name === 'node_modules') {
        if (existsSync(join(path, SCOPE))) found.push(join(path, SCOPE));
        // nested node_modules of non-linked dependencies (npm can install duplicates there)
        for (const child of readdirSync(path, {withFileTypes: true})) {
          if (!child.isDirectory() || child.name === SCOPE || child.name.startsWith('.')) continue;
          const nested = child.name.startsWith('@') ? readdirSync(join(path, child.name)).map(n => join(path, child.name, n)) : [join(path, child.name)];
          for (const pkg of nested) if (existsSync(join(pkg, 'node_modules', SCOPE))) found.push(join(pkg, 'node_modules', SCOPE));
        }
      } else if (!['dist', 'build', 'target', '.next', 'coverage'].includes(entry.name)) visit(path, depth + 1);
    }
  };
  visit(app, 0);
  return found;
}

/** A symlink created by link(): it points into this checkout. */
function isCoreLink(path) {
  return lstatSync(path).isSymbolicLink() && resolve(dirname(path), readlinkSync(path)).startsWith(core + '/');
}

function stateFile(app) { return join(app, '.rt-app', 'core-link.json'); }

export function link(app, {packages = corePackages(), log = console.log} = {}) {
  if (!existsSync(join(app, 'package.json'))) throw new Error('Not a project folder: ' + app);
  const linked = [], missing = new Set();
  for (const folder of scopeFolders(app)) {
    for (const name of readdirSync(folder)) {
      const full = `${SCOPE}/${name}`, target = packages.get(full), path = join(folder, name);
      if (lstatSync(path).isSymbolicLink() && !isCoreLink(path)) continue; // the app's own workspaces
      if (!target) { missing.add(full); continue; }
      if (lstatSync(path).isSymbolicLink() && resolve(dirname(path), readlinkSync(path)) === target) { linked.push(relative(app, path)); continue; }
      rmSync(path, {recursive: true, force: true});
      symlinkSync(target, path, 'dir');
      linked.push(relative(app, path));
    }
  }
  if (!linked.length) throw new Error('No installed @gsalgadotoledo packages found. Run npm install in the app first.');
  const unbuilt = [...new Set(linked.map(p => packages.get(`${SCOPE}/${p.split('/').at(-1)}`)))].filter(dir => {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    return pkg.main?.startsWith('./dist') && !existsSync(join(dir, pkg.main));
  });
  mkdirSync(join(app, '.rt-app'), {recursive: true});
  writeFileSync(stateFile(app), JSON.stringify({core, linkedAt: new Date().toISOString(), packages: linked}, null, 2) + '\n');
  log(`Linked ${linked.length} package folders of ${app} to ${core}.`);
  if (missing.size) log(`Kept published (not in this checkout): ${[...missing].join(', ')}`);
  if (unbuilt.length) log(`Build these first (npm run build in ${core}): ${unbuilt.map(d => relative(core, d)).join(', ')}`);
  log('Rebuild the core after changes; restart the app to load them. Undo with: npm run unlink:app -- ' + app);
  return linked;
}

export function status(app, {log = console.log} = {}) {
  const links = [];
  for (const folder of scopeFolders(app)) for (const name of readdirSync(folder)) {
    const path = join(folder, name);
    if (isCoreLink(path)) links.push([relative(app, path), readlinkSync(path)]);
  }
  log(links.length ? `${links.length} linked:\n` + links.map(([p, t]) => `  ${p} → ${t}`).join('\n') : 'Using published packages (nothing linked).');
  return links;
}

export function unlink(app, {install = true, log = console.log} = {}) {
  let removed = 0;
  for (const folder of scopeFolders(app)) for (const name of readdirSync(folder)) {
    const path = join(folder, name);
    if (isCoreLink(path)) { rmSync(path); removed++; }
  }
  rmSync(stateFile(app), {force: true});
  log(`Removed ${removed} links.`);
  if (install && removed) {
    log('Restoring published packages (npm install)…');
    const result = spawnSync('npm', ['install', '--no-audit', '--no-fund'], {cwd: app, stdio: 'inherit'});
    if (result.status !== 0) throw new Error('npm install failed; run it in ' + app);
  }
  return removed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, target, flag] = process.argv.slice(2);
  try {
    if (!target) throw new Error('Usage: npm run link:app -- <app folder> [--status]  |  npm run unlink:app -- <app folder>');
    const app = resolve(target.replace(/^~(?=\/)/, process.env.HOME));
    if (command === 'link') flag === '--status' ? status(app) : link(app);
    else if (command === 'unlink') unlink(app);
    else throw new Error('Unknown command');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
