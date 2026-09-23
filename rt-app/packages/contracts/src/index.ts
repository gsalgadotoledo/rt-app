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
export interface Migration {
  id: string;
  checksum: string;
  run?(store: Store): Promise<void>;
  providers?: Record<
    string,
    { checksum: string; run(store: Store): Promise<void> }
  >;
}
export interface Feature {
  id: string;
  endpoints: Endpoint[];
  admin?: AdminManifest;
  migrations: Migration[];
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
export function schemaMigration(module: string): Migration {
  const run = async (store: Store) => {
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
  const implementation = { checksum: module + "-document-v1", run };
  return {
    id: module + ":001",
    checksum: implementation.checksum,
    providers: { dynamodb: implementation, memory: implementation, json: implementation },
  };
}
export async function migrate(store: Store, features: Feature[]) {
  // Validate the complete plan before writing anything.
  const plan = features
    .flatMap((f) => f.migrations)
    .map((migration) => {
      const implementation = migration.providers
        ? migration.providers[store.provider]
        : migration.run
          ? { checksum: migration.checksum, run: migration.run }
          : undefined;
      if (!implementation)
        throw new Error(
          "Unsupported migration " + migration.id + " for " + store.provider,
        );
      return { migration, implementation };
    });
  if (new Set(plan.map((p) => p.migration.id)).size !== plan.length)
    throw new Error("Duplicate migration id");
  for (const { migration, implementation } of plan) {
    const record = await store.get("MIGRATIONS", migration.id);
    if (record) {
      if (
        record.data.checksum !== implementation.checksum ||
        (record.data.provider && record.data.provider !== store.provider)
      )
        throw new Error(`Migration changed: ${migration.id}`);
      continue;
    }
    // Migrations must be restartable/idempotent. Run this command as one deployment job.
    await implementation.run(store);
    await store.transact([
      {
        row: {
          pk: "MIGRATIONS",
          sk: migration.id,
          version: 1,
          data: {
            checksum: implementation.checksum,
            provider: store.provider,
            appliedAt: new Date().toISOString(),
          },
        },
        expected: null,
      },
    ]);
  }
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
