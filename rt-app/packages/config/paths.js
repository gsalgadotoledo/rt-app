import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';

// Resolve installed packages or linked development workspaces through Node itself.
export function packageDirectory(name, projectRoot = process.cwd()) {
  const resolvers = [createRequire(join(resolve(projectRoot), 'package.json')), createRequire(import.meta.url)];
  for (const resolver of resolvers) {
    try { return dirname(resolver.resolve(name + '/package.json')); }
    catch (error) { if (!['MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED'].includes(error.code)) throw error; }
  }
  throw new Error('Missing package ' + name + '. Run npm install in the project.');
}

export function packageFile(name, path, projectRoot = process.cwd()) {
  return join(packageDirectory(name, projectRoot), path);
}

// Legacy source projects keep working; installed projects write assets outside node_modules.
export function adminAssets(projectRoot = process.cwd()) {
  const legacy = join(projectRoot, 'rt-app/admin/dist/web');
  return existsSync(legacy) ? legacy : join(projectRoot, '.rt-app/admin');
}
