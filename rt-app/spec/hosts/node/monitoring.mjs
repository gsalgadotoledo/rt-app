// Subjects: health, health-monitor, health-http-probe, analytics, visits. Each subject is a small
// facade so every language exposes the same surface; helpers are documented in the contracts and
// docs/polyglot/{health,analytics,visits}.md.
import { createHmac } from "node:crypto";
import { HealthChecks, AvailabilityMonitor, httpHealthProbe } from "@gsalgadotoledo/rt-app-health";
import { Analytics } from "@gsalgadotoledo/rt-app-analytics";
import { Visits } from "@gsalgadotoledo/rt-app-visits";
import { memoryStore } from "./storage.mjs";

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
  };
}

const opt = (value) => (value === null ? undefined : value);

/**
 * Scripted probes: behavior "up" resolves, "down" rejects (with a secret-looking message the
 * report must never show), "slow" resolves after 50 ms, "hang" never settles (it only records
 * the abort signal). calls(id) counts invocations; aborted(id) reads the last signal.
 */
function scriptedProbes(specs = []) {
  const state = new Map();
  const probes = specs.map((spec) => {
    const entry = { behavior: spec.behavior ?? "up", calls: 0, signal: undefined };
    state.set(spec.id, entry);
    return {
      id: spec.id,
      ...(spec.required === undefined || spec.required === null ? {} : { required: spec.required }),
      check: async (signal) => {
        entry.calls++;
        entry.signal = signal;
        if (entry.behavior === "down") throw new Error("password=hunter2 at db.internal");
        if (entry.behavior === "slow") await new Promise((resolve) => setTimeout(resolve, 50));
        if (entry.behavior === "hang") await new Promise(() => {});
      },
    };
  });
  const find = (id) => {
    const entry = state.get(id);
    if (!entry) throw new Error("Unknown probe " + id);
    return entry;
  };
  return {
    probes,
    setProbe(id, behavior) {
      if (!["up", "down", "slow", "hang"].includes(behavior)) throw new Error("Unknown probe behavior");
      find(id).behavior = behavior;
      return null;
    },
    calls: (id) => find(id).calls,
    aborted: (id) => find(id).signal?.aborted === true,
  };
}

const route = ({ method, path, resource, access }) => ({ method, path, resource, access });

export const subjects = {
  health: (init) => {
    const time = clock(init.now);
    const scripted = scriptedProbes(init.probes ?? []);
    const health = new HealthChecks(scripted.probes, opt(init.timeoutMs), opt(init.cacheMs), { now: time.now });
    const endpoints = health.feature().endpoints;
    const handler = (path) => endpoints.find((e) => e.path === path).handle;
    return {
      report: () => health.report(),
      concurrentReports: (count) => Promise.all(Array.from({ length: count }, () => health.report())),
      live: () => handler("/health/live")({}),
      ready: () => handler("/health/ready")({}),
      healthReport: () => handler("/health/report")({}),
      endpoints: () => endpoints.map(route),
      setProbe: (id, behavior) => scripted.setProbe(id, behavior),
      calls: (id) => scripted.calls(id),
      aborted: (id) => scripted.aborted(id),
      setNow: (iso) => time.set(iso),
    };
  },

  "health-monitor": (init) => {
    const time = clock(init.now);
    const scripted = scriptedProbes(init.probes ?? []);
    const checks = new HealthChecks(scripted.probes, opt(init.timeoutMs), opt(init.cacheMs) ?? 0, { now: time.now });
    const alerts = [];
    let failures = 0;
    const monitor = new AvailabilityMonitor(checks, async (alert) => {
      if (failures > 0) {
        failures--;
        throw new Error("mail offline");
      }
      alerts.push(alert);
    });
    return {
      poll: () => monitor.poll(),
      alerts: () => alerts,
      failNotifications: (count) => { failures = count; return null; },
      setProbe: (id, behavior) => scripted.setProbe(id, behavior),
      setNow: (iso) => time.set(iso),
    };
  },

  "health-http-probe": () => ({
    probe: (id, url) => {
      const probe = httpHealthProbe(id, url, async () => ({ ok: true }));
      return { id: probe.id };
    },
    // Runs the probe's check against a transport answering `status` (fetch: ok is 200-299).
    check: async (url, status) => {
      const probe = httpHealthProbe("probe", url, async () => ({ ok: status >= 200 && status <= 299, status, body: null }));
      await probe.check(new AbortController().signal);
      return null;
    },
  }),

  analytics: () => {
    // A spy observer: records every call with the log context active when it was made.
    const calls = [];
    let context = {};
    const observer = {
      withContext(extra, operation) {
        const previous = context;
        context = { ...previous, ...extra };
        try {
          return operation();
        } finally {
          context = previous;
        }
      },
      emit(level, kind, source, message, data) {
        calls.push({ method: "emit", level, kind, source, message, data, context: { ...context } });
      },
      countView(message, options) {
        calls.push({ method: "countView", message, options, context: { ...context } });
      },
    };
    const analytics = new Analytics(observer);
    return {
      track: async (name, properties, source) => { await analytics.track(name, opt(properties), opt(source)); return null; },
      pageView: async (title, options) => { await analytics.pageView(title, options); return null; },
      calls: () => calls,
    };
  },

  visits: async (init) => {
    const time = clock(init.now);
    const store = await memoryStore(init.rows);
    const ids = [...(init.ids ?? [])];
    const visits = new Visits(store, init.secret, opt(init.pages), time.now, ids.length ? () => ids.shift() ?? crypto.randomUUID() : undefined);
    const signature = (payload) => createHmac("sha256", init.secret).update("visits:" + payload).digest("base64url");
    return {
      start: (ip) => visits.start(ip),
      ingest: (input, ip) => visits.ingest(input, ip),
      list: () => visits.list(),
      detail: (id) => visits.detail(id),
      remove: (id) => visits.remove(id),
      // Helpers: start once per ip (a loop over start), stored rows, clock and token signing.
      startEach: (ips) => { for (const ip of ips) visits.start(ip); return null; },
      row: (pk, sk) => store.get(pk, sk),
      setNow: (iso) => time.set(iso),
      sign: (payload) => payload + "." + signature(payload),
    };
  },
};
