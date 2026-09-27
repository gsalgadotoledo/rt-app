import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "@gsalgadotoledo/rt-app-dynamodb";
import { Users } from "@gsalgadotoledo/rt-app-users";
import { JwtTokens } from "@gsalgadotoledo/rt-app-jwt";
import { Auth, LocalMailbox, sessionPartition } from "@gsalgadotoledo/rt-app-auth";
import { Conflict } from "@gsalgadotoledo/rt-app-contracts";
import { UserBans, banReason, banUntil, banCategory, banPartition, ROOT_ACTOR, BAN_SESSION_REASON } from "../dist/index.js";

const password = "correct horse battery";
const secret = "users-bans-test-secret-".repeat(3);
const root = { id: ROOT_ACTOR, role: "owner" };

/** Users, Auth and UserBans over one MemoryStore with a clock the test moves. */
async function setup({ store = new MemoryStore(), sessions = true } = {}) {
  let now = Date.parse("2026-03-01T10:00:00.000Z");
  const clock = { now: () => now, set: (iso) => { now = Date.parse(iso); }, advance: (ms) => { now += ms; } };
  const users = new Users(store, undefined, { now: clock.now });
  const auth = new Auth(users, new JwtTokens(secret, undefined, undefined, { now: clock.now }), new LocalMailbox(), secret, undefined, { now: clock.now });
  const bans = new UserBans(users, { now: clock.now, sessions: sessions ? auth.refreshSessions : undefined });
  const make = async (email, role = "user") => (await users.create({ name: email.split("@")[0], email, password }, role)).data;
  return { store, users, auth, bans, clock, make };
}

test("validation of reason, until and category (checked before the user is read)", async () => {
  const now = Date.parse("2026-03-01T10:00:00.000Z");
  assert.equal(banReason("  abc  "), "abc");
  assert.equal(banReason("x".repeat(500)), "x".repeat(500));
  assert.equal(banReason(" " + "😀".repeat(250) + " "), "😀".repeat(250), "UTF-16 units: 250 emoji are 500");
  for (const bad of [undefined, null, 5, ["abc"], "", "ab", "  ab  ", "x".repeat(501), "😀".repeat(251)])
    assert.throws(() => banReason(bad), { status: 400, message: "A reason of 3 to 500 characters is required" });
  assert.equal(banUntil(undefined, now), null);
  assert.equal(banUntil(null, now), null);
  assert.equal(banUntil("2026-03-01T11:00:00+01:00", now - 1), "2026-03-01T10:00:00.000Z");
  assert.equal(banUntil("2026-03-01T10:00:00.001Z", now), "2026-03-01T10:00:00.001Z");
  assert.equal(banUntil("2026-03-02T01:30:00.5+01:30", now), "2026-03-02T00:00:00.500Z");
  for (const bad of [5, true, "", "tomorrow", "2026-03-02", "2026-03-02T00:00", "2026-02-30T00:00:00Z"])
    assert.throws(() => banUntil(bad, now), { status: 400, message: "Invalid until: use an ISO 8601 date and time" });
  for (const past of ["2026-03-01T10:00:00.000Z", "2026-03-01T09:59:59.999Z", "2026-03-01T11:00:00+01:00"])
    assert.throws(() => banUntil(past, now), { status: 400, message: "until must be in the future" });
  assert.equal(banCategory(undefined), null);
  assert.equal(banCategory("fraud"), "fraud");
  assert.equal(banCategory("a" + "b".repeat(39)), "a" + "b".repeat(39));
  for (const bad of ["", "Fraud", "1abc", "a b", "a".repeat(41), 5, {}])
    assert.throws(() => banCategory(bad), { status: 400, message: "Invalid category" });

  const { bans, make } = await setup();
  const user = await make("user@example.test");
  await assert.rejects(bans.ban(user.id, { reason: "no" }, root), { status: 400 });
  await assert.rejects(bans.ban("nobody", { reason: "no" }, root), { status: 400 }, "validation first");
  await assert.rejects(bans.ban(user.id, null, root), { status: 400 });
  await assert.rejects(bans.unban(user.id, {}, root), { status: 400 });
});

