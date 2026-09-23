import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '@gsalgadotoledo/rt-app-core';
import { RTAppIdempotencyModule } from '../dist/index.js';

test('core has no dependency on idempotency capabilities', () => {
  assert.equal('RTAppIdempotencyModule' in core, false);
  assert.equal('executeIdempotent' in core.RTAppBaseModule.prototype, false);
});

test('a regular module can use the executor by composition through bindings', async () => {
  // Test-only store; production requires a durable atomic adapter.
  class Store {
    record;
    init() {}
    async claim(c) {
      if (!this.record) { this.record = {...c,state:'pending'}; return {state:'acquired'}; }
      return this.record.fingerprint === c.fingerprint ? this.record : {state:'conflict'};
    }
    async complete(c,result) { this.record = {...c,state:'completed',result}; }
    async markUncertain() { this.record.state='uncertain'; }
  }
  class Orders extends core.RTAppBaseModule {
    idempotency = undefined;
    calls = 0;
    init() {}
    submit() {
      return this.idempotency.execute({scope:'app:user:submit:v1',key:'order-1',input:{amount:10}},async () => {
        this.calls++;
        return {id:'receipt-1'};
      });
    }
  }
  const app=core.createRTApp({store:{module:Store},idempotency:{module:RTAppIdempotencyModule,bindings:{store:'store'}},orders:{module:Orders,bindings:{idempotency:'idempotency'}}});
  await app().loadAll();
  assert.deepEqual(await app('orders').submit(),{id:'receipt-1'});
  assert.deepEqual(await app('orders').submit(),{id:'receipt-1'});
  assert.equal(app('orders').calls,1);
  await app().dispose();
});
