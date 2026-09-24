import test from "node:test";
import assert from "node:assert/strict";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { passwordVerifier } from "@gsalgadotoledo/rt-app-myadmin/backend";
import { MemoryStore } from "@gsalgadotoledo/rt-app-dynamodb";
import { LocalMailbox } from "@gsalgadotoledo/rt-app-auth";
import {
  createApplication,
  createProductionApplication,
  loadProductionApplication,
} from "../dist/index.js";

test("production secret loading validates missing values and reuses initialized environment without AWS calls", async (t) => {
  const keys = [
    "TABLE_NAME",
    "MAIL_FROM",
    "JWT_SECRET",
    "JWT_SECRET_ARN",
    "ADMIN_PASSWORD_VERIFIER",
    "ADMIN_PASSWORD_SECRET_ARN",
    "STRIPE_SECRET_ARN",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_PUBLISHABLE_KEY",
    "AUTH_PROVIDER",
    "NOSQL_PROVIDER",
    "INFRA_PROVIDER",
    "RT_APP_SUBSCRIPTIONS_PROVIDER",
  ];
  const original = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  );
  t.after(() => {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });
  for (const key of keys) delete process.env[key];
  let responses = {},
    calls = 0;
  t.mock.method(SecretsManagerClient.prototype, "send", async (command) => {
    calls++;
    return responses[command.input.SecretId] ?? {};
  });
  const verifier = await passwordVerifier("test-only-admin-password");
  const components = { observerOutputs: [] };
  await assert.rejects(
    loadProductionApplication(undefined, [], components),
    /JWT_SECRET_ARN/,
  );
  process.env.JWT_SECRET_ARN = "jwt";
  await assert.rejects(
    loadProductionApplication(undefined, [], components),
    /JWT secret is not initialized/,
  );
  responses.jwt = { SecretString: "test-secret-".repeat(4) };
  await assert.rejects(
    loadProductionApplication(undefined, [], components),
    /ADMIN_PASSWORD_SECRET_ARN/,
  );
  process.env.ADMIN_PASSWORD_SECRET_ARN = "admin";
  await assert.rejects(
    loadProductionApplication(undefined, [], components),
    /Admin password has not been initialized/,
  );
  responses.admin = { SecretString: verifier };
  await assert.rejects(
    loadProductionApplication(undefined, [], components),
    /TABLE_NAME/,
  );
  process.env.TABLE_NAME = "test-only-table";
  process.env.MAIL_FROM = "test@example.test";
  process.env.STRIPE_SECRET_ARN = "stripe";
  await assert.rejects(
    loadProductionApplication(undefined, [], components),
    /Stripe secret is incomplete/,
  );
  responses.stripe = {
    SecretString: JSON.stringify({
      secretKey: "sk_test_fake",
      webhookSecret: "whsec_fake",
      publishableKey: "pk_test_fake",
    }),
  };
  const app = await loadProductionApplication(undefined, [], components);
  assert.ok(app.features.some((feature) => feature.id === "users"));
  assert.equal(process.env.STRIPE_SECRET_KEY, "sk_test_fake");
  delete process.env.STRIPE_SECRET_ARN;
  const before = calls;
  await loadProductionApplication(undefined, [], components);
  assert.equal(calls, before);
  process.env.AUTH_PROVIDER = "invalid";
  assert.throws(
    () => createProductionApplication(undefined, [], components),
    /AUTH_PROVIDER/,
  );
});

test("default database probe and admin feature discovery use the composed application", async () => {
  const app = createApplication({
    store: new MemoryStore(),
    mailer: new LocalMailbox(),
    secret: "test-secret-".repeat(4),
    localAdminAccess: true,
    observerOutputs: [],
  });
  const call = (path) =>
    app.handle({
      method: "GET",
      path,
      body: {},
      headers: {},
      query: {},
      ip: "loopback",
    });
  assert.equal((await call("/health/ready")).status, 200);
  assert.equal((await call("/admin/features")).status, 200);
  const catalog = await call("/admin/modules");
  assert.ok(catalog.body.some((item) => item.module === "subscriptions"));
  assert.equal(
    catalog.body.some((item) => item.module === "aws-monitor"),
    false,
  );
});


test("optional choice and queue adapters compose without starting workers", async () => {
  const { MemoryQueue } = await import('@gsalgadotoledo/rt-app-queue');
  const adapter = new MemoryQueue();
  let predictions = 0;
  const app = createApplication({
    store: new MemoryStore(), mailer: new LocalMailbox(),
    secret: "test-secret-".repeat(4), localAdminAccess: true, observerOutputs: [],
    queueAdapter: adapter,
    choiceProvider: { id: 'test', predict: async () => {
      predictions++;
      return { model:'test', semantics:'model-probabilities', probabilities:{yes:0.9,no:0.1} };
    } },
  });
  assert.equal(predictions, 0);
  const decision = await app.choice.decide({context:{},question:'Continue?',options:[{id:'yes'},{id:'no'}]});
  assert.equal(decision.accepted, true);
  await app.queue.send('test', {value:1});
  const deliveries = await adapter.receive(1);
  assert.equal(deliveries.length, 1);
  await deliveries[0].ack();
  const denied = await app.handle({method:'POST',path:'/choice/decide',body:{},headers:{},query:{},ip:'loopback'});
  assert.equal(denied.status, 401);
});


test("queue admin discovers configured queue and rejects unauthenticated public redrive", async () => {
  const { MemoryQueue } = await import('@gsalgadotoledo/rt-app-queue');
  const adapter = new MemoryQueue();
  const app = createApplication({store:new MemoryStore(),mailer:new LocalMailbox(),secret:'test-secret-'.repeat(4),localAdminAccess:true,observerOutputs:[],queueAdapter:adapter});
  await app.queue.send('invoice', {invoiceId:'example'});
  await app.queue.workOnce(async()=>{throw Error('temporary outage');},{maxAttempts:1});
  const request=(path,method='GET',body={})=>app.handle({path,method,body,headers:{},query:{},ip:'loopback'});
  assert.equal((await request('/queue/failed/inspect','POST',{limit:1})).status,401);
  assert.equal((await request('/queue/failed/retry','POST',{token:'invalid'})).status,401);
  const catalog=await request('/admin/modules');assert.ok(catalog.body.some(m=>m.module==='queue'));
  const inspected=await request('/admin/app/queue/failed/inspect','POST',{limit:1});
  assert.equal(inspected.status,200);assert.equal(inspected.body.items.length,1);
  const token=inspected.body.items[0].token;
  assert.equal((await request('/admin/app/queue/failed/retry','POST',{token})).status,200);
  assert.equal((await request('/admin/app/queue/failed/retry','POST',{token})).status,409);
});
