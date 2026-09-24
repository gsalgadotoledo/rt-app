import pg from "pg";
import { requiredCapabilities } from "@gsalgadotoledo/rt-app-nosql";
import { Conflict, HttpError, type Row, type Store, type Write } from "@gsalgadotoledo/rt-app-contracts";

/**
 * NoSQL store contract on PostgreSQL: one table of (pk, sk, version, data jsonb, ttl).
 * Every RT-App module, migration and seed runs unchanged on any Postgres (Neon, Supabase,
 * Railway, Aurora, Cloud SQL, local). Conditional writes run inside one SQL transaction, so a
 * version conflict rolls back the whole write set, exactly like DynamoDB transactions.
 */

// ---------------------------------------------------------------------------
// SQL client abstraction (pg in production, PGlite in tests)
// ---------------------------------------------------------------------------

export interface SqlResult<T = any> {
  rows: T[];
  rowCount: number;
}

export type Query = <T = any>(sql: string, params?: unknown[]) => Promise<SqlResult<T>>;

export interface SqlClient {
  query: Query;
  /** Run `work` in one transaction: COMMIT on success, ROLLBACK on any error. */
  transaction<T>(work: (query: Query) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}

/** Client over a `pg` Pool. Each transaction holds one pooled connection until it ends. */
export function pgClient(pool: Pick<pg.Pool, "query" | "connect" | "end">): SqlClient {
  const wrap =
    (target: { query: (sql: string, params?: unknown[]) => Promise<pg.QueryResult> }): Query =>
    async (sql, params = []) => {
      const result = await target.query(sql, params);
      return { rows: result.rows, rowCount: result.rowCount ?? 0 };
    };
  return {
    query: wrap(pool),
    async transaction(work) {
      const connection = await pool.connect();
      try {
        await connection.query("BEGIN");
        const result = await work(wrap(connection));
        await connection.query("COMMIT");
        return result;
      } catch (error) {
        await connection.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        connection.release();
      }
    },
    close: () => pool.end(),
  };
}

/** Minimal shape of an in-process PGlite database (tests and local experiments). */
export interface PGliteLike {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[]; affectedRows?: number }>;
  transaction<T>(work: (tx: { query: PGliteLike["query"] }) => Promise<T>): Promise<T>;
}

