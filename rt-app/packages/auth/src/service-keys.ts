import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { NoSQL as Store, Row, Write } from "@gsalgadotoledo/rt-app-nosql";
import {
  HttpError,
  Conflict,
  epochMs,
  type Actor,
  type Clock,
  type Endpoint,
  type Feature,
} from "@gsalgadotoledo/rt-app-contracts";
import { rateLimit } from "./limits.js";

/**
 * Scoped service keys: credentials for backends (an agent server metering credits) that must
 * not hold the admin root password. A key is presented as `Authorization: Bearer
 * rtsk_<id>.<secret>` and authenticates ONLY endpoints with `access: "service"` (served under
 * `/service/...`) whose `resource` is one of the key's scopes. It never reaches /admin/*,
 * user, settings or plan endpoints: those use the admin root or user sessions.
 *
 * Keys come from the configuration (`RT_APP_SERVICE_KEYS`, JSON, or the file named by
 * `RT_APP_SERVICE_KEYS_FILE`) or are managed by the admin (create: the token is shown once;
 * rotate; revoke). Only `sha256hex(token)` is stored. See docs/polyglot/service-keys.md;
 * the row formats below are shared with the Python and Go ports.
 */

/** Token prefix; the full token is `rtsk_<id>.<secret>`. */
export const SERVICE_KEY_PREFIX = "rtsk_";
const TOKEN = /^rtsk_([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{32,128})$/;
const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SECRET = /^[A-Za-z0-9_-]{32,128}$/;
const HASH = /^[0-9a-f]{64}$/;
/** Compared when the key id is unknown, so every failure costs one hash and one compare. */
const NO_HASH = "0".repeat(64);

/** Admin-managed keys: SERVICE_KEYS / <id>. */
export const SERVICE_KEYS = "SERVICE_KEYS";
/** Last use per key (configured and managed): SERVICE_KEY_USE / <id> → {lastUsedAt}. */
export const SERVICE_KEY_USE = "SERVICE_KEY_USE";
/** Management audit: SERVICE_KEY_AUDIT#<id> / pad15(at)-pad10(version). */
export const serviceKeyAudit = (id: string) => "SERVICE_KEY_AUDIT#" + id;

/** Requests per minute per key unless the key says otherwise. */
export const DEFAULT_SERVICE_RATE_LIMIT = 600;
export const MAX_SERVICE_RATE_LIMIT = 100_000;
/** lastUsedAt is written at most once per minute per key. */
export const SERVICE_KEY_TOUCH_MS = 60_000;

/** The resource of `GET /service/keys/self` (a key's own description, for startup checks). */
export const SERVICE_SELF = "service-keys.self";

export const INVALID_SERVICE_KEY = "Invalid service key";
export const SERVICE_KEY_REQUIRED = "Service key required";
export const SERVICE_KEY_SCOPE = "Service key not allowed for this resource";
const INVALID_CONFIGURATION = "Invalid service key configuration";

/** One configured key (RT_APP_SERVICE_KEYS), as written by the operator. */
export interface ServiceKeyConfig {
  id: string;
  /** sha256 hex of the full token `rtsk_<id>.<secret>` (preferred: the secret is not in the config). */
  secretHash?: string;
  /** The secret part (32 to 128 of A-Z a-z 0-9 _ -); hashed at startup. */
  secret?: string;
  scopes: string[];
  description?: string;
  rateLimit?: number;
}

interface KeyRecord {
  id: string;
  secretHash: string;
  scopes: string[];
  description: string;
  rateLimit: number;
  source: "env" | "admin";
  createdAt: number | null;
  createdBy: string | null;
  rotatedAt: number | null;
  revokedAt: number | null;
  revokedBy: string | null;
}

/** sha256 hex of the UTF-8 token: the stored form of a key. */
export const serviceKeyHash = (token: string) => createHash("sha256").update(token).digest("hex");

const base64url = (bytes: number) => randomBytes(bytes).toString("base64url");
const pad = (n: number, width: number) => String(n).padStart(width, "0");

/** Scopes: a non-empty list (at most 20) of known scopes; duplicates removed, order kept. */
function scopeList(value: unknown, known: string[]): string[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) return undefined;
  if (value.some((s) => typeof s !== "string" || !known.includes(s))) return undefined;
  return [...new Set(value as string[])];
}

