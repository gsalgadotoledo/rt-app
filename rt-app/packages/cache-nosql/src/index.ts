import {
  canonical,
  validateEntry,
  type CacheAdapter,
  type CacheValue,
} from "@gsalgadotoledo/rt-app-cache";
import { Conflict } from "@gsalgadotoledo/rt-app-contracts";
import type { NoSQL } from "@gsalgadotoledo/rt-app-nosql";
import { createHash } from "node:crypto";

/** TTL is enforced on reads; provider TTL cleanup may happen later. */
export class NoSQLCache implements CacheAdapter {
  constructor(
    private store: NoSQL,
    private namespace = "default",
    private clock = Date.now,
  ) {}
  private address(key: string) {
    return {
      pk: "CACHE#" + this.namespace,
      sk: createHash("sha256").update(key).digest("hex"),
    };
  }
  /** Enforce expiry during reads even when provider TTL cleanup is delayed. */
  async get(key: string): Promise<CacheValue | undefined> {
    const { pk, sk } = this.address(key),
      row = await this.store.get(pk, sk);
    return row && row.data.expires > this.clock()
      ? structuredClone(row.data.value)
      : undefined;
  }
  /** Store validated JSON with CAS; retry conflicts up to four attempts. */
  async set(key: string, value: CacheValue, ttlMs: number): Promise<void> {
    validateEntry(key, ttlMs);
    const json = canonical(value);
    if (Buffer.byteLength(json) > 64000)
      throw new TypeError("Cache values are limited to 64 KB");
    const data = { value: JSON.parse(json), expires: this.clock() + ttlMs };
    await this.mutate(key, async (row) => ({
      row: {
        ...this.address(key),
        version: (row?.version ?? 0) + 1,
        data,
        ttl: Math.ceil(data.expires / 1000),
      },
      expected: row?.version ?? null,
    }));
  }
  /** Idempotent removal with a version check so concurrent replacement is not silently lost. */
  async delete(key: string): Promise<void> {
    await this.mutate(key, async (row) =>
      row ? { row, expected: row.version, delete: true } : undefined,
    );
  }
  /** Re-read on conflict; propagate infrastructure errors without retrying them. */
  private async mutate(
    key: string,
    operation: (row: any) => Promise<any>,
  ): Promise<void> {
    const { pk, sk } = this.address(key);
    for (let attempt = 0; attempt < 4; attempt++) {
      const write = await operation(await this.store.get(pk, sk));
      if (!write) return;
      try {
        await this.store.transact([write]);
        return;
      } catch (error) {
        if (!(error instanceof Conflict) || attempt === 3) throw error;
      }
    }
  }
}
