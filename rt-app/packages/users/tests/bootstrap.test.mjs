import test from "node:test";
import assert from "node:assert/strict";
import {MemoryStore} from "@gsalgadotoledo/rt-app-dynamodb";
import {Users} from "@gsalgadotoledo/rt-app-users";
test("first owner creation is atomic across concurrent installers and preserves existing users", async () => {
  const store = new MemoryStore(),
    users = new Users(store);
  const results = await Promise.allSettled([
    users.bootstrapOwner({
      email: "first@example.test",
      name: "First",
      password: "Test-Owner-2026!",
    }),
    users.bootstrapOwner({
      email: "second@example.test",
      name: "Second",
      password: "Test-Owner-2026!",
    }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await store.list("USERS")).items.length, 1);
  assert.equal((await store.list("EMAIL")).items.length, 1);
  assert.ok(await store.get("INSTALLATION", "owner"));
  await assert.rejects(
    users.bootstrapOwner({
      email: "third@example.test",
      name: "Third",
      password: "Test-Owner-2026!",
    }),
    (e) => e.status === 409,
  );
});
