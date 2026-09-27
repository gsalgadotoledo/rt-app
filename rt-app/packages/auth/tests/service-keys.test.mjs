import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "@gsalgadotoledo/rt-app-dynamodb";
import { Conflict } from "@gsalgadotoledo/rt-app-contracts";
import {
  ServiceKeys,
  parseServiceKeys,
  serviceKeyHash,
  serviceKeysFromEnv,
  SERVICE_KEY_USE,
  DEFAULT_SERVICE_RATE_LIMIT,
} from "../dist/index.js";

const secret = "service-keys-test-secret-".repeat(3);
const SCOPES = ["subscriptions.meter", "service-keys.self"];
const envSecret = "envsecret-envsecret-envsecret-0123";
const meter = { access: "service", resource: "subscriptions.meter" };

function setup({ keys, store = new MemoryStore(), scopes = SCOPES } = {}) {
  let now = Date.parse("2026-03-01T10:00:00.000Z");
  const service = new ServiceKeys(store, secret, { keys, scopes, now: () => now });
  return { store, service, at: (iso) => (now = Date.parse(iso)) };
}

const rejects = (promise, status, message) =>
  assert.rejects(promise, (e) => e.status === status && e.message === message);

test("configured keys: parsing, defaults and the failure message", () => {
  assert.deepEqual(parseServiceKeys(undefined, SCOPES), []);
  const [key] = parseServiceKeys([{ id: "a", secret: envSecret, scopes: ["subscriptions.meter"] }], SCOPES);
  assert.equal(key.secretHash, serviceKeyHash("rtsk_a." + envSecret));
  assert.equal(key.rateLimit, DEFAULT_SERVICE_RATE_LIMIT);
  assert.equal(key.source, "env");
  for (const bad of [{}, [null], [[]], [{ id: "a", secret: envSecret, scopes: ["subscriptions.meter"], description: null, rateLimit: null }, 1]])
    assert.throws(() => parseServiceKeys(bad, SCOPES), { message: "Invalid service key configuration" });
});

