import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "@gsalgadotoledo/rt-app-dynamodb";
import { ACL } from "../dist/index.js";

const owner = { id: "root", role: "owner", grants: [] };
const user = { id: "alice", role: "user", grants: ["items.read"] };
const resources = [
  {
    resource: "items.read",
    method: "GET",
    path: "/items",
    access: "permission",
  },
  { resource: "secret", access: "owner" },
];

test("access matrix, including explicit grants for owners", () => {
  const acl = new ACL(new MemoryStore(), () => resources);
  acl.check({ access: "guest" });
  assert.throws(() => acl.check({ access: "authenticated" }), { status: 401 });
  acl.check({ access: "authenticated" }, user);
  acl.check({ access: "owner" }, owner);
  assert.throws(() => acl.check({ access: "owner" }, user), { status: 403 });
  acl.check(resources[0], user);
  acl.check({ access: "permission", resource: "other" }, owner);
  assert.throws(
    () => acl.check({ access: "permission", resource: "other" }, user),
    { status: 403 },
  );
  assert.throws(
    () => acl.check({ ...resources[0], explicitGrant: true }, owner),
    { status: 403 },
  );
  acl.check({ ...resources[0], explicitGrant: true }, user);
  assert.equal(acl.allows(undefined, "items.read"), false);
});

test("permission assignment validates delegation, revokes old sessions and preserves optimistic concurrency", async () => {
  const store = new MemoryStore();
  for (const [id, role, deletedAt] of [
    ["alice", "user"],
    ["root", "owner"],
    ["deleted", "user", "2026-01-01"],
  ]) {
    await store.transact([
      {
        row: {
          pk: "USERS",
          sk: id,
          version: 1,
          data: { id, role, tokenVersion: 0, grants: [], deletedAt },
        },
        expected: null,
      },
    ]);
  }
  const endpoints = new ACL(store, () => resources).feature().endpoints;
  const assign = (id, body, actor = owner) =>
    endpoints[1].handle({ params: { id }, actor, request: { body } });
  const body = { role: "admin", grants: ["items.read", "items.read"] };
  await assert.rejects(assign("alice", body, user), { status: 403 });
  await assert.rejects(assign("root", body), { status: 403 });
  for (const id of ["missing", "deleted"])
    await assert.rejects(assign(id, body), { status: 404 });
  for (const invalid of [
    { role: "owner", grants: [] },
    { role: "user", grants: ["secret"] },
    { role: "user", grants: "items.read" },
    { role: "user", grants: Array(101).fill("items.read") },
  ]) {
    await assert.rejects(assign("alice", invalid), { status: 400 });
  }
  await assign("alice", body);
  const row = await store.get("USERS", "alice");
  assert.equal(row.version, 2);
  assert.equal(row.data.tokenVersion, 1);
  assert.equal(row.data.updatedBy, "root");
  assert.deepEqual(row.data.grants, ["items.read"]);
  const list = await endpoints[0].handle({ request: { query: {} } });
  assert.ok(JSON.stringify(list).includes("items.read"));
});
