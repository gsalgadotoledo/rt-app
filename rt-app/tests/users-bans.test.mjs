import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "@gsalgadotoledo/rt-app-dynamodb";
import { LocalMailbox } from "@gsalgadotoledo/rt-app-auth";
import { createApplication } from "../dist/index.js";

const password = "correct horse battery";

test("users-bans over HTTP: permission users.ban, ban status in the user list, admin tools", async () => {
  const app = createApplication({ store: new MemoryStore(), mailer: new LocalMailbox(), secret: "bans-framework-".repeat(4), localAdminAccess: true, observerOutputs: [] });
  await app.migrate();
  const call = (method, path, body = {}, token, query = {}) =>
    app.handle({ method, path, body, query, headers: token ? { authorization: "Bearer " + token } : {}, ip: "local" });
  const owner = (await app.users.create({ name: "Owner", email: "owner@example.test", password }, "owner")).data;
  const admin = (await app.users.create({ name: "Admin", email: "admin@example.test", password }, "admin")).data;
  const peer = (await app.users.create({ name: "Peer", email: "peer@example.test", password }, "admin")).data;
  const user = (await call("POST", "/admin/app/users", { name: "User", email: "user@example.test", password })).body;
  assert.equal((await call("PUT", "/admin/app/acl/users/" + admin.id, { role: "admin", grants: ["users.ban", "users.bans.read", "users.list"] })).status, 200);
  const login = async (email) => (await call("POST", "/auth/login", { email, password })).body;
  const [ownerSession, adminSession, userSession] = [await login(owner.email), await login(admin.email), await login(user.email)];

  // The ACL: the grant is required for non-owners; owners pass; a plain user is refused.
  assert.deepEqual(await call("POST", `/users/${admin.id}/ban`, { reason: "Nope" }, userSession.token), { status: 403, body: { error: "You do not have permission to access this resource" } });
  assert.deepEqual(await call("POST", `/users/${peer.id}/ban`, { reason: "Peer review" }, adminSession.token), { status: 403, body: { error: "Only an owner can ban an administrator" } });
  assert.deepEqual(await call("POST", `/users/${owner.id}/ban`, { reason: "Coup attempt" }, ownerSession.token), { status: 403, body: { error: "You cannot ban your own account" } });
  const banned = await call("POST", `/users/${user.id}/ban`, { reason: "Abuse reports", category: "abuse" }, adminSession.token);
  assert.equal(banned.status, 200);
  assert.deepEqual(banned.body.ban, { reason: "Abuse reports", category: "abuse", until: null, at: banned.body.updatedAt, by: admin.id });
  assert.deepEqual(await call("GET", "/users/me", {}, userSession.token), { status: 401, body: { error: "Invalid session" } });
  assert.deepEqual(await call("POST", "/auth/refresh", { refreshToken: userSession.refreshToken }), { status: 403, body: { error: "Account suspended" } });

  // The list and the record view carry the status; banned is a filter.
  const list = await call("GET", "/users", {}, adminSession.token, { banned: "true" });
  assert.deepEqual(list.body.items.map((u) => [u.email, u.banned]), [["user@example.test", true]]);
  assert.equal((await call("GET", "/admin/app/users/" + user.id)).body.ban.category, "abuse");
  assert.equal((await call("GET", `/users/${user.id}/bans`, {}, adminSession.token)).body.items[0].action, "ban");
  assert.equal((await call("POST", `/admin/app/users/${owner.id}/ban`, { reason: "Root decision" })).status, 200, "the admin root bans an owner");
  assert.deepEqual(await call("GET", "/users/me", {}, ownerSession.token), { status: 401, body: { error: "Invalid session" } });

  const tools = (await call("GET", "/admin/tools")).body.filter((t) => t.name.startsWith("users_"));
  assert.deepEqual(tools.map((t) => [t.name, t.method, t.path]), [
    ["users_ban", "POST", "/admin/app/users/:id/ban"],
    ["users_unban", "POST", "/admin/app/users/:id/unban"],
    ["users_bans", "GET", "/admin/app/users/:id/bans"],
  ]);
  const resources = (await call("GET", "/admin/app/acl/resources")).body.map((r) => r.resource);
  assert.ok(resources.includes("users.ban") && resources.includes("users.bans.read"));
});

test("users-bans is a module: leaving it out removes its endpoints, not the enforcement", async () => {
  const store = new MemoryStore();
  const app = createApplication({ store, mailer: new LocalMailbox(), secret: "bans-framework-".repeat(4), localAdminAccess: true, observerOutputs: [], modules: ["content", "infra", "users", "auth", "acl"] });
  const user = (await app.users.create({ name: "User", email: "user@example.test", password })).data;
  const call = (method, path, body = {}) => app.handle({ method, path, body, query: {}, headers: {}, ip: "local" });
  assert.equal((await call("POST", `/admin/app/users/${user.id}/ban`, { reason: "Abuse" })).status, 404);
  const row = await store.get("USERS", user.id);
  await store.transact([{ row: { ...row, version: 2, data: { ...row.data, ban: { reason: "Written elsewhere", category: null, until: null, at: "2026-01-01T00:00:00.000Z", by: "rt-app-root" } } }, expected: 1 }]);
  assert.deepEqual(await call("POST", "/auth/login", { email: user.email, password }), { status: 403, body: { error: "Account suspended" } });
});
