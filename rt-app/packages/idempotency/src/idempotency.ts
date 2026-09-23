import type { RTAppModule } from "@gsalgadotoledo/rt-app-core";

export type RTAppJson = null | boolean | number | string | RTAppJson[] | { [key: string]: RTAppJson };
export interface RTAppIdempotencyClaim {
  scope: string;
  key: string;
  fingerprint: string;
  owner: string;
}
export type RTAppIdempotencyDecision =
  | { state: "acquired" | "pending" | "uncertain" | "conflict" }
  | { state: "completed"; result: RTAppJson };
/** Implementations MUST claim atomically and persist before returning acquired. */
export interface RTAppIdempotencyStore {
  claim(claim: RTAppIdempotencyClaim): Promise<RTAppIdempotencyDecision>;
  complete(claim: RTAppIdempotencyClaim, result: RTAppJson): Promise<void>;
  markUncertain(claim: RTAppIdempotencyClaim): Promise<void>;
}
export interface RTAppIdempotencyRequest<I extends RTAppJson> {
  /** Include application, authenticated tenant/actor, operation and contract version. */
  scope: string;
  /** Stable logical operation ID, reused on every retry. */
  key: string;
  input: I;
}
export interface RTAppIdempotencyContext<I extends RTAppJson> {
  input: I;
  /** Forward to the external provider; never generate a new key on retry. */
  idempotencyKey: string;
}
export interface RTAppIdempotencyExecutor {
  execute<I extends RTAppJson, O extends RTAppJson>(
    request: RTAppIdempotencyRequest<I>,
    work: (context: RTAppIdempotencyContext<I>) => Promise<O>,
  ): Promise<O>;
}
export class RTAppIdempotencyError extends Error {
  constructor(public readonly code: "NOT_CONFIGURED" | "INVALID_JSON" | "INVALID_KEY" | "PENDING" | "UNCERTAIN" | "CONFLICT", options?: ErrorOptions) {
    super(`RT-App idempotency: ${code}`, options);
    this.name = "RTAppIdempotencyError";
  }
}

// Restrict the contract to JSON, rejecting lossy serialization (undefined, NaN, Date, etc.).
function canonical(value: unknown, ancestors = new Set<object>()): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== "object" || value === null || ancestors.has(value)) throw new RTAppIdempotencyError("INVALID_JSON");
  const array = Array.isArray(value);
  if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new RTAppIdempotencyError("INVALID_JSON");
  if (Reflect.ownKeys(value).some(key => typeof key === "symbol")) throw new RTAppIdempotencyError("INVALID_JSON");
  ancestors.add(value);
  let result: string;
  if (array) {
    if (Object.keys(value).length !== value.length) throw new RTAppIdempotencyError("INVALID_JSON");
    const parts: string[] = [];
    for (let i = 0; i < value.length; i++) {
      if (!Object.hasOwn(value, i)) throw new RTAppIdempotencyError("INVALID_JSON");
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i))!;
      if (!Object.hasOwn(descriptor, "value")) throw new RTAppIdempotencyError("INVALID_JSON");
      parts.push(canonical(descriptor.value, ancestors));
    }
    result = `[${parts.join(",")}]`;
  } else {
    if (Object.getOwnPropertyNames(value).length !== Object.keys(value).length) throw new RTAppIdempotencyError("INVALID_JSON");
    result = `{${Object.keys(value).sort().map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!Object.hasOwn(descriptor, "value")) throw new RTAppIdempotencyError("INVALID_JSON");
      return `${JSON.stringify(key)}:${canonical(descriptor.value, ancestors)}`;
    }).join(",")}}`;
  }
  ancestors.delete(value);
  return result;
}
async function digest(value: string): Promise<string> {
  const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** No retries or automatic takeover: an uncertain side effect must be reconciled. */
export class RTAppIdempotencyModule implements RTAppModule, RTAppIdempotencyExecutor {
  store: RTAppIdempotencyStore | undefined = undefined;
  init(): void {
    if (!this.store) throw new RTAppIdempotencyError("NOT_CONFIGURED");
  }
  async execute<I extends RTAppJson, O extends RTAppJson>(request: RTAppIdempotencyRequest<I>, work: (context: RTAppIdempotencyContext<I>) => Promise<O>): Promise<O> {
    const store = this.store;
    if (!store) throw new RTAppIdempotencyError("NOT_CONFIGURED");
    const { scope, key } = request;
    if (typeof scope !== "string" || !scope.trim() || scope.length > 512 || typeof key !== "string" || !key.trim() || key.length > 256) throw new RTAppIdempotencyError("INVALID_KEY");
    // Snapshot synchronously, before any await, so caller mutation cannot change the operation.
    const serialized = canonical(request.input);
    const input = JSON.parse(serialized) as I;
    const claim = { scope, key, fingerprint: await digest(serialized), owner: globalThis.crypto.randomUUID() };
    const idempotencyKey = `rtapp-${await digest(JSON.stringify([scope, key]))}`;
    const decision = await store.claim(claim);
    if (decision.state === "completed") return JSON.parse(canonical(decision.result)) as O;
    if (decision.state !== "acquired") throw new RTAppIdempotencyError(decision.state.toUpperCase() as "PENDING" | "UNCERTAIN" | "CONFLICT");
    try {
      const result = JSON.parse(canonical(await work({ input, idempotencyKey }))) as O;
      await store.complete(claim, result);
      return result;
    } catch (cause) {
      // Never remove a claim on failure: the remote side effect may have succeeded.
      // A failed completion acknowledgement may also mean completion was persisted.
      try { await store.markUncertain(claim); } catch { /* Pending remains non-replayable. */ }
      throw new RTAppIdempotencyError("UNCERTAIN", { cause });
    }
  }
}