/** Client over PGlite, for tests without a server. */
export function pgliteClient(db: PGliteLike): SqlClient {
  const wrap =
    (target: { query: PGliteLike["query"] }): Query =>
    async (sql, params = []) => {
      const result = await target.query<any>(sql, params);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    };
  return {
    query: wrap(db),
    transaction: (work) => db.transaction((tx) => work(wrap(tx))),
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const PAGE = 50;

function tableName(name: string) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error("Invalid table name: " + name);
  return name;
}

function toRow(record: any): Row {
  return {
    pk: record.pk,
    sk: record.sk,
    version: Number(record.version),
    data: typeof record.data === "string" ? JSON.parse(record.data) : record.data,
    ...(record.ttl !== null && record.ttl !== undefined ? { ttl: Number(record.ttl) } : {}),
  };
}

export class PostgresStore implements Store {
  readonly provider = "postgres";
  readonly capabilities = requiredCapabilities;
  private table: string;
  private schema?: Promise<void>;

  constructor(
    private client: SqlClient,
    options: { table?: string } = {},
  ) {
    this.table = tableName(options.table ?? "rt_app_rows");
  }

  /**
   * Connect with a connection string (DATABASE_URL). TLS is required unless the host is local or
   * `ssl: false` is passed explicitly; certificate verification stays on.
   */
  static connect(url: string, options: { table?: string; max?: number; ssl?: boolean } = {}) {
    const host = new URL(url).hostname;
    const local = ["localhost", "127.0.0.1", "::1"].includes(host);
    const pool = new pg.Pool({
      connectionString: url,
      max: options.max ?? 10,
      ssl: (options.ssl ?? !local) ? { rejectUnauthorized: true } : undefined,
    });
    return new PostgresStore(pgClient(pool), options);
  }

  /**
   * Create the table if missing. Idempotent. Called automatically (once per process) before the
   * first read or write, so no entry point has to prepare the database.
   */
  ensureSchema() {
    this.schema ??= this.createSchema().catch((error) => {
      this.schema = undefined;
      throw error;
    });
    return this.schema;
  }

  private async createSchema() {
    await this.client.query(
      `CREATE TABLE IF NOT EXISTS ${this.table} (
        pk text NOT NULL,
        sk text NOT NULL,
        version integer NOT NULL,
        data jsonb NOT NULL,
        ttl bigint,
        PRIMARY KEY (pk, sk)
      )`,
    );
  }

  async close() {
    await this.client.close?.();
  }

  /** Read one row; absence returns undefined. Reads always see committed data. */
  async get(pk: string, sk: string) {
    await this.ensureSchema();
    const { rows } = await this.client.query(`SELECT pk, sk, version, data, ttl FROM ${this.table} WHERE pk = $1 AND sk = $2`, [pk, sk]);
    return rows[0] ? toRow(rows[0]) : undefined;
  }

  /**
   * Apply version-guarded writes atomically. `expected: null` means "must not exist";
   * a number means "must have this version". Any mismatch throws Conflict and nothing commits.
   * Row locks taken by UPDATE/INSERT make concurrent writers re-check the version after waiting.
   */
  async transact(writes: Write[]) {
    if (!writes.length) return;
    const keys = new Set<string>();
    for (const w of writes) {
      const key = JSON.stringify([w.row.pk, w.row.sk]);
      if (keys.has(key)) throw new Error("Duplicate transaction key");
      keys.add(key);
    }
    await this.ensureSchema();
    await this.client.transaction(async (query) => {
      for (const { row, expected, delete: remove } of writes) {
        const values = [row.pk, row.sk];
        let changed: number;
        if (expected === null && !remove) {
          changed = (
            await query(
              `INSERT INTO ${this.table} (pk, sk, version, data, ttl) VALUES ($1, $2, $3, $4::jsonb, $5) ON CONFLICT (pk, sk) DO NOTHING`,
              [...values, row.version, JSON.stringify(row.data), row.ttl ?? null],
            )
          ).rowCount;
        } else if (expected === null) {
          // Deleting a row that must not exist is a no-op, but it still asserts absence.
          const { rows } = await query(`SELECT 1 FROM ${this.table} WHERE pk = $1 AND sk = $2 FOR UPDATE`, values);
          changed = rows.length ? 0 : 1;
        } else if (remove) {
          changed = (await query(`DELETE FROM ${this.table} WHERE pk = $1 AND sk = $2 AND version = $3`, [...values, expected])).rowCount;
        } else {
          changed = (
            await query(
              `UPDATE ${this.table} SET version = $3, data = $4::jsonb, ttl = $5 WHERE pk = $1 AND sk = $2 AND version = $6`,
              [...values, row.version, JSON.stringify(row.data), row.ttl ?? null, expected],
            )
          ).rowCount;
        }
        if (changed !== 1) throw new Conflict();
      }
    });
  }

  /** Up to 50 rows ordered by sort key, and a cursor bound to this partition. */
  async list(pk: string, cursor?: string) {
    let after = "";
    if (cursor) {
      try {
        const key = JSON.parse(Buffer.from(cursor, "base64url").toString());
        if (key.pk !== pk || typeof key.sk !== "string") throw 0;
        after = key.sk;
      } catch {
        throw new HttpError(400, "Invalid cursor");
      }
    }
    await this.ensureSchema();
    // Binary collation matches the byte order the other adapters use.
    const { rows } = await this.client.query(
      `SELECT pk, sk, version, data, ttl FROM ${this.table} WHERE pk = $1 AND sk COLLATE "C" > $2 ORDER BY sk COLLATE "C" LIMIT ${PAGE + 1}`,
      [pk, after],
    );
    const items = rows.slice(0, PAGE).map(toRow);
    return {
      items,
      cursor: rows.length > PAGE ? Buffer.from(JSON.stringify({ pk, sk: items.at(-1)!.sk })).toString("base64url") : undefined,
    };
  }
}
