import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "@gsalgadotoledo/rt-app-dynamodb";
import { LocalMailbox } from "@gsalgadotoledo/rt-app-auth";
import { createApplication, seedDemo } from "@gsalgadotoledo/rt-app-framework";
import { JwtTokens } from "@gsalgadotoledo/rt-app-jwt";
const password = "Demo-password-only-2026!";
async function setup(tasks = true) {
  const store = new MemoryStore(),
    mail = new LocalMailbox(),
    secret = "test-secret-".repeat(5);
  const app = createApplication({ store, mailer: mail, secret, tasks });
  await app.migrate();
  await seedDemo(app, password);
  let ip = 0;
  const call = (method, path, body = {}, token = "", query = {}) =>
    app.handle({
      method,
      path,
      body,
      query,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      ip: `test-${++ip}`,
    });
  const login = async (email) => {
    const r = await call("POST", "/auth/login", { email, password });
    assert.equal(r.status, 200);
    return r.body;
  };
  return { app, store, mail, call, login, secret };
}
test("public home, deny by default and owner-only profile", async () => {
  const { call, login } = await setup();
  assert.equal((await call("GET", "/")).status, 200);
  assert.equal((await call("GET", "/users")).status, 401);
  const ana = await login("ana@example.test");
  assert.equal((await call("GET", "/users", {}, ana.token)).status, 403);
  assert.equal(
    (await call("GET", "/users/me", {}, ana.token)).body.email,
    "ana@example.test",
  );
  assert.equal(
    (await call("PATCH", "/users/me", { name: "Ana nueva" }, ana.token)).status,
    200,
  );
  assert.equal(
    (await call("PATCH", "/users/me", { role: "owner" }, ana.token)).status,
    400,
  );
  assert.equal((await call("GET", "/unknown", {}, ana.token)).status, 404);
});
test("JWT signature and token versions are checked; hashes never returned", async () => {
  const { call, login, secret } = await setup();
  const owner = await login("owner@example.test");
  const result = await call("GET", "/users", {}, owner.token);
  assert.equal(result.body.items.length, 3);
  assert.doesNotMatch(
    JSON.stringify(result.body),
    /passwordHash|scrypt|tokenVersion/,
  );
  const forged = await new JwtTokens("wrong-secret".repeat(4)).issue({
    id: owner.user.id,
    tokenVersion: 1,
  });
  assert.equal((await call("GET", "/users/me", {}, forged)).status, 401);
  await call("POST", "/auth/logout", {}, owner.token);
  assert.equal((await call("GET", "/users/me", {}, owner.token)).status, 401);
});
test("ACL grants expose only allowed menus and cannot delegate ownership", async () => {
  const { call, login } = await setup();
  const owner = await login("owner@example.test"),
    ana = await login("ana@example.test");
  let r = await call(
    "PUT",
    `/acl/users/${ana.user.id}`,
    { role: "admin", grants: ["users.list", "acl.assign"] },
    owner.token,
  );
  assert.equal(r.status, 200);
  assert.equal((await call("GET", "/users", {}, ana.token)).status, 401);
  const updated = await login("ana@example.test");
  assert.equal((await call("GET", "/users", {}, updated.token)).status, 200);
  assert.equal((await call("GET", "/admin/modules", {}, updated.token)).status, 401);
  assert.equal(
    (
      await call(
        "PUT",
        `/acl/users/${owner.user.id}`,
        { role: "admin", grants: [] },
        updated.token,
      )
    ).status,
    403,
  );
});
test("tasks enforce ownership and can be removed from application", async () => {
  const { call, login } = await setup();
  const ana = await login("ana@example.test"),
    leo = await login("leo@example.test");
  const task = (
    await call("POST", "/tasks", { title: "Primera tarea" }, ana.token)
  ).body;
  assert.equal(
    (await call("PATCH", `/tasks/${task.id}`, { done: true }, leo.token))
      .status,
    403,
  );
  assert.ok(
    (await call("GET", "/tasks", {}, leo.token)).body.items.every(
      (t) => t.ownerId === leo.user.id,
    ),
  );
  assert.equal(
    (await call("PATCH", `/tasks/${task.id}`, { done: true }, ana.token)).body
      .done,
    true,
  );
  assert.equal(
    (await call("DELETE", `/tasks/${task.id}`, {}, ana.token)).status,
    200,
  );
  const without = await setup(false);
  assert.equal((await without.call("GET", "/tasks")).status, 404);
});
test("email codes are single use, purpose-bound and expire", async () => {
  const { call, mail, store } = await setup();
  await call("POST", "/auth/code", { email: "ana@example.test" });
  const code = mail.messages[0].code;
  assert.equal(
    (
      await call("POST", "/auth/reset-password", {
        email: "ana@example.test",
        code,
        password,
      })
    ).status,
    400,
  );
  const results = await Promise.all(
    [1, 2].map(() =>
      call("POST", "/auth/code/verify", { email: "ana@example.test", code }),
    ),
  );
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(
    (
      await call("POST", "/auth/code/verify", {
        email: "ana@example.test",
        code,
      })
    ).status,
    400,
  );
  await call("POST", "/auth/code", { email: "leo@example.test" });
  const rows = await store.list("CHALLENGE");
  const row = rows.items.find((r) => !r.data.used);
  await store.transact([
    {
      row: {
        ...row,
        version: row.version + 1,
        data: { ...row.data, expires: 0 },
      },
      expected: row.version,
    },
  ]);
  assert.equal(
    (
      await call("POST", "/auth/code/verify", {
        email: "leo@example.test",
        code: mail.messages[0].code,
      })
    ).status,
    400,
  );
});
test("password reset revokes existing sessions and has generic account responses", async () => {
  const { call, mail, login } = await setup();
  const ana = await login("ana@example.test");
  const a = await call("POST", "/auth/forgot-password", {
      email: "ana@example.test",
    }),
    b = await call("POST", "/auth/forgot-password", {
      email: "missing@example.test",
    });
  assert.deepEqual(a, b);
  const code = mail.messages[0].code;
  const newPassword = "A-new-password-2026!";
  assert.equal(
    (
      await call("POST", "/auth/reset-password", {
        email: "ana@example.test",
        code,
        password: newPassword,
      })
    ).status,
    200,
  );
  assert.equal((await call("GET", "/users/me", {}, ana.token)).status, 401);
  assert.equal(
    (await call("POST", "/auth/login", { email: "ana@example.test", password }))
      .status,
    401,
  );
  assert.equal(
    (
      await call("POST", "/auth/login", {
        email: "ana@example.test",
        password: newPassword,
      })
    ).status,
    200,
  );
});
test("rate limits, unique email transactions, filters and repeatable migrations", async () => {
  const { app, store, call, login } = await setup();
  await app.migrate();
  assert.equal((await store.list("MIGRATIONS")).items.length, 7);
  const races = await Promise.allSettled(
    [1, 2].map(() =>
      app.users.create({ name: "New", email: "unique@example.test", password }),
    ),
  );
  assert.equal(races.filter((r) => r.status === "fulfilled").length, 1);
  const owner = await login("owner@example.test");
  const result = await call("GET", "/users", {}, owner.token, {
    email: "ana@",
  });
  assert.equal(result.body.items.length, 1);
  assert.equal(
    (await call("GET", "/users", {}, owner.token, { passwordHash: "x" }))
      .status,
    400,
  );
  for (let i = 0; i < 3; i++)
    await call("POST", "/auth/code", { email: "ana@example.test" });
  assert.equal(
    (await call("POST", "/auth/code", { email: "ana@example.test" })).status,
    429,
  );
});
test("verified email change atomically updates unique index and revokes previous token", async () => {
  const { call, mail, login, app } = await setup();
  const ana = await login("ana@example.test");
  assert.equal(
    (
      await call(
        "POST",
        "/auth/email-change",
        { email: "leo@example.test" },
        ana.token,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await call(
        "POST",
        "/auth/email-change",
        { email: "new-ana@example.test" },
        ana.token,
      )
    ).status,
    200,
  );
  const result = await call(
    "POST",
    "/auth/email-change/verify",
    { code: mail.messages[0].code },
    ana.token,
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.user.email, "new-ana@example.test");
  assert.equal(await app.users.byEmail("ana@example.test"), undefined);
  assert.equal((await call("GET", "/users/me", {}, ana.token)).status, 401);
  assert.equal(
    (await call("GET", "/users/me", {}, result.body.token)).status,
    200,
  );
});
test("incorrect codes exhaust attempt budget and disabled accounts cannot authenticate", async () => {
  const { call, mail, login } = await setup();
  await call("POST", "/auth/code", { email: "ana@example.test" });
  const correct = mail.messages[0].code;
  const wrong = correct === "111111" ? "222222" : "111111";
  for (let i = 0; i < 5; i++)
    assert.equal(
      (
        await call("POST", "/auth/code/verify", {
          email: "ana@example.test",
          code: wrong,
        })
      ).status,
      400,
    );
  assert.equal(
    (
      await call("POST", "/auth/code/verify", {
        email: "ana@example.test",
        code: correct,
      })
    ).status,
    400,
  );
  const owner = await login("owner@example.test"),
    leo = await login("leo@example.test");
  assert.equal(
    (await call("DELETE", `/users/${leo.user.id}`, {}, owner.token)).status,
    200,
  );
  assert.equal((await call("GET", "/users/me", {}, leo.token)).status, 401);
  assert.equal(
    (await call("POST", "/auth/login", { email: "leo@example.test", password }))
      .status,
    401,
  );
  assert.equal(
    (await call("DELETE", `/users/${owner.user.id}`, {}, owner.token)).status,
    403,
  );
});

test('field search traverses empty result pages and preserves pagination',async()=>{const{store,call,login}=await setup();const owner=await login('owner@example.test');for(let i=0;i<61;i++)await store.transact([{row:{pk:'TASKS',sk:`search-${String(i).padStart(3,'0')}`,version:1,data:{id:`search-${i}`,title:i===60?'Encontrar esta tarea':'Otra tarea',ownerId:owner.user.id,done:false}},expected:null}]);const result=await call('GET','/tasks/admin',{},owner.token,{title:'Encontrar'});assert.equal(result.status,200);assert.equal(result.body.items.length,1);assert.equal(result.body.items[0].id,'search-60');});
