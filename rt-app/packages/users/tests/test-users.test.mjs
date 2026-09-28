import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "@gsalgadotoledo/rt-app-dynamodb";
import { LocalMailbox } from "@gsalgadotoledo/rt-app-auth";
import { createApplication } from "@gsalgadotoledo/rt-app-framework";
import { Users, DEMO_USERS, isTestUser, testUserInput, testUserFilter, testUserIds, viewAccount } from "../dist/index.js";

const NOW = Date.parse("2026-03-01T10:00:00.000Z");
const password = "correct horse battery";

function fixture() {
  const store = new MemoryStore(), users = new Users(store, undefined, { now: () => NOW });
  const endpoints = users.feature().endpoints;
  const endpoint = (method, path) => endpoints.find((e) => e.method === method && e.path === path);
  return { store, users, endpoint };
}

test("isTestUser and the input/filter validators are strict", () => {
  assert.equal(isTestUser(undefined), false);
  assert.equal(isTestUser({}), false);
  assert.equal(isTestUser({ testUser: "true" }), false);
  assert.equal(isTestUser({ testUser: 1 }), false);
  assert.equal(isTestUser({ testUser: true }), true);
  assert.equal(testUserInput(undefined), undefined);
  assert.equal(testUserInput(null), undefined);
  assert.equal(testUserInput(false), false);
  assert.equal(testUserInput(true), true);
  for (const bad of ["true", 1, 0, {}, []])
    assert.throws(() => testUserInput(bad), { status: 400, message: "Invalid field: testUser" });
  for (const ok of [undefined, "", "true", "false"]) testUserFilter(ok);
  for (const bad of ["yes", "TRUE", "1", "t"])
    assert.throws(() => testUserFilter(bad), { status: 400, message: "Invalid testUser filter" });
  assert.equal(viewAccount({ id: "u", testUser: true }, NOW).testUser, true);
  assert.equal(viewAccount({ id: "u" }, NOW).testUser, false);
});

test("create stores testUser only when true; bootstrap ignores it; invalid values store nothing", async () => {
  const { users } = fixture();
  const owner = await users.bootstrapOwner({ email: "owner@example.test", name: "Owner", password, testUser: true });
  assert.equal("testUser" in owner.data, false, "the first owner is never a test user");
  const qa = await users.create({ email: "qa@example.test", name: "QA", password, testUser: true }, "user", owner.data.id);
  assert.equal(qa.data.testUser, true);
  const real = await users.create({ email: "real@example.test", name: "Real", password, testUser: false });
  assert.equal("testUser" in real.data, false);
  await assert.rejects(users.create({ email: "bad@example.test", name: "Bad", password, testUser: "yes" }), { status: 400, message: "Invalid field: testUser" });
  await assert.rejects(users.create({ email: "bad@example.test", name: "Bad", password: "short", testUser: "yes" }), { message: "The password must contain 12 to 128 characters" }, "password is validated first");
  assert.equal(await users.byEmail("bad@example.test"), undefined);
});

test("update toggles testUser and edits the name; bans, tokenVersion and other fields are untouched", async () => {
  const { store, users } = fixture();
  const ban = { reason: "Spam", category: null, until: null, at: "2026-03-01T09:00:00.000Z", by: "rt-app-root" };
  await store.transact([{ row: { pk: "USERS", sk: "u-1", version: 1, data: { id: "u-1", email: "a@example.test", name: "A", role: "user", grants: [], active: true, tokenVersion: 3, ban } }, expected: null }]);
  const on = await users.update("u-1", { testUser: true }, "admin-1");
  assert.deepEqual([on.testUser, on.banned, on.name, on.updatedBy], [true, true, "A", "admin-1"]);
  let row = await store.get("USERS", "u-1");
  assert.deepEqual([row.version, row.data.testUser, row.data.tokenVersion, row.data.ban], [2, true, 3, ban]);
  assert.equal((await users.update("u-1", { name: "  Ana " }, "admin-1")).testUser, true, "a name edit keeps the flag");
  const off = await users.update("u-1", { name: "Ana", testUser: false }, "admin-1");
  assert.deepEqual([off.testUser, off.name], [false, "Ana"]);
  row = await store.get("USERS", "u-1");
  assert.deepEqual([row.version, row.data.testUser], [4, false]);
  for (const [input, message] of [
    [{}, "Invalid field: name"],
    [{ testUser: null }, "Invalid field: name"],
    [{ name: null }, "Invalid field: name"],
    [{ testUser: "yes" }, "Invalid field: testUser"],
    [{ name: "B", testUser: 1 }, "Invalid field: testUser"],
    [{ email: "x@example.test" }, "Only name and testUser can be edited; email requires verification"],
    [{ role: "owner", testUser: true }, "Only name and testUser can be edited; email requires verification"],
  ])
    await assert.rejects(users.update("u-1", input, "admin-1"), { status: 400, message }, JSON.stringify(input));
  await assert.rejects(users.update("missing", { email: "x" }, "admin-1"), { status: 404, message: "User not found" });
  assert.equal((await store.get("USERS", "u-1")).version, 4, "rejected edits write nothing");
  await assert.rejects(users.profile("u-1", { testUser: true }), { status: 400, message: "Only name can be edited; email requires verification" }, "self edits cannot set the flag");
});

