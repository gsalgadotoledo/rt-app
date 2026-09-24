import { Conflict } from "@gsalgadotoledo/rt-app-contracts";
import type { NoSQL } from "@gsalgadotoledo/rt-app-nosql";
import {
  RTAppIdempotencyModule,
  type RTAppIdempotencyClaim,
  type RTAppIdempotencyDecision,
  type RTAppIdempotencyStore,
  type RTAppJson,
} from "./idempotency.js";

/** Persistent claims shared by JSON and DynamoDB. Never expire an unresolved side effect. */
export class NoSQLIdempotencyStore implements RTAppIdempotencyStore {
  constructor(private readonly store: NoSQL) {}

  private address(claim: RTAppIdempotencyClaim) {
    return { pk: "IDEMPOTENCY#" + claim.scope, sk: claim.key };
  }

  /** Conditional creation elects exactly one worker, even across Lambda instances. */
  async claim(claim: RTAppIdempotencyClaim): Promise<RTAppIdempotencyDecision> {
    const address = this.address(claim);
    try {
      await this.store.transact([
        {
          row: {
            ...address,
            version: 1,
            data: {
              fingerprint: claim.fingerprint,
              owner: claim.owner,
              state: "pending",
              createdAt: new Date().toISOString(),
            },
          },
          expected: null,
        },
      ]);
      return { state: "acquired" };
    } catch (error) {
      if (!(error instanceof Conflict)) throw error;
      const row = await this.store.get(address.pk, address.sk);
      if (!row) throw error;
      if (row.data.fingerprint !== claim.fingerprint)
        return { state: "conflict" };
      if (row.data.state === "completed")
        return { state: "completed", result: structuredClone(row.data.result) };
      return {
        state: row.data.state === "uncertain" ? "uncertain" : "pending",
      };
    }
  }

  /** Save a replayable result only for the worker that acquired the claim. */
  async complete(
    claim: RTAppIdempotencyClaim,
    result: RTAppJson,
  ): Promise<void> {
    await this.transition(claim, "completed", result);
  }

  /** Preserve completed results if a successful database write lost its acknowledgement. */
  async markUncertain(claim: RTAppIdempotencyClaim): Promise<void> {
    await this.transition(claim, "uncertain");
  }

  private async transition(
    claim: RTAppIdempotencyClaim,
    state: string,
    result?: RTAppJson,
  ): Promise<void> {
    const address = this.address(claim);
    const row = await this.store.get(address.pk, address.sk);
    if (
      !row ||
      row.data.owner !== claim.owner ||
      row.data.fingerprint !== claim.fingerprint
    )
      throw new Conflict();
    if (row.data.state === "completed") return;
    await this.store.transact([
      {
        row: {
          ...row,
          version: row.version + 1,
          data: {
            ...row.data,
            state,
            updatedAt: new Date().toISOString(),
            ...(state === "completed" ? { result } : {}),
          },
        },
        expected: row.version,
      },
    ]);
  }
}

/** Example: createIdempotency(store).execute({scope:'tenant/orders/v1',key:'order-42',input:{}}, work). */
export function createIdempotency(store: NoSQL): RTAppIdempotencyModule {
  const executor = new RTAppIdempotencyModule();
  executor.store = new NoSQLIdempotencyStore(store);
  executor.init();
  return executor;
}
