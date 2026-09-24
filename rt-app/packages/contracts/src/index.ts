export type Data = Record<string, any>;
import type { Store, Row } from "@gsalgadotoledo/rt-app-nosql";
export type {
  Store,
  Row,
  Write,
  NoSQL,
  NoSQLCapabilities,
} from "@gsalgadotoledo/rt-app-nosql";
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export class Conflict extends HttpError {
  constructor() {
    super(409, "Conflict: refresh and try again");
  }
}
export interface Actor {
  id: string;
  email: string;
  name: string;
  role: "owner" | "admin" | "user";
  grants: string[];
  tokenVersion: number;
  active: boolean;
}
export interface Request {
  rawBody?: string;
  method: string;
  path: string;
  body: Data;
  query: Record<string, string>;
  headers: Record<string, string | undefined>;
  ip: string;
}
export interface Context {
  request: Request;
  actor?: Actor;
  params: Record<string, string>;
}
/** Explicit opt-in metadata shared by CLI and MCP. HTTP remains the authority. */
export interface ToolExposure {
  name: string;
  description: string;
  example?: Record<string, unknown>;
}

export interface Endpoint {
  tool?: ToolExposure;
  subscription?: {product:string;credits:number};
  method: string;
  path: string;
  resource: string;
  access: "guest" | "authenticated" | "permission" | "owner";
  /** Require an explicit grant even for application owners. Admin root uses its separate ACL. */
  explicitGrant?: boolean;
  handle(ctx: Context): Promise<any>;
}
export interface AdminManifest {
  group?: string;
  ownerOnly?: boolean;
  settings?: { path: string; resource: string; component?: string };
  id: string;
  title: string;
  resource: string;
  path: string;
  component: string;
  fields: string[];
  actions: string[];
}
/** Deployment stage a migration or seed runs in. `local` covers memory, JSON and DynamoDB Local. */
export type Environment = "local" | "develop" | "stage" | "prod";

/**
 * Engine-agnostic helpers handed to every migration and seed.
 * Write through `store` (the NoSQL contract), so the same step runs on DynamoDB, JSON or memory.
 */
export interface MigrationContext {
  store: Store;
  provider: string;
  environment: Environment;
  /** Insert rows that do not exist yet; existing rows are left untouched. Returns inserted keys. */
  ensureRows(rows: Array<Pick<Row, "pk" | "sk" | "data"> & { ttl?: number }>): Promise<string[]>;
  log(message: string): void;
}

export interface MigrationStep {
  checksum: string;
  up?(context: MigrationContext): Promise<void>;
  down?(context: MigrationContext): Promise<void>;
  /** @deprecated Use `up`. Kept for migrations written before 0.1.0. */
  run?(store: Store): Promise<void>;
}

/**
 * A module-owned, versioned change. `id` is permanent (`module:NNN`) and its checksum must never change
 * once applied. `providers` overrides the generic steps for one storage engine only.
 * @example { id: "catalog:002", checksum: "catalog-currency-v1", up: async ({ensureRows}) => { ... } }
 */
export interface Migration extends Partial<MigrationStep> {
  id: string;
  checksum: string;
  description?: string;
  providers?: Record<string, MigrationStep>;
}

export interface SeedContext extends MigrationContext {
  /** Read a required secret such as DEMO_PASSWORD. Throws when it is missing; never logs the value. */
  secret(name: string): string;
  /** Services other modules share with seeds, e.g. `service("users")`. Throws when absent. */
  service<T>(id: string): T;
  /** Deterministic @faker-js/faker instance (optional peer dependency) seeded from the seed id. */
  faker(): Promise<any>;
}

/**
 * Example or reference data owned by a module. Seeds must be idempotent: they may run again when
 * `version` changes or when forced. By default they never run in `prod`.
 */
export interface Seed {
  id: string;
  description?: string;
  /** Bump to re-run a changed seed on environments that already applied it. Defaults to "1". */
  version?: string;
  environments?: Environment[];
  run(context: SeedContext): Promise<void>;
}

export interface Feature {
  id: string;
  endpoints: Endpoint[];
  admin?: AdminManifest;
  migrations: Migration[];
  seeds?: Seed[];
}
export const text = (value: unknown, field: string, max = 200): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new HttpError(400, `Invalid field: ${field}`);
  return value.trim();
};
export const emailAddress = (value: unknown) => {
  const v = text(value, "email", 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))
    throw new HttpError(400, "Invalid email");
  return v;
};
export const publicUser = (data: Data): Actor => ({
  id: data.id,
  email: data.email,
  name: data.name,
  role: data.role,
  grants: data.grants,
  tokenVersion: data.tokenVersion,
  active: data.active,
});
export const viewUser = (data: Data) => {
  const { tokenVersion, ...safe } = publicUser(data);
  return {...safe, ...auditView(data)};
};
export function filtered(
  items: Data[],
  query: Record<string, string>,
  fields: string[],
) {
  for (const field of Object.keys(query))
    if (field !== "cursor" && !fields.includes(field))
      throw new HttpError(400, `Unsupported filter: ${field}`);
  return items.filter((item) =>
    fields.every(
      (field) =>
        !query[field] ||
        String(item[field] ?? "")
          .toLowerCase()
          .includes(query[field].toLowerCase()),
    ),
  );
}
/** First migration of every document module: records its schema version once. */
export function schemaMigration(module: string): Migration {
  const up = async ({ store }: MigrationContext) => {
    const existing = await store.get("SCHEMA", module);
    if (existing) return;
    await store.transact([
      {
        row: {
          pk: "SCHEMA",
          sk: module,
          version: 1,
          data: { schemaVersion: 1 },
        },
        expected: null,
      },
    ]);
  };
  return {
    id: module + ":001",
    checksum: module + "-document-v1",
    description: "Register the " + module + " document schema",
    up,
  };
}

/** Search bounded pages, keeping the cursor when more data remains to inspect. */
export async function searchPage(
  store: Store,
  pk: string,
  query: Record<string, string>,
  fields: string[],
  project: (row: Row) => Data | undefined,
) {
  const {trash,...filters}=query;
  if(trash!==undefined&&!["true","false"].includes(trash))throw new HttpError(400,"Invalid trash filter");
  filtered([], filters, fields); // Validate even for empty collections.
  let cursor: string | undefined = query.cursor;
  for (let inspected = 0; inspected < 10; inspected++) {
    const page = await store.list(pk, cursor);
    const rows = page.items
      .filter(row=>Boolean(row.data.deletedAt)===(trash==="true"))
      .map(project)
      .filter((row): row is Data => row !== undefined);
    const items = filtered(rows, filters, fields);
    cursor = page.cursor;
    if (items.length || !cursor) return { items, cursor };
  }
  return { items: [], cursor };
}

export function auditView(data: Data) {
 return Object.fromEntries(["createdAt","createdBy","updatedAt","updatedBy","deletedAt","deletedBy","restoredAt","restoredBy"].map(key=>[key,data[key]??null]));
}
export function auditCreate(actor: string | null) {
 const now=new Date().toISOString();return {createdAt:now,createdBy:actor,updatedAt:now,updatedBy:actor,deletedAt:null,deletedBy:null};
}
export function auditUpdate(actor: string | null) {return {updatedAt:new Date().toISOString(),updatedBy:actor};}
export function auditDelete(actor: string) {const now=new Date().toISOString();return {updatedAt:now,updatedBy:actor,deletedAt:now,deletedBy:actor};}
export function auditRestore(actor: string) {return {...auditUpdate(actor),deletedAt:null,deletedBy:null,restoredAt:new Date().toISOString(),restoredBy:actor};}