const rateLimitOf = (value: unknown) =>
  value === undefined || value === null
    ? DEFAULT_SERVICE_RATE_LIMIT
    : Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= MAX_SERVICE_RATE_LIMIT
      ? (value as number)
      : undefined;

/**
 * Validate configured keys (the parsed RT_APP_SERVICE_KEYS value): at most 100 entries, unique
 * ids, exactly one of secretHash (64 lowercase hex) or secret, known scopes, description up to
 * 200 characters, rateLimit 1 to 100000 (default 600). Any problem: 400 "Invalid service key
 * configuration" (the framework refuses to start).
 */
export function parseServiceKeys(value: unknown, knownScopes: string[]): KeyRecord[] {
  const fail = () => {
    throw new HttpError(400, INVALID_CONFIGURATION);
  };
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 100) fail();
  const keys: KeyRecord[] = [];
  for (const entry of value as any[]) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail();
    if (typeof entry.id !== "string" || !KEY_ID.test(entry.id)) fail();
    const hasHash = entry.secretHash !== undefined && entry.secretHash !== null;
    const hasSecret = entry.secret !== undefined && entry.secret !== null;
    if (hasHash === hasSecret) fail();
    if (hasHash && (typeof entry.secretHash !== "string" || !HASH.test(entry.secretHash))) fail();
    if (hasSecret && (typeof entry.secret !== "string" || !SECRET.test(entry.secret))) fail();
    const scopes = scopeList(entry.scopes, knownScopes);
    if (!scopes) fail();
    const description = entry.description === undefined || entry.description === null ? "" : entry.description;
    if (typeof description !== "string" || description.trim().length > 200) fail();
    const limit = rateLimitOf(entry.rateLimit);
    if (limit === undefined) fail();
    if (keys.some((k) => k.id === entry.id)) fail();
    keys.push({
      id: entry.id,
      secretHash: hasHash ? entry.secretHash : serviceKeyHash(SERVICE_KEY_PREFIX + entry.id + "." + entry.secret),
      scopes: scopes!,
      description: description.trim(),
      rateLimit: limit!,
      source: "env",
      createdAt: null,
      createdBy: null,
      rotatedAt: null,
      revokedAt: null,
      revokedBy: null,
    });
  }
  return keys;
}

/**
 * Read configured keys from the environment: RT_APP_SERVICE_KEYS (JSON array) or the file named by
 * RT_APP_SERVICE_KEYS_FILE (a secrets file with the same JSON). Unparseable JSON is 400 "Invalid
 * service key configuration"; nothing configured is undefined.
 */
export function serviceKeysFromEnv(env: Record<string, string | undefined> = process.env): unknown {
  let text = env.RT_APP_SERVICE_KEYS;
  if (!text && env.RT_APP_SERVICE_KEYS_FILE) text = readFileSync(env.RT_APP_SERVICE_KEYS_FILE, "utf8");
  if (!text || !text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, INVALID_CONFIGURATION);
  }
}

export interface ServiceKeysOptions {
  /** Configured keys (parsed RT_APP_SERVICE_KEYS); validated on first use and by `validate()`. */
  keys?: unknown;
  /** Scopes a key may hold: the resources of the service endpoints. */
  scopes: string[] | (() => string[]);
  /** Injectable clock (epoch ms or Date); defaults to the system clock. */
  now?: Clock;
  /** Random bytes as base64url (tests pass a deterministic source). */
  random?: (bytes: number) => string;
}

export class ServiceKeys {
  private configured?: KeyRecord[];
  private random: (bytes: number) => string;
  constructor(
    private store: Store,
    private secret: string,
    private options: ServiceKeysOptions,
  ) {
    this.random = options.random ?? base64url;
  }

