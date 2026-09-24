import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, SignJWT } from "jose";
import { JwtTokens } from "@gsalgadotoledo/rt-app-jwt";
import {
  createMicroservice,
  SessionAuthenticator,
  SignedJwtAuthenticator,
  remoteJwtAuthenticator,
  remoteFeature,
} from "../dist/index.js";
const actor = {
  id: "u",
  role: "user",
  grants: ["x.read"],
  active: true,
  tokenVersion: 1,
};
const request = (
  path = "/x/42",
  authorization = "Bearer good",
  method = "GET",
) => ({
  path,
  method,
  headers: { authorization, "x-user-id": "evil" },
  query: {},
  body: {},
  ip: "127.0.0.1",
});
const feature = {
  id: "x",
  migrations: [],
  endpoints: [
    {
      method: "GET",
      path: "/x/:id",
      resource: "x.read",
      access: "permission",
      handle: async (c) => ({
        id: c.params.id,
        actor: c.actor.id,
        requestId: c.request.headers["x-request-id"],
      }),
    },
  ],
};
test("service hosts existing Feature with ACL, generated correlation and sanitized errors", async () => {
  let current = actor;
  const metrics = [];
  const service = createMicroservice({
    features: [feature],
    authenticate: { authenticate: async () => current },
    observe: async (m) => {
      metrics.push(m);
    },
  });
  const result = await service.handle(request());
  assert.equal(result.status, 200);
  assert.equal(result.body.actor, "u");
  assert.equal(result.body.requestId, result.headers["x-request-id"]);
  assert.equal((await service.handle(request("/no"))).status, 404);
  assert.equal((await service.handle(request("/x/%E0"))).status, 400);
  assert.equal((await service.handle(request("/x/1", undefined))).status, 200);
  const no = request();
  delete no.headers.authorization;
  assert.equal((await service.handle(no)).status, 401);
  assert.equal(
    (await service.handle(request("/x/1", "Basic bad"))).status,
    401,
  );
  current = { ...actor, grants: [] };
  assert.equal((await service.handle(request())).status, 403);
  current = { ...actor, role: "owner" };
  assert.equal((await service.handle(request())).status, 200);
  assert.equal(metrics.at(-1).route, "/x/:id");
  assert.throws(() =>
    createMicroservice({ features: [feature, feature], authenticate: {} }),
  );
});
test("guest/owner/explicit grants, subscription gate and telemetry errors", async () => {
  const run = async (endpoint, current = actor, extra = {}) =>
    createMicroservice({
      features: [
        { ...feature, endpoints: [{ ...feature.endpoints[0], ...endpoint }] },
      ],
      authenticate: { authenticate: async () => current },
      ...extra,
    }).handle(request());
  assert.equal((await run({ access: "owner" })).status, 403);
  assert.equal(
    (await run({ access: "owner" }, { ...actor, role: "owner" })).status,
    200,
  );
  assert.equal(
    (
      await run(
        { explicitGrant: true },
        { ...actor, role: "owner", grants: [] },
      )
    ).status,
    403,
  );
  assert.equal((await run({ access: "authenticated" })).status, 200);
  assert.equal((await run({}, { ...actor, active: false })).status, 401);
  assert.equal(
    (
      await run(
        { access: "guest", handle: async () => ({ public: true }) },
        undefined,
        {
          observe: async () => {
            throw Error();
          },
        },
      )
    ).status,
    200,
  );
  assert.equal(
    (await run({ subscription: { product: "x", credits: 1 } })).status,
    503,
  );
  assert.equal(
    (
      await run({ subscription: { product: "x", credits: 1 } }, actor, {
        invokeMetered: async (e, a, work) => work(),
      })
    ).status,
    200,
  );
  const fail = await run({
    handle: async () => {
      throw Error("secret");
    },
  });
  assert.equal(fail.status, 500);
  assert.equal(fail.body.error, "Internal error");
});
test("JWT signature, issuer, audience, active actor and revocation", async () => {
  const tokens = new JwtTokens("s".repeat(32));
  const token = await tokens.issue(actor);
  assert.equal(
    (
      await new SessionAuthenticator(tokens, async () => actor).authenticate(
        token,
      )
    ).id,
    "u",
  );
  for (const value of [
    undefined,
    { ...actor, tokenVersion: 2 },
    { ...actor, active: false },
    { ...actor, id: "other" },
  ])
    await assert.rejects(
      new SessionAuthenticator(tokens, async () => value).authenticate(token),
    );
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const sign = (aud) =>
    new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setSubject("u")
      .setIssuer("issuer")
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
  const auth = new SignedJwtAuthenticator(
    publicKey,
    "issuer",
    "service",
    async () => actor,
  );
  assert.equal((await auth.authenticate(await sign("service"))).id, "u");
  await assert.rejects(auth.authenticate(await sign("other")));
  await assert.rejects(
    new SignedJwtAuthenticator(
      publicKey,
      "issuer",
      "service",
      async () => undefined,
    ).authenticate(await sign("service")),
  );
  assert.throws(
    () =>
      new SignedJwtAuthenticator(publicKey, "", "service", async () => actor),
  );
  assert.throws(() =>
    remoteJwtAuthenticator("http://bad", "i", "a", async () => actor),
  );
  assert.ok(
    remoteJwtAuthenticator(
      "https://example.test/jwks",
      "i",
      "a",
      async () => actor,
    ),
  );
});
test("remote feature encodes parameters and forwards only authorization", async () => {
  const f = remoteFeature(
    feature,
    "https://example.test/api",
    async (url, options) => {
      assert.equal(url.pathname, "/api/x/a%2Fb");
      assert.equal(options.headers["x-user-id"], undefined);
      assert.equal(options.headers.authorization, "Bearer token");
      assert.equal(options.body, undefined);
      return Response.json({ ok: true });
    },
  );
  assert.deepEqual(
    await f.endpoints[0].handle({
      params: { id: "a/b" },
      request: {
        ...request(),
        headers: { authorization: "Bearer token", "x-user-id": "evil" },
      },
    }),
    { ok: true },
  );
  assert.deepEqual(f.migrations, []);
  const post = {
    ...feature,
    endpoints: [{ ...feature.endpoints[0], method: "POST" }],
  };
  const c = {
    params: { id: "1" },
    request: { ...request(), headers: {}, body: { a: 1 } },
  };
  assert.equal(
    await remoteFeature(post, "https://example.test", async (u, o) => {
      assert.equal(o.body, '{"a":1}');
      return new Response(null, { status: 204 });
    }).endpoints[0].handle(c),
    null,
  );
  await assert.rejects(
    remoteFeature(
      feature,
      "https://example.test",
      async () => new Response("secret", { status: 503 }),
    ).endpoints[0].handle(c),
    /Remote service/,
  );
  assert.throws(() => remoteFeature(feature, "http://example.test"));
  assert.ok(remoteFeature(feature, "https://example.test"));
});