test("the list filters by testUser, validates the filter and testUserIds lists them", async () => {
  const { store, users, endpoint } = fixture();
  const base = { role: "user", grants: [], active: true, tokenVersion: 1 };
  await store.transact([
    { row: { pk: "USERS", sk: "u-1", version: 1, data: { ...base, id: "u-1", email: "a@example.test", name: "A", testUser: true } }, expected: null },
    { row: { pk: "USERS", sk: "u-2", version: 1, data: { ...base, id: "u-2", email: "b@example.test", name: "B" } }, expected: null },
    { row: { pk: "USERS", sk: "u-3", version: 1, data: { ...base, id: "u-3", email: "c@example.test", name: "C", testUser: "yes" } }, expected: null },
    { row: { pk: "USERS", sk: "u-4", version: 2, data: { ...base, id: "u-4", email: "d@example.test", name: "D", testUser: true, deletedAt: "2026-02-01T00:00:00.000Z" } }, expected: null },
  ]);
  const list = (query) => endpoint("GET", "/users").handle({ request: { query }, params: {} });
  assert.deepEqual((await list({})).items.map((u) => [u.id, u.testUser]), [["u-1", true], ["u-2", false], ["u-3", false]]);
  assert.deepEqual((await list({ testUser: "true" })).items.map((u) => u.id), ["u-1"]);
  assert.deepEqual((await list({ testUser: "false" })).items.map((u) => u.id), ["u-2", "u-3"]);
  assert.deepEqual((await list({ testUser: "" })).items.length, 3);
  assert.deepEqual((await list({ testUser: "true", trash: "true" })).items.map((u) => u.id), ["u-4"]);
  await assert.rejects(list({ testUser: "yes" }), { status: 400, message: "Invalid testUser filter" });
  assert.equal((await endpoint("GET", "/users/:id").handle({ request: {}, params: { id: "u-1" } })).testUser, true);
  assert.deepEqual([...(await testUserIds(store))].sort(), ["u-1", "u-4"]);
  assert.equal(users.feature().admin.fields.includes("testUser"), true);
});

test("demo seeds mark the demo customers as test users", async () => {
  assert.deepEqual(DEMO_USERS.map((u) => [u.email, u.testUser]), [["owner@example.test", false], ["ana@example.test", true], ["leo@example.test", true]]);
  const { users } = fixture();
  const [seed] = users.feature().seeds;
  await seed.run({ secret: () => password, log: () => {} });
  assert.deepEqual((await users.demoUsers()).map((row) => isTestUser(row.data)), [false, true, true]);
});

test("HTTP: only administrators set the flag; the user cannot set it on itself", async () => {
  const store = new MemoryStore(), app = createApplication({ store, mailer: new LocalMailbox(), secret: "test-users-secret".repeat(4), localAdminAccess: true });
  await app.migrate();
  const call = (method, path, body = {}, query = {}, token) => app.handle({ method, path, body, query, headers: token ? { authorization: "Bearer " + token } : {}, ip: "local" });
  const created = await call("POST", "/admin/app/users", { name: "QA", email: "qa@example.test", password, testUser: true });
  assert.equal(created.status, 200);
  assert.deepEqual([created.body.testUser, created.body.banned], [true, false]);
  const login = await call("POST", "/auth/login", { email: "qa@example.test", password });
  assert.equal((await call("PATCH", "/users/me", { testUser: false }, {}, login.body.token)).status, 400);
  assert.equal((await call("PATCH", "/users/" + created.body.id, { testUser: false }, {}, login.body.token)).status, 403);
  const toggled = await call("PATCH", "/admin/app/users/" + created.body.id, { testUser: false });
  assert.deepEqual([toggled.status, toggled.body.testUser, toggled.body.updatedBy], [200, false, "rt-app-root"]);
  assert.equal((await call("GET", "/admin/app/users", {}, { testUser: "true" })).body.items.length, 0);
  assert.equal((await call("GET", "/admin/app/users", {}, { testUser: "maybe" })).status, 400);
  assert.equal((await call("GET", "/users/me", {}, {}, login.body.token)).status, 200, "the flag does not affect sessions");
});