  /** Scopes a key may hold. */
  scopes(): string[] {
    const s = this.options.scopes;
    return [...(typeof s === "function" ? s() : s)];
  }

  /** Validate the configured keys now (the framework calls it at startup). */
  validate() {
    this.configured ??= parseServiceKeys(this.options.keys, this.scopes());
    return this.configured.map((k) => k.id);
  }

  private get env() {
    this.validate();
    return this.configured!;
  }

  private now() {
    return epochMs(this.options.now);
  }

  /** The key record (configured first, then admin-managed) or undefined. */
  private async record(id: string): Promise<{ key: KeyRecord; row?: Row } | undefined> {
    const configured = this.env.find((k) => k.id === id);
    if (configured) return { key: configured };
    const row = await this.store.get(SERVICE_KEYS, id);
    return row ? { key: row.data as KeyRecord, row } : undefined;
  }

  private view(key: KeyRecord, lastUsedAt: number | null) {
    return {
      id: key.id,
      description: key.description,
      scopes: key.scopes,
      rateLimit: key.rateLimit,
      source: key.source,
      prefix: SERVICE_KEY_PREFIX + key.id + ".",
      active: key.revokedAt === null || key.revokedAt === undefined,
      createdAt: key.createdAt ?? null,
      createdBy: key.createdBy ?? null,
      rotatedAt: key.rotatedAt ?? null,
      revokedAt: key.revokedAt ?? null,
      revokedBy: key.revokedBy ?? null,
      lastUsedAt,
    };
  }

  private async all(pk: string) {
    const rows: Row[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.store.list(pk, cursor);
      rows.push(...page.items);
      cursor = page.cursor;
    } while (cursor);
    return rows;
  }

  /** Every key (configured first, then admin-managed by id) and the scopes a key may hold. Never returns secrets. */
  async list() {
    const used = new Map((await this.all(SERVICE_KEY_USE)).map((r) => [r.sk, r.data.lastUsedAt as number]));
    const managed = (await this.all(SERVICE_KEYS)).map((r) => r.data as KeyRecord);
    return {
      items: [...this.env, ...managed].map((k) => this.view(k, used.get(k.id) ?? null)),
      scopes: this.scopes(),
    };
  }

  private audit(id: string, version: number, data: Record<string, unknown>): Write {
    const at = data.at as number;
    return {
      row: { pk: serviceKeyAudit(id), sk: pad(at, 15) + "-" + pad(version, 10), version: 1, data: { keyId: id, ...data } },
      expected: null,
    };
  }

  /**
   * Create an admin-managed key. Input `{id?, description, scopes, rateLimit?}`; the id defaults to
   * 12 random base64url characters. Returns `{key, token}`: the token is shown only here.
   * 400 "Invalid service key id" | "A short description is required" | "Invalid service key
   * scopes" | "Invalid service key rate limit"; 409 "Service key id already used".
   */
  async create(input: any, actorId: string) {
    const given = input?.id;
    if (given !== undefined && given !== null && (typeof given !== "string" || !KEY_ID.test(given)))
      throw new HttpError(400, "Invalid service key id");
    const description = typeof input?.description === "string" ? input.description.trim() : "";
    if (!description || description.length > 200) throw new HttpError(400, "A short description is required");
    const scopes = scopeList(input?.scopes, this.scopes());
    if (!scopes) throw new HttpError(400, "Invalid service key scopes");
    const limit = rateLimitOf(input?.rateLimit);
    if (limit === undefined) throw new HttpError(400, "Invalid service key rate limit");
    const id: string = given ?? this.random(9);
    if (this.env.some((k) => k.id === id) || (await this.store.get(SERVICE_KEYS, id)))
      throw new HttpError(409, "Service key id already used");
    const token = SERVICE_KEY_PREFIX + id + "." + this.random(32);
    const at = this.now();
    const key: KeyRecord = {
      id,
      description,
      scopes,
      rateLimit: limit,
      secretHash: serviceKeyHash(token),
      source: "admin",
      createdAt: at,
      createdBy: actorId,
      rotatedAt: null,
      revokedAt: null,
      revokedBy: null,
    };
    try {
      await this.store.transact([
        { row: { pk: SERVICE_KEYS, sk: id, version: 1, data: key }, expected: null },
        this.audit(id, 1, { action: "create", actorId, at, scopes, rateLimit: limit }),
      ]);
    } catch (e) {
      if (e instanceof Conflict) throw new HttpError(409, "Service key id already used");
      throw e;
    }
    return { key: this.view(key, null), token };
  }

