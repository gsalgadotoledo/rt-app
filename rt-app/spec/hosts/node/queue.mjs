// Subject: queue. A facade over `new Queue(adapter, {now, random})` on a MemoryQueue with a settable
// ISO clock, so every language exposes the same surface (queue contract, docs/polyglot/queue.md).
//
// The facade adapter delegates to the MemoryQueue and numbers every delivery it hands out (from
// receive, workOnce or run) as 0, 1, 2…; ack/retry/extend/deadLetter take that number. `init`:
// {now, capacity?, leaseSeconds?, random?, capabilities?}; `capabilities` replaces the adapter's
// declared capabilities (the MemoryQueue still does the work).
import { MemoryQueue, Queue, validateFailureLimit, validateMessage } from "@gsalgadotoledo/rt-app-queue";

// Wire null means "not given": optional TypeScript parameters receive undefined, not null.
const given = (value) => (value === null ? undefined : value);

/** A settable clock in epoch milliseconds starting at init.now (ISO 8601). */
function clock(now) {
  const parse = (iso, what) => {
    const ms = typeof iso === "string" ? Date.parse(iso) : NaN;
    if (Number.isNaN(ms)) throw new TypeError(`${what} must be an ISO 8601 date`);
    return ms;
  };
  let fixed = now == null ? undefined : parse(now, "init.now");
  return { now: () => fixed ?? Date.now(), set: (iso) => ((fixed = parse(iso, "setNow")), null) };
}

function queue(init) {
  const time = clock(init.now);
  const memory = new MemoryQueue(given(init.capacity), given(init.leaseSeconds), time.now);
  const deliveries = [];
  const adapter = {
    capabilities: init.capabilities ?? memory.capabilities,
    publish: (message) => memory.publish(message),
    receive: async (limit, signal) => {
      const list = await memory.receive(limit, signal);
      for (const delivery of list) deliveries.push(delivery);
      return list;
    },
    inspectFailures: (limit) => memory.inspectFailures(limit),
    retryFailure: (token) => memory.retryFailure(token),
  };
  const random = typeof init.random === "number" ? () => init.random : undefined;
  const q = new Queue(adapter, { now: time.now, random });
  const feature = q.feature();
  const log = [];

  const delivery = (n) => {
    const found = Number.isInteger(n) ? deliveries[n] : undefined;
    if (!found) throw new TypeError("Unknown delivery " + n);
    return found;
  };
  const wire = (d) => ({ delivery: deliveries.indexOf(d), attempts: d.attempts, message: d.message });

  /**
   * The handler of workOnce/run. outcomes maps a message id to "ok" (default), "fail" (throws
   * Error("fail")), "ack" (acknowledges itself, so the worker's own ack is stale) or "nested"
   * (calls workOnce inside the handler and logs its error). stop() runs after each handler.
   */
  const handler = (outcomes, stop) => async (d) => {
    const entry = { delivery: deliveries.indexOf(d), id: d.message.id, attempts: d.attempts };
    log.push(entry);
    try {
      const outcome = outcomes?.[d.message.id] ?? "ok";
      if (outcome === "fail") throw new Error("fail");
      if (outcome === "ack") await d.ack();
      if (outcome === "nested") {
        try {
          await q.workOnce(async () => {});
          entry.nested = { value: "no error" };
        } catch (error) {
          entry.nested = { error: error.message };
        }
      }
    } finally {
      stop?.();
    }
  };

  const route = (method, path) => feature.endpoints.find((e) => e.method === method && e.path === path);
  const call = (method, path, body) => route(method, path).handle({ request: { body: body ?? {}, query: {} }, params: {} });

  return {
    // Adapter surface (MemoryQueue).
    publish: async (message) => (await adapter.publish(message), null),
    receive: async (limit) => (await adapter.receive(limit)).map(wire),
    ack: async (n) => (await delivery(n).ack(), null),
    retry: async (n, seconds) => (await delivery(n).retry(seconds), null),
    extend: async (n, seconds) => (await delivery(n).extend(seconds), null),
    deadLetter: async (n) => (await delivery(n).deadLetter(), null),
    inspectFailures: (limit) => adapter.inspectFailures(limit),
    retryFailure: async (token) => (await adapter.retryFailure(token), null),
    deadLetters: () => memory.deadLetters(),
    capabilities: () => adapter.capabilities,
    // Queue surface.
    send: (type, payload, options) => q.send(type, payload, given(options)),
    workOnce: (outcomes, options) => q.workOnce(handler(outcomes), given(options)),
    // run(outcomes, options, stopAfter): aborts after stopAfter handled messages (0: before starting).
    run: async (outcomes, options, stopAfter) => {
      const abort = new AbortController();
      let handled = 0;
      if (!(stopAfter > 0)) abort.abort();
      await q.run(handler(outcomes, () => ++handled >= stopAfter && abort.abort()), given(options), abort.signal);
      return null;
    },
    // handled() → [{delivery, id, attempts, nested?}] for every handler call, in delivery order.
    handled: () => [...log].sort((a, b) => a.delivery - b.delivery),
    // Endpoint handlers (bodies default to {}).
    status: () => call("GET", "/queue/status"),
    inspect: (body) => call("POST", "/queue/failed/inspect", body),
    retryFailed: (body) => call("POST", "/queue/failed/retry", body),
    endpoints: () => feature.endpoints.map(({ method, path, resource, access }) => ({ method, path, resource, access })),
    admin: () => feature.admin,
    migrations: () => feature.migrations,
    // Pure helpers.
    validateMessage: (message) => validateMessage(message),
    validateFailureLimit: (limit) => (validateFailureLimit(limit), null),
    setNow: (iso) => time.set(iso),
  };
}

export const subjects = { queue };
