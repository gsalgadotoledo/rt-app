import {
  canonical,
  validateEntry,
  type CacheAdapter,
  type CacheValue,
} from "@gsalgadotoledo/rt-app-cache";
/** Compatible with a connected node-redis client. The caller owns its connection lifecycle. */
export interface RedisCacheClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { PX: number }): Promise<unknown>;
  del(key: string): Promise<unknown>;
}
export class RedisCache implements CacheAdapter {
  constructor(
    private client: RedisCacheClient,
    private prefix = "rt-app:cache:",
  ) {}
  async get(key: string): Promise<CacheValue | undefined> {
    const value = await this.client.get(this.prefix + key);
    return value === null ? undefined : JSON.parse(value);
  }
  async set(key: string, value: CacheValue, ttlMs: number) {
    validateEntry(key, ttlMs);
    const json = canonical(value);
    if (Buffer.byteLength(json) > 64000)
      throw new TypeError("Cache values are limited to 64 KB");
    await this.client.set(this.prefix + key, json, { PX: ttlMs });
  }
  async delete(key: string) {
    await this.client.del(this.prefix + key);
  }
}