test("who can ban whom", async () => {
  const { bans, make } = await setup();
  const owner = await make("owner@example.test", "owner"), other = await make("owner2@example.test", "owner");
  const admin = await make("admin@example.test", "admin"), admin2 = await make("admin2@example.test", "admin"), user = await make("user@example.test");
  const reason = { reason: "Policy violation" };
  for (const [target, actor, message] of [
    [owner.id, owner, "You cannot ban your own account"],
    [admin.id, admin, "You cannot ban your own account"],
    [other.id, owner, "Only the admin root can ban an owner"],
    [owner.id, admin, "Only the admin root can ban an owner"],
    [admin2.id, admin, "Only an owner can ban an administrator"],
  ])
    await assert.rejects(bans.ban(target, reason, actor), { status: 403, message });
  await assert.rejects(bans.ban("nobody", reason, root), { status: 404, message: "User not found" });
  await assert.rejects(bans.ban(5, reason, root), { status: 404, message: "User not found" });
  await assert.rejects(bans.ban("x".repeat(101), reason, root), { status: 404, message: "User not found" });
  assert.equal((await bans.ban(user.id, reason, admin)).banned, true, "an admin with the permission bans users");
  assert.equal((await bans.ban(admin2.id, reason, owner)).banned, true, "an owner bans administrators");
  assert.equal((await bans.ban(other.id, reason, root)).banned, true, "the admin root bans owners");
  await assert.rejects(bans.unban(other.id, reason, owner), { status: 403, message: "Only the admin root can unban an owner" });
  await assert.rejects(bans.unban(admin2.id, reason, admin), { status: 403, message: "Only an owner can unban an administrator" });
  await assert.rejects(bans.unban(owner.id, reason, owner), { status: 403, message: "You cannot unban your own account" });
  assert.equal((await bans.unban(other.id, reason, root)).banned, false);
});

test("a ban cuts every session at once and pins the rows", async () => {
  const { store, auth, bans, make, clock } = await setup();
  const user = await make("user@example.test");
  const one = await auth.login(user.email, password, "1.1.1.1"), two = await auth.login(user.email, password, "2.2.2.2");
  clock.advance(1000);
  const view = await bans.ban(user.id, { reason: "  Chargeback fraud  ", until: "2026-03-08T10:00:00Z", category: "fraud" }, root);
  const ban = { reason: "Chargeback fraud", category: "fraud", until: "2026-03-08T10:00:00.000Z", at: "2026-03-01T10:00:01.000Z", by: ROOT_ACTOR };
  assert.deepEqual({ banned: view.banned, ban: view.ban, updatedBy: view.updatedBy, updatedAt: view.updatedAt }, { banned: true, ban, updatedBy: ROOT_ACTOR, updatedAt: ban.at });
  const row = await store.get("USERS", user.id);
  assert.equal(row.version, 2);
  assert.equal(row.data.tokenVersion, 2);
  assert.deepEqual(row.data.ban, ban);
  assert.deepEqual(await store.get(banPartition(user.id), "001772359201000-0000000002"), {
    pk: "USER_BANS#" + user.id, sk: "001772359201000-0000000002", version: 1,
    data: { userId: user.id, action: "ban", reason: "Chargeback fraud", category: "fraud", until: ban.until, actorId: ROOT_ACTOR, at: ban.at },
  });
  for (const s of [one, two]) {
    const session = await store.get(sessionPartition(user.id), s.sessionId);
    assert.deepEqual([session.data.revokedAt, session.data.revokedReason], [clock.now(), BAN_SESSION_REASON]);
    await assert.rejects(auth.actor("Bearer " + s.token), { status: 401, message: "Invalid session" });
    await assert.rejects(auth.refresh(s.refreshToken, "1.1.1.1"), { status: 403, message: "Account suspended" });
  }
  await assert.rejects(auth.login(user.email, password, "1.1.1.1"), { status: 403, message: "Account suspended" });
  assert.deepEqual((await auth.sessions(user.id)).items, []);
});

test("temporary bans lift at until exactly; unban restores sign-in but not old sessions", async () => {
  const { store, auth, bans, make, clock } = await setup();
  const user = await make("user@example.test");
  const old = await auth.login(user.email, password, "1.1.1.1");
  await bans.ban(user.id, { reason: "Cool-down", until: "2026-03-01T11:00:00.000Z" }, root);
  clock.set("2026-03-01T10:59:59.999Z");
  await assert.rejects(auth.login(user.email, password, "1.1.1.1"), { status: 403, message: "Account suspended" });
  clock.set("2026-03-01T11:00:00.000Z");
  assert.ok((await auth.login(user.email, password, "1.1.1.1")).token, "lifted at until");
  await assert.rejects(bans.unban(user.id, { reason: "Nothing to lift" }, root), { status: 409, message: "User is not banned" });
  await assert.rejects(auth.refresh(old.refreshToken, "1.1.1.1"), { status: 401, message: "Invalid session" }, "the ban's cut stays");

  await bans.ban(user.id, { reason: "Permanent now" }, root);
  const view = await bans.unban(user.id, { reason: "Appeal accepted" }, { id: "u-owner", role: "owner" });
  assert.deepEqual([view.banned, view.ban], [false, null]);
  const row = await store.get("USERS", user.id);
  assert.equal(row.data.ban, null);
  assert.equal(row.data.tokenVersion, 3, "unban never bumps tokenVersion");
  assert.ok((await auth.login(user.email, password, "1.1.1.1")).token);
});

