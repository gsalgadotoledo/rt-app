// Subject: idempotency. A facade over createIdempotency(store, {now}) on a MemoryStore holding
// init.rows, with a settable ISO clock, a work log and store fault injection. Other languages
// expose the same method names with the same positional arguments (idempotency contract).
import { RTAppIdempotencyModule, NoSQLIdempotencyStore } from "@gsalgadotoledo/rt-app-idempotency";
import { memoryStore } from "./storage.mjs";
import { faultyStore } from "./cache.mjs";

/** A settable clock starting at init.now (ISO 8601); the system clock when absent. */
function isoClock(now) {
  const parse = (iso, what) => {
    const ms = typeof iso === "string" ? Date.parse(iso) : NaN;
    if (Number.isNaN(ms)) throw new TypeError(`${what} must be an ISO 8601 date`);
    return ms;
  };
  let fixed = now == null ? undefined : parse(now, "init.now");
  return { now: () => fixed ?? Date.now(), set: (iso) => ((fixed = parse(iso, "setNow")), null) };
}

async function idempotency(init) {
  const time = isoClock(init.now);
  const store = faultyStore(await memoryStore(init.rows));
  const adapter = new NoSQLIdempotencyStore(store, { now: time.now });
  const executor = new RTAppIdempotencyModule();
  executor.store = adapter;
  executor.init();
  const log = [];

  /**
   * Work described by `outcome`: {result} is returned, {error} is thrown as Error(error).
   * {during: [request, outcome]} runs a nested execute inside the work and logs its outcome.
   */
  const work = (outcome) => async ({ input, idempotencyKey }) => {
    const entry = { input, idempotencyKey };
    log.push(entry);
    if (outcome?.during) {
      try {
        entry.during = { value: await executor.execute(outcome.during[0], work(outcome.during[1])) };
      } catch (error) {
        entry.during = { error: { code: error.code, message: error.message } };
      }
    }
    if (typeof outcome?.error === "string") throw new Error(outcome.error);
    return outcome?.result ?? null;
  };

  return {
    // execute(request, outcome) → the work's result, a replayed result, or an RTAppIdempotencyError.
    execute: (request, outcome) => executor.execute(request, work(outcome)),
    // calls() → [{input, idempotencyKey, during?}] for every time a work ran.
    calls: () => log,
    // The store surface (RTAppIdempotencyStore).
    claim: (claim) => adapter.claim(claim),
    complete: async (claim, result) => (await adapter.complete(claim, result), null),
    markUncertain: async (claim) => (await adapter.markUncertain(claim), null),
    // Helpers.
    row: async (pk, sk) => (await store.get(pk, sk)) ?? null,
    injectFaults: (kind, count) => store.inject(kind, count === null ? undefined : count),
    setNow: (iso) => time.set(iso),
    // An executor without a store: init() and execute() fail with NOT_CONFIGURED.
    initUnconfigured: () => (new RTAppIdempotencyModule().init(), null),
    executeUnconfigured: (request) => new RTAppIdempotencyModule().execute(request, work({ result: null })),
  };
}

export const subjects = { idempotency };