  private async managed(id: unknown, action: "rotate" | "revoke") {
    if (typeof id !== "string" || !KEY_ID.test(id)) throw new HttpError(404, "Service key not found");
    if (this.env.some((k) => k.id === id))
      throw new HttpError(409, action === "rotate"
        ? "Keys from the configuration are rotated in the configuration"
        : "Keys from the configuration are revoked by removing them from the configuration");
    const row = await this.store.get(SERVICE_KEYS, id);
    if (!row) throw new HttpError(404, "Service key not found");
    return row;
  }

  private async lastUsed(id: string) {
    return ((await this.store.get(SERVICE_KEY_USE, id))?.data.lastUsedAt as number | undefined) ?? null;
  }

  /**
   * New secret for an admin-managed key; the old token stops working at once. Returns
   * `{key, token}` (shown only here). 404 unknown, 409 revoked or configured.
   */
  async rotate(id: string, actorId: string) {
    const row = await this.managed(id, "rotate");
    const key = row.data as KeyRecord;
    if (key.revokedAt !== null && key.revokedAt !== undefined) throw new HttpError(409, "Service key is revoked");
    const token = SERVICE_KEY_PREFIX + id + "." + this.random(32);
    const at = this.now();
    const next = { ...key, secretHash: serviceKeyHash(token), rotatedAt: at };
    await this.store.transact([
      { row: { ...row, version: row.version + 1, data: next }, expected: row.version },
      this.audit(id, row.version + 1, { action: "rotate", actorId, at }),
    ]);
    return { key: this.view(next, await this.lastUsed(id)), token };
  }

  /** Revoke an admin-managed key: rejected from the next request on. Idempotent. */
  async revoke(id: string, actorId: string) {
    const row = await this.managed(id, "revoke");
    const key = row.data as KeyRecord;
    if (key.revokedAt !== null && key.revokedAt !== undefined) return { key: this.view(key, await this.lastUsed(id)) };
    const at = this.now();
    const next = { ...key, revokedAt: at, revokedBy: actorId };
    await this.store.transact([
      { row: { ...row, version: row.version + 1, data: next }, expected: row.version },
      this.audit(id, row.version + 1, { action: "revoke", actorId, at }),
    ]);
    return { key: this.view(next, await this.lastUsed(id)) };
  }

