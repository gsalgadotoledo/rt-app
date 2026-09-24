import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "@gsalgadotoledo/rt-app-dynamodb";
import { LocalMailbox } from "@gsalgadotoledo/rt-app-auth";
import { createApplication, seedDemo } from "@gsalgadotoledo/rt-app-framework";

const password = "Demo-password-only-2026!";
const create = (options = {}) =>
  createApplication({ store: new MemoryStore(), mailer: new LocalMailbox(), secret: "test-secret-".repeat(5), ...options });

test("application migrations cover every enabled module and are reversible only where declared", async () => {
  const app = create();
  const lines = [];
  const runner = app.migrations({ log: line => lines.push(line) });
  const before = await runner.status();
  assert.ok(before.length >= 7);
  assert.ok(before.every(m => m.state === "pending"));
  assert.ok(["users:001", "auth:001", "acl:001", "tasks:001"].every(id => before.some(m => m.id === id)));
  await app.migrate();
  assert.ok((await runner.status()).every(m => m.state === "applied"));
  assert.equal(lines.length, 0, "migrate() is silent");
  await assert.rejects(runner.down(), /Irreversible/);
});

test("module seeds: users first, then tasks; idempotent and gated by environment", async () => {
  const app = create();
  await app.migrate();
  const seeds = app.seeds({ secrets: { DEMO_PASSWORD: password } });
  assert.deepEqual((await seeds.status()).map(s => [s.id, s.state]), [
    ["users:demo-identities", "pending"],
    ["tasks:welcome", "pending"],
  ]);
  assert.deepEqual(await seeds.run(), ["users:demo-identities", "tasks:welcome"]);
  const owner = await app.users.byEmail("owner@example.test");
  assert.ok(await app.users.store.get("TASKS", "welcome-" + owner.data.id));
  assert.deepEqual(await seeds.run(), []);
  // seedDemo re-runs idempotently and keeps existing accounts.
  assert.deepEqual(await seedDemo(app, "Another-password-2026!"), ["owner@example.test", "ana@example.test", "leo@example.test"]);
  assert.equal((await app.users.byEmail("owner@example.test")).data.id, owner.data.id);
  assert.equal((await app.users.store.list("TASKS")).items.length, 3);
});

test("production never receives demo seeds; unknown environments are rejected", async () => {
  const app = create({ environment: "prod" });
  assert.equal(app.environment, "prod");
  await app.migrate();
  await seedDemo(app, password);
  assert.equal(await app.users.byEmail("owner@example.test"), undefined);
  assert.deepEqual((await app.seeds().status()).map(s => s.state), ["skipped", "skipped"]);
  const previous = process.env.RT_APP_ENVIRONMENT;
  process.env.RT_APP_ENVIRONMENT = "qa";
  try {
    assert.throws(() => create(), /Unknown RT_APP_ENVIRONMENT: qa/);
    process.env.RT_APP_ENVIRONMENT = "stage";
    assert.equal(create().environment, "stage");
  } finally {
    if (previous === undefined) delete process.env.RT_APP_ENVIRONMENT;
    else process.env.RT_APP_ENVIRONMENT = previous;
  }
});

test("seeds of disabled modules do not run", async () => {
  const app = create({ tasks: false });
  await app.migrate();
  assert.deepEqual(await app.seeds({ secrets: { DEMO_PASSWORD: password } }).run(), ["users:demo-identities"]);
  await assert.rejects(app.seeds().run({ modules: ["tasks"] }), /Unknown module: tasks/);
});

test("portable deployments need Postgres, secrets and SMTP from the environment", async () => {
  const { createPortableApplication } = await import("@gsalgadotoledo/rt-app-framework");
  const { passwordVerifier } = await import("@gsalgadotoledo/rt-app-myadmin/backend");
  assert.throws(() => createPortableApplication(undefined, [], {}, { DATABASE_URL: "postgres://u:p@db.example.test/app" }), /requires: JWT_SECRET, ADMIN_PASSWORD_VERIFIER, MAIL_FROM, SMTP_URL/);
  const env = {
    DATABASE_URL: "postgres://u:p@db.example.test/app",
    DATABASE_SSL: "false",
    JWT_SECRET: "j".repeat(64),
    ADMIN_PASSWORD_VERIFIER: await passwordVerifier("Admin-password-2026!"),
    MAIL_FROM: "App <no-reply@example.com>",
    SMTP_URL: "smtps://u:p@smtp.example.com",
    RT_APP_ENVIRONMENT: "stage",
    ENABLE_TASKS: "false",
  };
  const app = createPortableApplication(undefined, [], { observerOutputs: [] }, env);
  assert.equal(app.environment, "stage");
  assert.equal(app.users.store.provider, "postgres");
  assert.equal(app.features.some((f) => f.id === "tasks"), false);
  assert.equal(createPortableApplication(undefined, [], { observerOutputs: [] }, { ...env, RT_APP_ENVIRONMENT: undefined, DATABASE_SSL: undefined }).environment, "prod");
  await app.users.store.close();
});
