import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { build, createServer } from 'vite';
import { viteConfiguration } from '@gsalgadotoledo/rt-app-config';

const root = fileURLToPath(new URL('.', import.meta.url));

// Keep per-project registries and generated assets separate from the installed admin package.
export async function runAdmin({ projectRoot = process.cwd(), mode = 'dev' } = {}) {
  projectRoot = resolve(projectRoot);
  process.env.RT_APP_PROJECT_ROOT = projectRoot;
  const configuration = {
    ...viteConfiguration(process.env, 'admin'),
    root,
    configFile: join(root, 'vite.config.ts'),
    cacheDir: join(projectRoot, '.rt-app/vite-admin'),
    build: { outDir: join(projectRoot, '.rt-app/admin'), emptyOutDir: true },
  };
  if (mode === 'build') return build(configuration);
  const server = await createServer(configuration);
  await server.listen();
  server.printUrls();
  return server;
}