test("banning a banned account updates it (action update) and history is newest first", async () => {
  const { store, bans, make, clock, users } = await setup();
  const user = await make("user@example.test");
  await bans.ban(user.id, { reason: "First reason", category: "spam" }, root);
  clock.advance(60000);
  const updated = await bans.ban(user.id, { reason: "Second reason", until: "2026-04-01T00:00:00Z" }, { id: "u-admin", role: "admin" });
  assert.deepEqual(updated.ban, { reason: "Second reason", category: null, until: "2026-04-01T00:00:00.000Z", at: "2026-03-01T10:01:00.000Z", by: "u-admin" });
  clock.advance(60000);
  await bans.unban(user.id, { reason: "Resolved" }, root);
  const { items } = await bans.history(user.id);
  assert.deepEqual(items, [
    { id: "001772359320000-0000000004", userId: user.id, action: "unban", reason: "Resolved", category: null, until: null, actorId: ROOT_ACTOR, at: "2026-03-01T10:02:00.000Z" },
    { id: "001772359260000-0000000003", userId: user.id, action: "update", reason: "Second reason", category: null, until: "2026-04-01T00:00:00.000Z", actorId: "u-admin", at: "2026-03-01T10:01:00.000Z" },
    { id: "001772359200000-0000000002", userId: user.id, action: "ban", reason: "First reason", category: "spam", until: null, actorId: ROOT_ACTOR, at: "2026-03-01T10:00:00.000Z" },
  ]);
  // A ban that expired by itself is a new ban, not an update.
  clock.set("2026-05-01T00:00:00.000Z");
  await bans.ban(user.id, { reason: "Third", until: "2026-05-02T00:00:00Z" }, root);
  clock.set("2026-05-03T00:00:00.000Z");
  await bans.ban(user.id, { reason: "Fourth" }, root);
  assert.deepEqual((await bans.history(user.id)).items.slice(0, 2).map((i) => i.action), ["ban", "ban"]);
  await assert.rejects(bans.history("nobody"), { status: 404, message: "User not found" });
  await assert.rejects(bans.history(7), { status: 404 });
  // Deleted accounts cannot be banned but keep their history.
  const row = await users.get(user.id);
  await store.transact([{ row: { ...row, version: row.version + 1, data: { ...row.data, deletedAt: "2026-05-03T00:00:00.000Z" } }, expected: row.version }]);
  await assert.rejects(bans.ban(user.id, { reason: "Again" }, root), { status: 404 });
  assert.equal((await bans.history(user.id)).items.length, 5);
});

test("history reads every page", async () => {
  const store = new MemoryStore(), list = store.list.bind(store);
  store.list = async (pk, cursor) => {
    if (!pk.startsWith("USER_BANS#")) return list(pk, cursor);
    const all = await list(pk);
    const start = cursor ? Number(cursor) : 0;
    return { items: all.items.slice(start, start + 1), cursor: start + 1 < all.items.length ? String(start + 1) : undefined };
  };
  const { bans, make, clock } = await setup({ store });
  const user = await make("user@example.test");
  for (let i = 0; i < 3; i++) { await bans.ban(user.id, { reason: "Reason " + i }, root); clock.advance(1); }
  assert.deepEqual((await bans.history(user.id)).items.map((i) => i.reason), ["Reason 2", "Reason 1", "Reason 0"]);
});

test("concurrent changes are retried on the re-read row; 409 after four conflicts", async () => {
  const store = new MemoryStore(), transact = store.transact.bind(store);
  let failures = 0;
  store.transact = async (writes) => {
    if (failures > 0 && writes.some((w) => w.row.pk.startsWith("USER_BANS#"))) { failures--; throw new Conflict(); }
    return transact(writes);
  };
  const { bans, make } = await setup({ store, sessions: false });
  const user = await make("user@example.test");
  failures = 1;
  assert.equal((await bans.ban(user.id, { reason: "Retried" }, root)).banned, true);
  failures = 4;
  await assert.rejects(bans.unban(user.id, { reason: "Four conflicts" }, root), { status: 409, message: "Conflict: refresh and try again" });
  store.transact = async () => { throw new Error("database down"); };
  await assert.rejects(bans.unban(user.id, { reason: "Down" }, root), /database down/);
});

test("endpoints, permissions and tools", async () => {
  const { bans } = await setup();
  const feature = bans.feature();
  assert.equal(feature.id, "users-bans");
  assert.deepEqual(feature.endpoints.map((e) => [e.method, e.path, e.access, e.resource, e.tool.name]), [
    ["POST", "/users/:id/ban", "permission", "users.ban", "users_ban"],
    ["POST", "/users/:id/unban", "permission", "users.ban", "users_unban"],
    ["GET", "/users/:id/bans", "permission", "users.bans.read", "users_bans"],
  ]);
  assert.equal(feature.migrations[0].id, "users-bans:001");
});
