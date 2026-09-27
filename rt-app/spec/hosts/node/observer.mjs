// Subjects: observer, observer-rules, observer-console, observer-webhook, observer-slack,
// observer-email, observer-email-local, observer-sms. Each subject is a small facade so every
// language exposes the same surface; helpers are documented in the contracts and
// docs/polyglot/observer.md. Transports are fakes configured by init: nothing leaves the host.
import { setTimeout as delay } from "node:timers/promises";
import {
  Observer,
  ObserverStore,
  observerFeature,
  sanitize,
  safePath,
  validateLogQuery,
  matchesLog,
} from "@gsalgadotoledo/rt-app-observer";
import { ConsoleOutput } from "@gsalgadotoledo/rt-app-observer-console";
import { WebhookOutput } from "@gsalgadotoledo/rt-app-observer-webhook";
import { SlackOutput } from "@gsalgadotoledo/rt-app-observer-slack";
import { EmailOutput, LocalEmailOutput } from "@gsalgadotoledo/rt-app-observer-email";
import { SmsOutput } from "@gsalgadotoledo/rt-app-observer-sms";
import { memoryStore } from "./storage.mjs";

// Wire null means "not given": optional TypeScript parameters receive undefined, not null.
const given = (value) => (value === null ? undefined : value);

/** Objects with their null fields removed (a null field equals a missing one on the wire). */
const present = (value) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null))
    : value;

/** A settable clock starting at init.now (ISO 8601); the system clock when absent. */
function clock(now) {
  let fixed = now == null ? undefined : Date.parse(now);
  if (Number.isNaN(fixed)) throw new Error("init.now must be an ISO 8601 date");
  return {
    now: () => fixed ?? Date.now(),
    set(iso) {
      const value = Date.parse(iso);
      if (typeof iso !== "string" || Number.isNaN(value)) throw new Error("setNow needs an ISO 8601 date");
      fixed = value;
      return null;
    },
    advance(ms) {
      fixed = (fixed ?? Date.now()) + ms;
    },
  };
}

/**
 * Scripted outputs. behavior: "ok" records the event, "fail" throws a secret-looking error,
 * "hang" never settles (only its abort signal is recorded), "slow" records after 20 ms,
 * "mutate" records the event and then changes its copy. filter: {messageIncludes} keeps
 * matching events, {throws: true} throws, {mutates: true} changes its copy and keeps the event.
 */
function scriptedOutput(spec, state) {
  const entry = { behavior: spec.behavior ?? "ok", delivered: [], signal: undefined };
  state.set(spec.id, entry);
  const handler = {
    id: spec.id,
    async write(event, signal) {
      entry.signal = signal;
      if (entry.behavior === "fail") throw new Error("password=hunter2 at hooks.internal");
      if (entry.behavior === "hang") return new Promise(() => {});
      if (entry.behavior === "slow") await delay(20);
      entry.delivered.push(structuredClone(event));
      if (entry.behavior === "mutate") {
        event.message = "mutated by output";
        event.data.mutated = true;
      }
    },
  };
  return handler;
}

function filterFrom(spec) {
  if (spec == null) return undefined;
  if (spec.throws) return () => { throw new Error("filter failed"); };
  if (spec.mutates) return (event) => { event.message = "mutated by filter"; event.data.mutated = true; return true; };
  if (typeof spec.messageIncludes === "string") return (event) => event.message.includes(spec.messageIncludes);
  throw new Error("Unknown filter spec");
}

const route = ({ method, path, resource, access }) => ({ method, path, resource, access });

