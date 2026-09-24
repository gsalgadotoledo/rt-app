import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const ignored = new Set(['node_modules', '.git', '.rt-app', '.venv', 'venv', '__pycache__', 'target', 'dist', 'build']);

/** Run a native dev command, restart its process tree after source edits, and wait for shutdown. */
export async function watchCommand(command, { roots = ['.'], interval = 600, signal } = {}) {
  if (!Array.isArray(command) || !command.length) throw new Error('A development command is required');
  let child;
  let stopping = false;
  const shutdown = () => { stopping = true; };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  signal?.addEventListener('abort', shutdown, { once: true });

  async function fingerprint() {
    const files = [];
    let count = 0;
    async function visit(dir, depth) {
      if (depth > 8 || ++count > 5000) return;
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (ignored.has(entry.name) || entry.name.startsWith('.')) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await visit(path, depth + 1);
        else if (entry.isFile() && (['.py', '.go', '.java', '.mjs', '.toml'].includes(extname(path)) || ['go.mod', 'go.sum'].includes(entry.name))) {
          const info = await stat(path).catch(() => null);
          if (info) files.push(`${path}:${info.mtimeMs}:${info.size}`);
        }
      }
    }
    for (const root of roots) await visit(root, 0);
    return files.sort().join('\n');
  }

  function start() {
    console.log('[dev] Starting', command[0]);
    child = spawn(command[0], command.slice(1), { stdio: 'inherit', env: process.env, detached: process.platform !== 'win32' });
    child.on('error', error => console.error('[dev]', error.message));
    child.on('exit', code => { if (!stopping) console.log(`[dev] Process exited (${code}); waiting for changes`); });
  }

  async function stop() {
    const running = child;
    if (!running?.pid) return;
    if (process.platform === 'win32') {
      await new Promise(resolve => {
        const killer = spawn('taskkill', ['/pid', String(running.pid), '/T', '/F'], { stdio: 'ignore' });
        killer.once('error', resolve); killer.once('exit', resolve);
      });
    } else {
      try { process.kill(-running.pid, 'SIGTERM'); } catch {}
      for (let i = 0; i < 20 && running.exitCode === null && running.signalCode === null; i++) await delay(50);
      // Kill remaining descendants, including executables spawned by `go run`.
      try { process.kill(-running.pid, 'SIGKILL'); } catch {}
    }
    child = undefined;
  }

  try {
    let before = await fingerprint();
    if (signal?.aborted) return;
    start();
    while (!stopping) {
      await delay(interval);
      if (stopping) break;
      const after = await fingerprint();
      if (before !== after) {
        before = after;
        console.log('[dev] Source changed; restarting');
        await stop();
        if (!stopping) start();
      }
    }
  } finally {
    await stop();
    process.removeListener('SIGTERM', shutdown);
    process.removeListener('SIGINT', shutdown);
    signal?.removeEventListener('abort', shutdown);
  }
}
