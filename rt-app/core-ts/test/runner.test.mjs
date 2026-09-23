import test from 'node:test';
import assert from 'node:assert/strict';
import { createRTApp } from '../dist/index.js';

test('dependencies initialize before consumers, regardless of registration order', async () => {
  const calls = [];
  class Consumer { init() { assert.equal(this.__rtApp('dependency').ready, true); calls.push('consumer'); } }
  class Dependency { ready = false; async init() { this.ready = true; calls.push('dependency'); } }
  const rtApp = createRTApp({ consumer: { module: Consumer, dependsOn: ['dependency'] }, dependency: { module: Dependency } });
  await rtApp().loadAll();
  assert.deepEqual(calls, ['dependency', 'consumer']);
});

test('concurrent preload/load keeps one instance and initializes once', async () => {
  let created = 0, initialized = 0;
  class Module { constructor() { created++; } async init() { await new Promise(resolve => setTimeout(resolve, 5)); initialized++; } }
  const rtApp = createRTApp({ example: { module: Module, preload: true } });
  await Promise.all([rtApp().preloadAll(), rtApp().loadAll(), rtApp().preloadAll(), rtApp().loadAll()]);
  assert.equal(created, 1); assert.equal(initialized, 1);
});

test('preload includes transitive dependencies', async () => {
  const calls = [];
  class A { init() { calls.push('a'); } }
  class B { init() { calls.push('b'); } }
  class C { init() { calls.push('c'); } }
  const rtApp = createRTApp({ a: { module: A, preload: true, dependsOn: ['b'] }, b: { module: B, dependsOn: ['c'] }, c: { module: C } });
  await rtApp().preloadAll(); await rtApp().loadAll();
  assert.deepEqual(calls, ['c', 'b', 'a']);
});

for (const [label, config, message] of [
  ['cycle', { a: ['b'], b: ['a'] }, /a -> b -> a/],
  ['missing dependency', { a: ['missing'] }, /a -> missing/],
]) test(`rejects ${label} before constructors run`, async () => {
  let constructed = 0;
  class Module { constructor() { constructed++; } init() {} }
  const rtApp = createRTApp(Object.fromEntries(Object.entries(config).map(([name, dependsOn]) => [name, { module: Module, dependsOn }])));
  await assert.rejects(rtApp().loadAll(), message); assert.equal(constructed, 0);
});

test('failed initialization is not silently retried', async () => {
  let calls = 0;
  class Module { init() { calls++; throw new Error('unavailable'); } }
  const rtApp = createRTApp({ module: { module: Module } });
  await assert.rejects(rtApp().loadAll(), /unavailable/);
  await assert.rejects(rtApp().loadAll(), /unavailable/);
  assert.equal(calls, 1);
  assert.throws(() => rtApp().setModule('other', { module: Module }), /Cannot change/);
});

test('runner instances and configuration remain isolated', async () => {
  class Module { greeting = 'default'; init() {} }
  const a = createRTApp({ hello: { module: Module, greeting: 'Hola' } });
  const b = createRTApp({ hello: { module: Module } });
  assert.throws(() => a('hello'), /not loaded/);
  await Promise.all([a().loadAll(), b().loadAll()]);
  assert.equal(a('hello').greeting, 'Hola'); assert.equal(b('hello').greeting, 'default');
  assert.notEqual(a('hello'), b('hello'));
});

test('bindings inject the root singleton and imply dependencies', async () => {
  class Email { ready = false; init() { this.ready = true; } }
  class Users { email = undefined; init() { assert.equal(this.email.ready, true); } }
  const rtApp = createRTApp({ users: { module: Users, bindings: { email: 'email' } }, email: { module: Email } });
  await rtApp().loadAll();
  assert.equal(rtApp('users').email, rtApp('email'));
});

test('invalid binding fields fail instead of silently discarding configuration', async () => {
  class Email { init() {} }
  class Users { email = undefined; init() {} }
  const rtApp = createRTApp({ users: { module: Users, bindings: { emial: 'email' } }, email: { module: Email } });
  await assert.rejects(rtApp().loadAll(), /Invalid binding field users.emial/);
});

test('shared language-neutral conformance vectors', async () => {
  const { readFileSync } = await import('node:fs');
  const vectors = JSON.parse(readFileSync(new URL('../../spec/conformance/runtime.json', import.meta.url), 'utf8'));
  for (const vector of vectors) {
    const calls = [];
    const rtApp = createRTApp(Object.fromEntries(Object.entries(vector.modules).map(([name, config]) => [name, {
      ...config, module: class { init() { calls.push(name); } },
    }])));
    if (vector.error) {
      await assert.rejects(rtApp().loadAll(), new RegExp(vector.error));
      assert.deepEqual(calls, []);
    } else {
      await rtApp().loadAll(); assert.deepEqual(calls, vector.order);
    }
  }
});

test('dispose waits for startup, closes in reverse dependency order and is idempotent', async () => {
  const calls = [];
  class Provider { async init() { await new Promise(resolve => setImmediate(resolve)); calls.push('init'); } dispose() { calls.push('provider'); } }
  class Consumer { init() {} dispose() { calls.push('consumer'); } }
  const rtApp = createRTApp({ consumer: { module: Consumer, dependsOn: ['provider'] }, provider: { module: Provider } });
  const starting = rtApp().loadAll(), closing = rtApp().dispose();
  await Promise.all([starting, closing, rtApp().dispose()]);
  assert.deepEqual(calls, ['init', 'consumer', 'provider']);
  await assert.rejects(rtApp().loadAll(), /closing/); assert.throws(() => rtApp('provider'), /disposed/);
});
test('partial startup and disposal failures still close other constructed modules', async () => {
  const closed = [];
  class A { init() {} dispose() { closed.push('a'); } }
  class B { init() { throw new Error('startup'); } dispose() { closed.push('b'); throw new Error('close'); } }
  const rtApp = createRTApp({ a: { module: A }, b: { module: B, dependsOn: ['a'] } });
  await assert.rejects(rtApp().loadAll(), /startup/);
  await assert.rejects(rtApp().dispose(), AggregateError); assert.deepEqual(closed, ['b', 'a']);
});

test('JavaScript providers must implement the runtime init contract', async () => {
  const rtApp = createRTApp({ invalid: { module: class {} } });
  await assert.rejects(rtApp().loadAll(), /must implement init/);
});