test("configured keys come from RT_APP_SERVICE_KEYS or a secrets file", async (t) => {
  assert.equal(serviceKeysFromEnv({}), undefined);
  assert.equal(serviceKeysFromEnv({ RT_APP_SERVICE_KEYS: "  " }), undefined);
  assert.deepEqual(serviceKeysFromEnv({ RT_APP_SERVICE_KEYS: '[{"id":"a"}]' }), [{ id: "a" }]);
  assert.throws(() => serviceKeysFromEnv({ RT_APP_SERVICE_KEYS: "[{" }), { message: "Invalid service key configuration" });
  const dir = await mkdtemp(join(tmpdir(), "rta-service-keys-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "keys.json");
  await writeFile(file, JSON.stringify([{ id: "file-key", secret: envSecret, scopes: ["subscriptions.meter"] }]));
  assert.deepEqual(serviceKeysFromEnv({ RT_APP_SERVICE_KEYS_FILE: file }), [{ id: "file-key", secret: envSecret, scopes: ["subscriptions.meter"] }]);
  // The inline value wins over the file.
  assert.deepEqual(serviceKeysFromEnv({ RT_APP_SERVICE_KEYS: "[]", RT_APP_SERVICE_KEYS_FILE: file }), []);
  // Scopes may be a function evaluated when the keys are first validated.
  const late = new ServiceKeys(new MemoryStore(), secret, { keys: serviceKeysFromEnv({ RT_APP_SERVICE_KEYS_FILE: file }), scopes: () => ["subscriptions.meter"] });
  assert.deepEqual(late.validate(), ["file-key"]);
});

test("an invalid configuration fails on first use", async () => {
  const { service } = setup({ keys: [{ id: "a", secret: "short", scopes: ["subscriptions.meter"] }] });
  assert.throws(() => service.validate(), { message: "Invalid service key configuration" });
  await rejects(service.actor("Bearer rtsk_a." + envSecret), 400, "Invalid service key configuration");
});

test("the full lifecycle: create, use, rotate, revoke; secrets are never listed", async () => {
  const { service, store, at } = setup();
  const created = await service.create({ description: "Agent", scopes: ["subscriptions.meter"] }, "root");
  assert.match(created.token, /^rtsk_[A-Za-z0-9_-]{12}\.[A-Za-z0-9_-]{43}$/);
  const id = created.key.id;
  const actor = await service.actor("Bearer " + created.token);
  assert.equal(actor.id, "service:" + id);
  service.check(meter, actor);
  const listed = JSON.stringify(await service.list());
  assert.ok(!listed.includes(created.token.split(".")[1]) && !listed.includes("secretHash"));
  at("2026-03-01T10:05:00.000Z");
  const rotated = await service.rotate(id, "root");
  await rejects(service.actor("Bearer " + created.token), 401, "Invalid service key");
  await service.actor("Bearer " + rotated.token);
  assert.equal((await store.get(SERVICE_KEY_USE, id)).data.lastUsedAt, Date.parse("2026-03-01T10:05:00.000Z"));
  await service.revoke(id, "root");
  await rejects(service.actor("Bearer " + rotated.token), 401, "Invalid service key");
});

test("a lost race on the last-use row never fails the request", async () => {
  const store = new MemoryStore();
  const { service } = setup({ store, keys: [{ id: "a", secret: envSecret, scopes: ["subscriptions.meter"] }] });
  const transact = store.transact.bind(store);
  store.transact = async (writes) => {
    if (writes.some((w) => w.row.pk === SERVICE_KEY_USE)) throw new Conflict();
    return transact(writes);
  };
  assert.equal((await service.actor("Bearer rtsk_a." + envSecret)).id, "service:a");
  store.transact = async () => {
    throw new Error("store down");
  };
  await assert.rejects(service.actor("Bearer rtsk_a." + envSecret), /store down/);
});

test("creating a key whose id another process took at the same time is a 409", async () => {
  const store = new MemoryStore();
  const { service } = setup({ store });
  const get = store.get.bind(store);
  store.get = async (pk, sk) => (pk === "SERVICE_KEYS" ? undefined : get(pk, sk));
  await service.create({ id: "dup", description: "One", scopes: ["subscriptions.meter"] }, "root");
  await rejects(service.create({ id: "dup", description: "Two", scopes: ["subscriptions.meter"] }, "root"), 409, "Service key id already used");
  const transact = store.transact.bind(store);
  store.transact = async () => {
    throw new Error("store down");
  };
  await assert.rejects(service.create({ id: "other", description: "Three", scopes: ["subscriptions.meter"] }, "root"), /store down/);
  store.transact = transact;
});

test("admin endpoints pass only the documented fields and the actor", async () => {
  const { service } = setup();
  const feature = service.feature();
  const endpoint = (method, path) => feature.endpoints.find((e) => e.method === method && e.path === path);
  const root = { id: "rt-app-root", role: "owner", grants: [] };
  const created = await endpoint("POST", "/service-keys").handle({
    request: { body: { id: "agent", description: "Agent", scopes: ["subscriptions.meter", "service-keys.self"], rateLimit: 5, secretHash: "0".repeat(64) } },
    params: {},
    actor: root,
  });
  assert.equal(created.key.createdBy, "rt-app-root");
  assert.notEqual(created.token.split(".")[1], "0".repeat(64));
  const self = await endpoint("GET", "/service/keys/self").handle({ request: { body: {} }, params: {}, actor: await service.actor("Bearer " + created.token) });
  assert.deepEqual(self, { id: "agent", description: "Agent", scopes: ["subscriptions.meter", "service-keys.self"], rateLimit: 5 });
  const rotated = await endpoint("POST", "/service-keys/:id/rotate").handle({ request: { body: {} }, params: { id: "agent" }, actor: root });
  assert.equal(rotated.key.rotatedAt, Date.parse("2026-03-01T10:00:00.000Z"));
  const revoked = await endpoint("POST", "/service-keys/:id/revoke").handle({ request: { body: {} }, params: { id: "agent" }, actor: root });
  assert.equal(revoked.key.active, false);
  assert.equal((await endpoint("GET", "/service-keys").handle({ request: { body: {} }, params: {} })).items.length, 1);
  // A key removed while its token was in flight answers with neither description nor limit.
  const ghost = await endpoint("GET", "/service/keys/self").handle({ request: { body: {} }, params: {}, actor: { id: "service:ghost", grants: [] } });
  assert.deepEqual(ghost, { id: "ghost", description: "", scopes: [], rateLimit: null });
});
