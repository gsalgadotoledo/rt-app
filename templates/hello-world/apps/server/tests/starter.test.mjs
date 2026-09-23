import test from "node:test";
import assert from "node:assert/strict";
import {MemoryStore} from "@gsalgadotoledo/rt-app-dynamodb";
import {LocalMailbox} from "@gsalgadotoledo/rt-app-auth";
test('starter enables Users/Auth and Home without the optional Tasks example', async () => {
  const {createApplication: starter} = await import('../../../main.js');
  const app = starter({store:new MemoryStore(),mailer:new LocalMailbox(),secret:'starter-test-secret-'.repeat(3)});
  await app.migrate();
  assert.deepEqual(app.features.map(f=>f.id).sort(),['acl','auth','aws-monitor','content','infra','observer','subscriptions','users']);
  const request = path => app.handle({method:'GET',path,query:{},body:{},headers:{},ip:'127.0.0.1'});
  assert.equal((await request('/')).status,200);
  assert.equal((await request('/tasks')).status,404);
});
