export type Data = Record<string, any>;
export interface NoSQLCapabilities {
  atomicTransactions: true;
  conditionalWrites: true;
  consistentReads: true;
  partitionQueries: true;
}
export const requiredCapabilities: NoSQLCapabilities = {
  atomicTransactions: true,
  conditionalWrites: true,
  consistentReads: true,
  partitionQueries: true,
};
export interface Row {
  pk: string;
  sk: string;
  version: number;
  data: Data;
  ttl?: number;
}
export interface Write {
  row: Row;
  expected: number | null;
  delete?: boolean;
}
export interface NoSQL {
  readonly provider: string;
  readonly capabilities: NoSQLCapabilities;
  get(pk: string, sk: string): Promise<Row | undefined>;
  transact(writes: Write[]): Promise<void>;
  list(pk: string, cursor?: string): Promise<{ items: Row[]; cursor?: string }>;
}

export type Store = NoSQL;
/** Factories are explicitly registered at build time; configuration never imports arbitrary code. */
export class NoSQLRegistry {
  private adapters = new Map<
    string,
    (config: Record<string, string>) => NoSQL
  >();
  register(id: string, factory: (config: Record<string, string>) => NoSQL) {
    if (this.adapters.has(id))
      throw new Error("Duplicate NoSQL adapter: " + id);
    this.adapters.set(id, factory);
    return this;
  }
  connect(id: string, config: Record<string, string>): NoSQL {
    const factory = this.adapters.get(id);
    if (!factory) throw new Error("Unsupported NoSQL provider: " + id);
    const store = factory(config);
    if (
      store.provider !== id ||
      !store.capabilities ||
      Object.keys(requiredCapabilities).some(
        (k) => store.capabilities[k as keyof NoSQLCapabilities] !== true,
      )
    )
      throw new Error(
        "NoSQL adapter does not satisfy the application contract: " + id,
      );
    return store;
  }
}
