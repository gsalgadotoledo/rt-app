// Subjects: content, tasks (document modules). Each subject is a facade over the module's
// endpoint handlers, so every language exposes the same surface; see docs/polyglot/content.md
// and docs/polyglot/tasks.md.
import { contentFeature } from "@gsalgadotoledo/rt-app-content";
import { tasksFeature } from "@gsalgadotoledo/rt-app-tasks";
import { memoryStore } from "./storage.mjs";

/** A settable clock starting at init.now (ISO 8601); the system clock when absent. */
function clock(now) {
  let fixed = now == null ? undefined : Date.parse(now);
  if (Number.isNaN(fixed)) throw new Error("init.now must be an ISO 8601 date");
  return {
    now: () => new Date(fixed ?? Date.now()),
    set(iso) {
      const value = Date.parse(iso);
      if (typeof iso !== "string" || Number.isNaN(value)) throw new Error("setNow needs an ISO 8601 date");
      fixed = value;
      return null;
    },
  };
}

/** Endpoint metadata as the framework registers it (before mounting under /admin/app). */
const routes = (feature) =>
  feature.endpoints.map(({ method, path, resource, access }) => ({ method, path, resource, access }));

/** Migration metadata and a runner over the subject's store. */
function migrations(feature, store) {
  return {
    migrations: () => feature.migrations.map(({ id, checksum, description }) => ({ id, checksum, description })),
    migrate: async () => {
      for (const migration of feature.migrations) await migration.up({ store });
      return null;
    },
  };
}

/** Calls one endpoint handler: body and query default to {} (wire null), params as given. */
function caller(feature) {
  return (method, path, { params = {}, body, query, actor } = {}) =>
    feature.endpoints
      .find((e) => e.method === method && e.path === path)
      .handle({ request: { body: body ?? {}, query: query ?? {} }, params, actor: actor ?? undefined });
}

export const subjects = {
  content: async (init) => {
    const store = await memoryStore(init.rows);
    const feature = contentFeature(store);
    const call = caller(feature);
    return {
      home: () => call("GET", "/"),
      settings: () => call("GET", "/content/settings"),
      save: (body) => call("PUT", "/content/settings", { body }),
      endpoints: () => routes(feature),
      admin: () => feature.admin,
      ...migrations(feature, store),
      row: (pk, sk) => store.get(pk, sk),
    };
  },

  tasks: async (init) => {
    const time = clock(init.now);
    const store = await memoryStore(init.rows);
    const feature = tasksFeature(store, { now: time.now });
    const call = caller(feature);
    return {
      list: (query, actor) => call("GET", "/tasks", { query, actor }),
      listAll: (query, actor) => call("GET", "/tasks/admin", { query, actor }),
      create: (body, actor) => call("POST", "/tasks", { body, actor }),
      update: (id, body, actor) => call("PATCH", "/tasks/:id", { params: { id }, body, actor }),
      remove: (id, actor) => call("DELETE", "/tasks/:id", { params: { id }, actor }),
      restore: (id, actor) => call("POST", "/tasks/:id/restore", { params: { id }, actor }),
      manage: (id, body, actor) => call("PATCH", "/tasks/admin/:id", { params: { id }, body, actor }),
      adminRemove: (id, actor) => call("DELETE", "/tasks/admin/:id", { params: { id }, actor }),
      adminRestore: (id, actor) => call("POST", "/tasks/admin/:id/restore", { params: { id }, actor }),
      endpoints: () => routes(feature),
      admin: () => feature.admin,
      ...migrations(feature, store),
      seeds: () => feature.seeds.map(({ id, description, version, environments }) => ({ id, description, version, environments })),
      // Rows the welcome seed asks ensureRows to insert for the given demo user rows.
      seedRows: async (users) => {
        const rows = [];
        for (const seed of feature.seeds)
          await seed.run({
            service: () => ({ demoUsers: async () => users ?? [] }),
            ensureRows: async (list) => {
              rows.push(...list);
              return list.map((row) => row.sk);
            },
          });
        return rows;
      },
      row: (pk, sk) => store.get(pk, sk),
      setNow: (iso) => time.set(iso),
    };
  },
};
