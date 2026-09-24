import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "@gsalgadotoledo/rt-app-dynamodb";
import { tasksFeature } from "../dist/index.js";

test("admin task routes require management grants and preserve the full trash/restore cycle", async () => {
  const feature = tasksFeature(new MemoryStore());
  const owner = { id: "root", role: "owner", grants: [] };
  const ordinary = { id: "other", role: "user", grants: [] };
  const run = (method, path, id, body = {}, actor = owner) =>
    feature.endpoints
      .find((e) => e.method === method && e.path === path)
      .handle({ params: { id }, actor, request: { body, query: {} } });
  const task = await run("POST", "/tasks", "", { title: "Example" });
  assert.equal((await run("GET", "/tasks/admin")).items.length, 1);
  await assert.rejects(
    run("DELETE", "/tasks/admin/:id", task.id, {}, ordinary),
    { status: 403 },
  );
  await assert.rejects(
    run("PATCH", "/tasks/admin/:id", task.id, { done: "yes" }),
    { status: 400 },
  );
  const updated = await run("PATCH", "/tasks/admin/:id", task.id, {
    title: "Changed",
    done: true,
  });
  assert.equal(updated.done, true);
  await run("DELETE", "/tasks/admin/:id", task.id);
  const restored = await run("POST", "/tasks/admin/:id/restore", task.id);
  assert.equal(restored.deletedAt, null);
  assert.equal(restored.title, "Changed");
  await run(
    "DELETE",
    "/tasks/admin/:id",
    task.id,
    {},
    { ...ordinary, grants: ["tasks.manage"] },
  );
});
