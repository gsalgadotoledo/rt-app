import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Conflict, HttpError } from '@gsalgadotoledo/rt-app-contracts';
import { requiredCapabilities, type NoSQL, type Row, type Write } from '@gsalgadotoledo/rt-app-nosql';
const key = (r: Row) => JSON.stringify([r.pk, r.sk]);
function valid(r: any): r is Row {
  return r && typeof r.pk === 'string' && typeof r.sk === 'string' && Number.isSafeInteger(r.version) && r.data && typeof r.data === 'object' && !Array.isArray(r.data);
}
/** Small local databases only. Lock and atomic rename coordinate processes on a local filesystem. */
export class JsonStore implements NoSQL {
  readonly provider = 'json';
  readonly capabilities = requiredCapabilities;
  readonly file: string;
  constructor(file: string, private lockTimeout = 5000) { this.file = resolve(file); }
  private async locked<T>(operation: (rows: Map<string, Row>) => Promise<T> | T): Promise<T> {
    await mkdir(dirname(this.file), {recursive:true, mode:0o700});
    const lock = this.file + '.lock', deadline = Date.now() + this.lockTimeout;
    let handle;
    while (!handle) {
      try { handle = await open(lock, 'wx', 0o600); }
      catch (error: any) {
        if (error.code !== 'EEXIST') throw error;
        if (Date.now() >= deadline) throw new Error(`JSON store locked: ${lock}. Stop writers before removing a stale lock.`);
        await delay(20);
      }
    }
    try {
      let data: any = {format:1, rows:[]};
      try { data = JSON.parse(await readFile(this.file, 'utf8')); }
      catch (error: any) { if (error.code !== 'ENOENT') throw error; }
      if (data.format !== 1 || !Array.isArray(data.rows) || !data.rows.every(valid)) throw new Error('Invalid JSON database');
      const rows = new Map<string, Row>(data.rows.map((r: Row) => [key(r),r]));
      if (rows.size !== data.rows.length) throw new Error('Duplicate JSON database key');
      return await operation(rows);
    } finally { await handle.close(); await unlink(lock); }
  }
  get(pk: string, sk: string) { return this.locked(rows => structuredClone(rows.get(JSON.stringify([pk,sk])))); }
  transact(writes: Write[]) {
    // Snapshot before awaiting: callers cannot change a queued transaction.
    const snapshot = JSON.parse(JSON.stringify(writes)) as Write[];
    return this.locked(async rows => {
      const seen = new Set<string>();
      for (const w of snapshot) {
        if (!valid(w.row)) throw new Error('Invalid JSON row');
        const k = key(w.row);
        if (seen.has(k)) throw new Error('Duplicate transaction key');
        seen.add(k);
        const old = rows.get(k);
        if (w.expected === null ? !!old : old?.version !== w.expected) throw new Conflict();
      }
      for (const w of snapshot) { if (w.delete) rows.delete(key(w.row)); else rows.set(key(w.row),w.row); }
      // Observer retention also applies to the local JSON adapter.
      for (const [k,row] of rows) if(row.pk.startsWith('OBSERVER#') && row.ttl && row.ttl <= Date.now()/1000) rows.delete(k);
      const temp = this.file + '.' + randomUUID() + '.tmp';
      try {
        const out = await open(temp, 'wx', 0o600);
        try { await out.writeFile(JSON.stringify({format:1,rows:[...rows.values()]})); await out.sync(); }
        finally { await out.close(); }
        await rename(temp, this.file);
      } finally { await unlink(temp).catch((e: any) => { if (e.code !== 'ENOENT') throw e; }); }
    });
  }
  list(pk: string, cursor?: string) {
    let after = '';
    if (cursor) {
      try { const c = JSON.parse(Buffer.from(cursor,'base64url').toString()); if (c.pk !== pk || typeof c.sk !== 'string') throw 0; after=c.sk; }
      catch { throw new HttpError(400,'Invalid cursor'); }
    }
    return this.locked(rows => {
      const all = [...rows.values()].filter(r=>r.pk===pk && r.sk>after).sort((a,b)=>a.sk<b.sk?-1:1);
      const items=all.slice(0,50);
      return {items, cursor:all.length>50 ? Buffer.from(JSON.stringify({pk,sk:items.at(-1)!.sk})).toString('base64url') : undefined};
    });
  }
}
