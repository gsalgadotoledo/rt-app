import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "@gsalgadotoledo/rt-app-dynamodb";
import { Visits } from "../dist/index.js";

test("visit routes keep ingestion separate from owner-only list/detail/removal", async () => {
  const visits = new Visits(new MemoryStore(), "test-secret-".repeat(4));
  const endpoints = visits.feature().endpoints;
  const invoke = (method, path, body = {}, id = "") =>
    endpoints
      .find((e) => e.method === method && e.path === path)
      .handle({ request: { body, ip: "127.0.0.1" }, params: { id } });
  const token = await invoke("POST", "/visits/start");
  await invoke("POST", "/visits/events", {
    ...token,
    sequence: 1,
    points: [{ type: "page", path: "/", t: 0, x: 0, y: 0 }],
  });
  const page = await invoke("GET", "/visits");
  assert.equal(page.items.length, 1);
  const detail = await invoke("GET", "/visits/:id", {}, page.items[0].id);
  assert.equal(detail.points.length, 1);
  for (const route of endpoints.filter(
    (e) => !e.path.endsWith("/start") && !e.path.endsWith("/events"),
  ))
    assert.equal(route.access, "owner");
  await invoke("DELETE", "/visits/:id", {}, page.items[0].id);
  await assert.rejects(invoke("GET", "/visits/:id", {}, page.items[0].id), {
    status: 404,
  });
  assert.equal((await invoke("GET", "/visits")).items.length, 0);
});
