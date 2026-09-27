import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "@gsalgadotoledo/rt-app-dynamodb";
import { Users, activeBan, parseInstant, viewAccount, ACCOUNT_SUSPENDED, MAX_INSTANT_MS } from "../dist/index.js";

const NOW = Date.parse("2026-03-01T10:00:00.000Z");
const ban = (until = null) => ({ reason: "Spam", category: null, until, at: "2026-03-01T09:00:00.000Z", by: "rt-app-root" });

test("parseInstant accepts the strict grammar only", () => {
  assert.equal(parseInstant("2026-01-02T03:04:05Z"), Date.parse("2026-01-02T03:04:05Z"));
  assert.equal(parseInstant("2026-01-02T03:04:05.1Z"), Date.parse("2026-01-02T03:04:05.100Z"));
  assert.equal(parseInstant("2026-01-02T03:04:05.123+01:30"), Date.parse("2026-01-02T01:34:05.123Z"));
  assert.equal(parseInstant("2026-01-02T03:04:05-05:00"), Date.parse("2026-01-02T08:04:05Z"));
  assert.equal(parseInstant("2024-02-29T00:00:00Z"), Date.parse("2024-02-29T00:00:00Z"));
  assert.equal(parseInstant("9999-12-31T23:59:59.999Z"), MAX_INSTANT_MS);
  for (const bad of [
    undefined, null, 5, "", "2026-01-02", "2026-01-02T03:04Z", "2026-01-02T03:04:05", "2026-01-02 03:04:05Z",
    "2026-01-02T03:04:05.1234Z", "2026-01-02T03:04:05z", "2026-13-01T00:00:00Z", "2026-00-01T00:00:00Z",
    "2025-02-29T00:00:00Z", "2100-02-29T00:00:00Z", "2026-04-31T00:00:00Z", "2026-01-00T00:00:00Z",
    "2026-01-02T24:00:00Z", "2026-01-02T00:60:00Z", "2026-01-02T00:00:60Z", "2026-01-02T00:00:00+24:00",
    "2026-01-02T00:00:00+01:60", "1969-12-31T23:59:59Z", "1970-01-01T00:00:00+00:01", "9999-12-31T23:59:59-00:01",
    "+02026-01-02T00:00:00Z", "٢٠٢٦-01-02T00:00:00Z",
  ])
    assert.equal(parseInstant(bad), undefined, String(bad));
  assert.equal(parseInstant("2000-02-29T00:00:00Z"), Date.parse("2000-02-29T00:00:00Z"));
  assert.equal(parseInstant("1970-01-01T00:00:00Z"), 0);
});

test("activeBan: permanent, temporary until the boundary, fail closed on unreadable until", () => {
  assert.equal(activeBan(undefined, NOW), null);
  assert.equal(activeBan({}, NOW), null);
  assert.equal(activeBan({ ban: null }, NOW), null);
  assert.equal(activeBan({ ban: "yes" }, NOW), null);
  assert.equal(activeBan({ ban: [] }, NOW), null);
  assert.deepEqual(activeBan({ ban: ban() }, NOW), ban());
  assert.deepEqual(activeBan({ ban: ban("2026-03-01T10:00:00.001Z") }, NOW), ban("2026-03-01T10:00:00.001Z"));
  assert.equal(activeBan({ ban: ban("2026-03-01T10:00:00.000Z") }, NOW), null, "until <= now is lifted");
  assert.deepEqual(activeBan({ ban: ban("next week") }, NOW).until, "next week");
  assert.deepEqual(activeBan({ ban: { reason: "x" } }, NOW), { reason: "x", category: null, until: null, at: null, by: null });
  assert.equal(ACCOUNT_SUSPENDED, "Account suspended");
});

test("list and read show the ban status; banned is a filter", async () => {
  let now = NOW;
  const store = new MemoryStore(), users = new Users(store, undefined, { now: () => now });
  const data = { id: "u-1", email: "a@example.test", name: "A", role: "user", grants: [], active: true, tokenVersion: 2, ban: ban("2026-03-02T00:00:00.000Z") };
  await store.transact([
    { row: { pk: "USERS", sk: "u-1", version: 1, data }, expected: null },
    { row: { pk: "USERS", sk: "u-2", version: 1, data: { ...data, id: "u-2", email: "b@example.test", ban: null } }, expected: null },
  ]);
  const endpoints = users.feature().endpoints, list = endpoints.find((e) => e.path === "/users" && e.method === "GET"), read = endpoints.find((e) => e.path === "/users/:id" && e.method === "GET");
  const page = await list.handle({ request: { query: {} }, params: {} });
  assert.deepEqual(page.items.map((u) => [u.id, u.banned, u.ban?.reason ?? null]), [["u-1", true, "Spam"], ["u-2", false, null]]);
  assert.equal(page.items[0].tokenVersion, undefined);
  assert.deepEqual((await list.handle({ request: { query: { banned: "true" } }, params: {} })).items.map((u) => u.id), ["u-1"]);
  assert.equal((await read.handle({ request: {}, params: { id: "u-1" } })).banned, true);
  now = Date.parse("2026-03-02T00:00:00.000Z");
  assert.deepEqual(await read.handle({ request: {}, params: { id: "u-1" } }), viewAccount({ ...data, ban: null }, now));
  assert.equal(users.feature().admin.fields.includes("banned"), true);
});
