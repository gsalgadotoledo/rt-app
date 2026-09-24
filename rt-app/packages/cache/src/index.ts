import { createHash } from "node:crypto";
export type CacheValue =
  | null
  | boolean
  | number
  | string
  | CacheValue[]
  | { [key: string]: CacheValue };
export interface CacheAdapter {
  get(key: string): Promise<CacheValue | undefined>;
  set(key: string, value: CacheValue, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Canonical JSON keys: object order is irrelevant; unsupported values are rejected. */
export function canonical(value: unknown, seen = new Set<unknown>()): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (typeof value !== "object" || seen.has(value))
    throw new TypeError("Cache requires finite, acyclic JSON values");
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    throw new TypeError("Cache accepts plain objects only");
  seen.add(value);
  try {
    if (Array.isArray(value))
      return (
        "[" + Array.from(value, (item) => canonical(item, seen)).join(",") + "]"
      );
    return (
      "{" +
      Object.keys(value as object)
        .sort()
        .map(
          (key) =>
            JSON.stringify(key) +
            ":" +
            canonical((value as Record<string, unknown>)[key], seen),
        )
        .join(",") +
      "}"
    );
  } finally {
    seen.delete(value);
  }
}

/** Stable scoped hash. @example contentKey("tenant-1:products", {page: 1}) → "tenant-1:products:<sha256>" */
export function contentKey(namespace: string, input: CacheValue): string {
  if (!/^[a-zA-Z0-9:._-]{1,100}$/.test(namespace))
    throw new TypeError("Invalid cache namespace");
  return (
    namespace +
    ":" +
    createHash("sha256").update(canonical(input)).digest("hex")
  );
}

/** Reject empty/oversized keys and TTLs outside the supported 1 ms–30 day range. */
export function validateEntry(key: string, ttlMs: number): void {
  if (
    !key ||
    key.length > 240 ||
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < 1 ||
    ttlMs > 30 * 86400000
  )
    throw new TypeError("Cache needs a key and TTL between 1 ms and 30 days");
}

/** Bounded process-local LRU. Values are cloned to avoid cross-request mutation. */
export class MemoryCache implements CacheAdapter {
  private entries = new Map<string, { value: CacheValue; expires: number }>();
  constructor(
    private maxEntries = 1000,
    private clock = Date.now,
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1)
      throw new TypeError("Invalid cache capacity");
  }
  /** Read a clone and refresh LRU order; expired/missing entries return undefined. */
  async get(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    if (entry.expires <= this.clock()) return undefined;
    this.entries.set(key, entry);
    return structuredClone(entry.value);
  }
  /** Store at most 64 KB of JSON; evict expired entries and then the least recently used. */
  async set(key: string, value: CacheValue, ttlMs: number) {
    validateEntry(key, ttlMs);
    if (Buffer.byteLength(canonical(value)) > 64000)
      throw new TypeError("Cache values are limited to 64 KB");
    for (const [id, entry] of this.entries)
      if (entry.expires <= this.clock()) this.entries.delete(id);
    this.entries.delete(key);
    this.entries.set(key, {
      value: structuredClone(value),
      expires: this.clock() + ttlMs,
    });
    while (this.entries.size > this.maxEntries)
      this.entries.delete(this.entries.keys().next().value!);
  }
  /** Remove a key; deleting an absent key succeeds. */
  async delete(key: string) {
    this.entries.delete(key);
  }
}

/** Cache-aside with concurrent loader deduplication in this process only. */
export class Cache {
  private pending = new Map<string, Promise<CacheValue>>();
  constructor(readonly adapter: CacheAdapter = new MemoryCache()) {}
  /** Read through the selected adapter; undefined means cache miss, null is a cached value. */
  get(key: string) {
    return this.adapter.get(key);
  }
  /** Write a JSON value with an explicit TTL in milliseconds. */
  set(key: string, value: CacheValue, ttlMs: number) {
    return this.adapter.set(key, value, ttlMs);
  }
  /** Invalidate through the adapter; provider errors propagate to the caller. */
  delete(key: string) {
    return this.adapter.delete(key);
  }
  /**
   * Load only on a miss, share in-flight work, and never retain failed loads.
   * @example await cache.remember("user:42", {page: 1}, 1000, () => ["item"]) → ["item"]
   */
  async remember<T extends CacheValue>(
    namespace: string,
    input: CacheValue,
    ttlMs: number,
    load: () => Promise<T> | T,
  ): Promise<T> {
    const key = contentKey(namespace, input);
    validateEntry(key, ttlMs);
    const hit = await this.adapter.get(key);
    if (hit !== undefined) return hit as T;
    let pending = this.pending.get(key);
    if (!pending) {
      pending = Promise.resolve()
        .then(load)
        .then(async (value) => {
          await this.adapter.set(key, value, ttlMs);
          return value;
        });
      this.pending.set(key, pending);
    }
    try {
      return structuredClone(await pending) as T;
    } finally {
      if (this.pending.get(key) === pending) this.pending.delete(key);
    }
  }
}