  /**
   * The service actor of an `Authorization` header, in this order: no header → 401 "Service key
   * required"; not `Bearer rtsk_<id>.<secret>`, unknown id, wrong secret (constant-time compare
   * of sha256 hex) or revoked → 401 "Invalid service key"; then the per-key limit (RATE row
   * "service-key:<id>", rateLimit per minute: 429); then lastUsedAt (at most once a minute).
   * Actor: `{id: "service:<id>", role: "service", grants: scopes, name: description or id}`.
   */
  async actor(authorization: unknown): Promise<Actor> {
    if (authorization === undefined || authorization === null || authorization === "")
      throw new HttpError(401, SERVICE_KEY_REQUIRED);
    const match = typeof authorization === "string" && authorization.startsWith("Bearer ")
      ? TOKEN.exec(authorization.slice(7))
      : null;
    if (!match) throw new HttpError(401, INVALID_SERVICE_KEY);
    const id = match[1];
    const found = await this.record(id);
    const hash = Buffer.from(serviceKeyHash(match[0]), "hex");
    const expected = Buffer.from(found && HASH.test(found.key.secretHash) ? found.key.secretHash : NO_HASH, "hex");
    const valid = timingSafeEqual(hash, expected);
    if (!found || !valid || (found.key.revokedAt !== null && found.key.revokedAt !== undefined))
      throw new HttpError(401, INVALID_SERVICE_KEY);
    const key = found.key;
    const now = this.now();
    await rateLimit(this.store, this.secret, now, "service-key:" + id, key.rateLimit);
    const use = await this.store.get(SERVICE_KEY_USE, id);
    if (!use || !(now - use.data.lastUsedAt < SERVICE_KEY_TOUCH_MS))
      await this.store
        .transact([
          { row: { pk: SERVICE_KEY_USE, sk: id, version: (use?.version ?? 0) + 1, data: { lastUsedAt: now } }, expected: use?.version ?? null },
        ])
        .catch((e) => {
          if (!(e instanceof Conflict)) throw e;
        });
    return {
      id: "service:" + id,
      role: "service",
      grants: [...key.scopes],
      email: "",
      name: key.description || id,
      tokenVersion: 0,
      active: true,
    };
  }

  /**
   * Access policy of service endpoints: only `access: "service"` endpoints (403 otherwise), a
   * service actor (401 "Service key required") holding the endpoint's resource as a scope
   * (403 "Service key not allowed for this resource").
   */
  check(endpoint: Pick<Endpoint, "access" | "resource">, actor?: Actor) {
    if (endpoint.access !== "service") throw new HttpError(403, "You do not have permission to access this resource");
    if (!actor || actor.role !== "service") throw new HttpError(401, SERVICE_KEY_REQUIRED);
    if (!actor.grants.includes(endpoint.resource)) throw new HttpError(403, SERVICE_KEY_SCOPE);
  }

  /** Admin endpoints (owner, served only under /admin/app) and GET /service/keys/self. */
  feature(): Feature {
    return {
      id: "service-keys",
      migrations: [],
      admin: {
        id: "service-keys",
        title: "Service keys",
        resource: "service-keys.manage",
        path: "/service-keys",
        component: "service-keys",
        ownerOnly: true,
        fields: [],
        actions: [],
      },
      endpoints: [
        {
          method: "GET",
          path: "/service-keys",
          resource: "service-keys.manage",
          access: "owner",
          tool: {
            name: "service_keys_list",
            description: "List service keys (configured and admin-managed): id, description, scopes, rate limit, last use, revoked. Never returns secrets.",
            example: {},
          },
          handle: () => this.list(),
        },
        {
          method: "POST",
          path: "/service-keys",
          resource: "service-keys.manage",
          access: "owner",
          handle: (c) => {
            const b = c.request.body;
            return this.create({ id: b.id, description: b.description, scopes: b.scopes, rateLimit: b.rateLimit }, c.actor!.id);
          },
        },
        {
          method: "POST",
          path: "/service-keys/:id/rotate",
          resource: "service-keys.manage",
          access: "owner",
          handle: (c) => this.rotate(c.params.id, c.actor!.id),
        },
        {
          method: "POST",
          path: "/service-keys/:id/revoke",
          resource: "service-keys.manage",
          access: "owner",
          tool: {
            name: "service_keys_revoke",
            description: "Revoke an admin-managed service key; it is rejected from the next request on. params.id is the key id.",
            example: { params: { id: "KEY_ID" } },
          },
          handle: (c) => this.revoke(c.params.id, c.actor!.id),
        },
        {
          method: "GET",
          path: "/service/keys/self",
          resource: SERVICE_SELF,
          access: "service",
          handle: async (c) => {
            const id = c.actor!.id.slice("service:".length);
            const found = await this.record(id);
            return { id, description: found?.key.description ?? "", scopes: c.actor!.grants, rateLimit: found?.key.rateLimit ?? null };
          },
        },
      ],
    };
  }
}