export const subjects = {
  observer: async (init) => {
    const time = clock(init.now);
    const ids = [...(init.ids ?? [])];
    const store = await memoryStore(init.rows);
    const storage = new ObserverStore(store, { now: time.now });
    const state = new Map();
    const outputs = (init.outputs ?? []).map((raw) => {
      const spec = present(raw);
      const { id, type, behavior, filter, ...subscription } = spec;
      return {
        ...subscription,
        handler: type === "store" ? storage : scriptedOutput(spec, state),
        ...(filter ? { filter: filterFrom(filter) } : {}),
      };
    });
    const observer = new Observer(outputs, given(init.timeoutMs), {
      now: time.now,
      newId: () => ids.shift() ?? crypto.randomUUID(),
    });
    const feature = observerFeature(observer, storage, storage, { now: time.now });
    const endpoint = (method, path) => feature.endpoints.find((e) => e.method === method && e.path === path).handle;
    const find = (id) => {
      const entry = state.get(id);
      if (!entry) throw new Error("Unknown output " + id);
      return entry;
    };
    const facade = {
      emit: async (level, kind, source, message, data) => { await observer.emit(level, kind, source, message, given(data)); return null; },
      write: async (level, message, context, data) => { await observer.write(level, message, given(context), given(data)); return null; },
      log: async (...values) => { await observer.log(...values); return null; },
      info: async (...values) => { await observer.info(...values); return null; },
      debug: async (...values) => { await observer.debug(...values); return null; },
      warn: async (...values) => { await observer.warn(...values); return null; },
      warning: async (...values) => { await observer.warning(...values); return null; },
      error: async (...values) => { await observer.error(...values); return null; },
      countView: async (message, options) => { await observer.countView(message, present(options)); return null; },
      recordRequest: async (metric) => { await observer.recordRequest(metric); return null; },
      // measure(name, {value?, fail?, advanceMs?}, {source?}?): the operation advances the clock by
      // advanceMs, then throws Error(fail) or returns value.
      measure: (name, operation, options) =>
        observer.measure(
          name,
          () => {
            if (operation?.advanceMs) time.advance(operation.advanceMs);
            if (typeof operation?.fail === "string") throw new Error(operation.fail);
            return operation?.value ?? null;
          },
          present(given(options)),
        ),
      // withContext(context, [{call, args}]) → the results of the steps, run in order inside the context.
      withContext: (context, steps) =>
        observer.withContext(context, async () => {
          const results = [];
          for (const step of steps) results.push(await facade[step.call](...(step.args ?? [])));
          return results;
        }),
      // parallel([{context, delayMs, steps}]) → null: branches run concurrently, each in its context.
      parallel: async (branches) => {
        await Promise.all(
          branches.map((branch) =>
            observer.withContext(branch.context, async () => {
              await delay(branch.delayMs ?? 0);
              for (const step of branch.steps) await facade[step.call](...(step.args ?? []));
            }),
          ),
        );
        return null;
      },
      // burst(count, level, message) → null: count emits started together (kind log, source app).
      burst: async (count, level, message) => {
        await Promise.all(Array.from({ length: count }, () => observer.emit(level, "log", "app", message, {})));
        return null;
      },
      // emitMany(count, level, message) → null: count emits one after the other (kind log, source app).
      emitMany: async (count, level, message) => {
        for (let i = 0; i < count; i++) await observer.emit(level, "log", "app", message, {});
        return null;
      },
      delivered: (id) => find(id).delivered,
      aborted: (id) => find(id).signal?.aborted === true,
      setBehavior: (id, behavior) => { find(id).behavior = behavior; return null; },
      health: () => ({ ...observer.health }),
      setNow: (iso) => time.set(iso),
      // Storage (ObserverStore over the memory store holding init.rows).
      search: (query) => storage.search(query),
      storeReport: (day) => storage.report(day),
      storeWrite: async (event) => { await storage.write(event); return null; },
      list: (pk, cursor) => store.list(pk, given(cursor)),
      // Endpoint handlers (observerFeature with the same clock).
      report: (query) => endpoint("GET", "/observer/report")({ request: { query: present(given(query)) ?? {} } }),
      logs: (query) => endpoint("GET", "/observer/logs")({ request: { query: present(given(query)) ?? {} } }),
      ingest: (body, ip) => endpoint("POST", "/observer/events")({ request: { body: given(body) ?? {}, ip: given(ip) } }),
      ingestEach: async (ips, body) => {
        for (const ip of ips) await endpoint("POST", "/observer/events")({ request: { body, ip } });
        return null;
      },
      endpoints: () => feature.endpoints.map(route),
      admin: () => feature.admin,
    };
    return facade;
  },

  "observer-rules": () => ({
    sanitize: (value) => sanitize(value),
    safePath: (url) => safePath(url),
    validateLogQuery: (query) => { validateLogQuery(query); return null; },
    matchesLog: (event, query) => matchesLog(event, query),
  }),

  "observer-console": () => {
    const lines = [];
    const sink = Object.fromEntries(["debug", "info", "warn", "error"].map((level) => [level, (line) => lines.push({ level, line })]));
    const output = new ConsoleOutput(sink);
    return {
      id: () => output.id,
      write: async (event) => { await output.write(event); return null; },
      lines: () => lines,
    };
  },

  "observer-webhook": (init) => {
    const transport = fakeFetch(init);
    const output = new WebhookOutput(init.id, init.url, given(init.headers), transport.fetch);
    return { id: () => output.id, write: async (event) => { await output.write(event); return null; }, ...transport.methods };
  },

  "observer-slack": (init) => {
    const transport = fakeFetch(init);
    const output = new SlackOutput(init.webhook, transport.fetch);
    return { id: () => output.id, write: async (event) => { await output.write(event); return null; }, ...transport.methods };
  },

  "observer-email": (init) => {
    const client = fakeClient(init);
    const output = new EmailOutput(init.from, init.to, client.client);
    return { id: () => output.id, write: async (event) => { await output.write(event); return null; }, sent: () => client.sent };
  },

  "observer-email-local": (init) => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = init.production ? "production" : "test";
    let output;
    try {
      output = new LocalEmailOutput(init.from, init.to, given(init.port));
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
    // The SMTP transport is replaced by a recorder: no socket is opened.
    const sent = [];
    let failure = init.fail ?? null;
    output.transport = {
      sendMail: async (message) => {
        if (failure !== null) throw new Error(failure);
        sent.push(message);
      },
    };
    return {
      id: () => output.id,
      write: async (event) => { await output.write(event); return null; },
      sent: () => sent,
      setFailure: (message) => { failure = message; return null; },
    };
  },

  "observer-sms": (init) => {
    const client = fakeClient(init);
    const output = new SmsOutput(init.phone, client.client);
    return { id: () => output.id, write: async (event) => { await output.write(event); return null; }, sent: () => client.sent };
  },
};

/**
 * A fetch that records {url, method, headers, body} and answers init.status (200 by default), or
 * throws Error(init.fail) like a network failure. setStatus(n) / setFailure(message|null) change it.
 */
function fakeFetch(init) {
  const requests = [];
  let status = init.status ?? 200;
  let failure = init.fail ?? null;
  return {
    fetch: async (url, options) => {
      requests.push({ url: String(url), method: options.method, headers: { ...options.headers }, body: options.body });
      if (failure !== null) throw new Error(failure);
      return new Response(status === 204 || status === 304 ? null : "ignored", { status });
    },
    methods: {
      requests: () => requests,
      setStatus: (value) => { status = value; return null; },
      setFailure: (message) => { failure = message; return null; },
    },
  };
}

/** An AWS SDK client that records each command's input, or throws Error(init.fail). */
function fakeClient(init) {
  const sent = [];
  return {
    sent,
    client: {
      send: async (command) => {
        if (init.fail != null) throw new Error(init.fail);
        sent.push(structuredClone(command.input));
        return {};
      },
    },
  };
}
