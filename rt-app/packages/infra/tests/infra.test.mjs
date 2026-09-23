import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "@gsalgadotoledo/rt-app-dynamodb";
import { Infra, SimulatedInfraDriver } from "@gsalgadotoledo/rt-app-infra";
const owner = { id: "owner", role: "owner" },
  user = { id: "user", role: "user" };
function setup(driver = new SimulatedInfraDriver()) {
  const store = new MemoryStore();
  return { store, infra: new Infra(store, driver) };
}
test("infra simulation plans and applies once; secrets never enter persistent settings", async () => {
  const { store, infra } = setup();
  const s = await infra.settings();
  assert.equal(s.simulation, true);
  await assert.rejects(
    infra.configure(user, { version: 0, mode: "role", region: "us-east-1" }),
    (e) => e.status === 403,
  );
  await assert.rejects(
    infra.configure(owner, {
      version: 0,
      mode: "keys",
      region: "us-east-1",
      credentials: {
        accessKeyId: "A".repeat(20),
        secretAccessKey: "x".repeat(40),
      },
    }),
    (e) => e.status === 400,
  );
  assert.equal(await store.get("SETTINGS", "infra"), undefined);
  const p = await infra.plan(owner, {
    name: "rt-app-test-queue",
    kind: "queue",
  });
  assert.equal(p.state, "planned");
  assert.equal(p.simulation, true);
  await assert.rejects(
    infra.apply(owner, p.id, "wrong"),
    (e) => e.status === 400,
  );
  const applied = await infra.apply(owner, p.id, p.spec.name);
  assert.equal(applied.state, "applied");
  assert.deepEqual(await infra.apply(owner, p.id, p.spec.name), applied);
  assert.equal((await store.list("INFRA_AUDIT")).items.length, 3);
});
test("immutable plans reject changed config, expired plans and concurrent execution", async () => {
  let calls = 0,
    release,
    started;
  const gate = new Promise((r) => (release = r)),
    entered = new Promise((r) => (started = r));
  const driver = {
    simulation: true,
    saveCredentials: async () => "",
    identity: async () => ({ account: "test", arn: "test:role" }),
    create: async () => {
      calls++;
      started();
      await gate;
      return { id: "one", status: "created" };
    },
  };
  const { infra, store } = setup(driver);
  const stale = await infra.plan(owner, {
    name: "rt-app-stale",
    kind: "table",
  });
  await infra.configure(owner, {
    version: 0,
    mode: "role",
    region: "us-east-2",
  });
  await assert.rejects(
    infra.apply(owner, stale.id, stale.spec.name),
    (e) => e.status === 409,
  );
  const p = await infra.plan(owner, {
    name: "rt-app-concurrent",
    kind: "table",
  });
  const first = infra.apply(owner, p.id, p.spec.name);
  await entered;
  await assert.rejects(
    infra.apply(owner, p.id, p.spec.name),
    (e) => e.status === 409,
  );
  release();
  await first;
  assert.equal(calls, 1);
  const expired = await infra.plan(owner, {
      name: "rt-app-expired",
      kind: "queue",
    }),
    row = await store.get("INFRA_PLANS", expired.id);
  await store.transact([
    {
      row: {
        ...row,
        version: row.version + 1,
        data: { ...row.data, expiresAt: 0 },
      },
      expected: row.version,
    },
  ]);
  await assert.rejects(
    infra.apply(owner, expired.id, expired.spec.name),
    (e) => e.status === 409,
  );
});
test("provider timeout is uncertain and cannot be blindly retried", async () => {
  let calls = 0;
  const { infra } = setup({
    simulation: false,
    saveCredentials: async () => "",
    identity: async () => ({ account: "test", arn: "test:role" }),
    create: async () => {
      calls++;
      throw Error("timeout");
    },
  });
  const p = await infra.plan(owner, { name: "rt-app-timeout", kind: "queue" });
  await assert.rejects(
    infra.apply(owner, p.id, p.spec.name),
    (e) => e.status === 502,
  );
  await assert.rejects(
    infra.apply(owner, p.id, p.spec.name),
    (e) => e.status === 409,
  );
  assert.equal(calls, 1);
});
test("vault receives credentials but API and store only retain immutable version reference", async () => {
  let saved;
  const { infra, store } = setup({
    simulation: false,
    saveCredentials: async (c) => {
      saved = c;
      return "version-1";
    },
    identity: async () => ({ account: "test", arn: "test:role" }),
    create: async () => ({ id: "x", status: "created" }),
  });
  const credentials = {
    accessKeyId: "A".repeat(20),
    secretAccessKey: "secret".repeat(8),
  };
  const result = await infra.configure(owner, {
    version: 0,
    mode: "keys",
    region: "us-east-1",
    credentials,
  });
  assert.deepEqual(saved, credentials);
  assert.equal(result.credentialsConfigured, true);
  assert.doesNotMatch(JSON.stringify(result), /secretAccessKey|accessKeyId/);
  assert.doesNotMatch(
    JSON.stringify(await store.list("SETTINGS")),
    /secretAccessKey|accessKeyId/,
  );
  assert.doesNotMatch(
    JSON.stringify(await store.list("INFRA_AUDIT")),
    /secretAccessKey|accessKeyId/,
  );
  await assert.rejects(
    infra.configure(owner, { version: 0, mode: "role", region: "us-east-1" }),
    (e) => e.status === 409,
  );
});
