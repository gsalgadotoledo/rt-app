import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "@gsalgadotoledo/rt-app-dynamodb";
import { tasksFeature } from "../dist/index.js";

test("audit timestamps come from the injected clock", async () => {
  let now = new Date("2026-01-02T03:04:05.678Z");
  const feature = tasksFeature(new MemoryStore(), { now: () => now });
  const actor = { id: "a", role: "user", grants: [] };
  const run = (method, path, id, body = {}) =>
    feature.endpoints.find((e) => e.method === method && e.path === path).handle({ params: { id }, actor, request: { body, query: {} } });
  const task = await run("POST", "/tasks", undefined, { title: "Clocked" });
  assert.equal(task.createdAt, "2026-01-02T03:04:05.678Z");
  assert.equal(task.updatedAt, "2026-01-02T03:04:05.678Z");
  now = new Date("2026-02-03T00:00:00.000Z");
  const updated = await run("PATCH", "/tasks/:id", task.id, { done: true });
  assert.equal(updated.createdAt, "2026-01-02T03:04:05.678Z");
  assert.equal(updated.updatedAt, "2026-02-03T00:00:00.000Z");
});

test("the clock is optional (FeatureFactory-compatible)", async () => {
  const feature = tasksFeature(new MemoryStore());
  const create = feature.endpoints.find((e) => e.method === "POST" && e.path === "/tasks");
  const task = await create.handle({ params: {}, actor: { id: "a", role: "user", grants: [] }, request: { body: { title: "x" }, query: {} } });
  assert.match(task.createdAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
});
