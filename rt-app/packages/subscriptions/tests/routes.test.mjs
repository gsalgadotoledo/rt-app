import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "@gsalgadotoledo/rt-app-dynamodb";
import { Subscriptions, LocalBilling } from "../dist/index.js";

test("subscription routes support local billing, preferences and administrative inspection without network calls", async () => {
  const store = new MemoryStore(),
    subscriptions = new Subscriptions(store, new LocalBilling(store));
  const actor = {
    id: "alice",
    email: "alice@example.test",
    role: "owner",
    grants: [],
  };
  await store.transact([
    {
      row: { pk: "USERS", sk: actor.id, version: 1, data: actor },
      expected: null,
    },
  ]);
  const routes = subscriptions.feature().endpoints;
  const run = (method, path, body = {}, id = "alice") =>
    routes
      .find((e) => e.method === method && e.path === path)
      .handle({
        actor,
        params: { id },
        request: { body, query: {}, headers: {} },
      });
  for (const route of routes.filter((e) => e.path.includes("/admin/")))
    assert.equal(route.access, "owner");
  const settings = await run("GET", "/subscriptions/admin/settings");
  await run("PUT", "/subscriptions/admin/settings", {
    version: settings.version,
    values: { ...settings.values, paymentRequired: true },
  });
  await run("POST", "/subscriptions/change", {
    planId: "starter",
    requestId: "select",
  });
  assert.equal((await run("GET", "/subscriptions/me")).status, "active");
  assert.ok(await run("GET", "/subscriptions/billing"));
  await run("POST", "/subscriptions/payment/setup", { requestId: "setup" });
  await run("POST", "/subscriptions/payment/save", { setupId: "setup_local" });
  await assert.rejects(
    run("PUT", "/subscriptions/preferences", { notifications: "yes" }),
    { status: 400 },
  );
  await run("PUT", "/subscriptions/preferences", { notifications: false });
  assert.equal(
    (await store.get("SUB_ACCOUNTS", actor.id)).data.notifications,
    false,
  );
  await run("POST", "/subscriptions/sync");
  assert.equal(
    (await run("GET", "/subscriptions/admin/accounts")).items.length,
    1,
  );
  const detail = await run("GET", "/subscriptions/admin/accounts/:id");
  assert.equal(detail.account.email, actor.email);
  await run("POST", "/subscriptions/admin/accounts/:id/simulate", {
    status: "past_due",
  });
  await run("POST", "/subscriptions/admin/accounts/:id/simulate", {
    status: "active",
  });
  await run("POST", "/subscriptions/admin/accounts/:id/reset", {
    scope: "day",
    reason: "Test",
    requestId: "reset",
  });
  await run("POST", "/subscriptions/cancel", { requestId: "cancel" });
  assert.ok(await run("POST", "/subscriptions/admin/maintenance"));
  assert.ok(
    await run("GET", "/subscriptions/admin/plans/:id/history", {}, "starter"),
  );
  await assert.rejects(run("POST", "/subscriptions/webhook"), /webhook/);
});
