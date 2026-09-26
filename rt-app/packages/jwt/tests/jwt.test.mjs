import test from "node:test";
import assert from "node:assert/strict";
import { SignJWT } from "jose";
import { JwtTokens } from "../dist/index.js";

const secret = "test-only-secret-".repeat(3);

test("sessions round-trip identity/version and reject different keys and audiences", async () => {
  const tokens = new JwtTokens(secret);
  const token = await tokens.issue({ id: "alice", tokenVersion: 3 });
  assert.deepEqual(await tokens.verify(token), { id: "alice", version: 3 });
  for (const verifier of [
    new JwtTokens("other-secret".repeat(4)),
    new JwtTokens(secret, "other"),
    new JwtTokens(secret, "rt-app", "other"),
  ]) {
    await assert.rejects(verifier.verify(token), { status: 401 });
  }
  await assert.rejects(tokens.verify("not.a.jwt"), { status: 401 });
  assert.throws(() => new JwtTokens("short"), /32 bytes/);
});

test("reject expired, incomplete and malformed claims without leaking verification details", async () => {
  const tokens = new JwtTokens(secret);
  const now = Math.floor(Date.now() / 1000);
  for (const claims of [
    { sub: "alice", v: 1, exp: now - 1, iat: now - 20 },
    { sub: "alice", v: 1, iat: now },
    { sub: "", v: 1, exp: now + 60, iat: now },
    { sub: "alice", v: "1", exp: now + 60, iat: now },
  ]) {
    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("rt-app")
      .setAudience("rt-app-api")
      .sign(new TextEncoder().encode(secret));
    await assert.rejects(tokens.verify(token), {
      status: 401,
      message: "Invalid or expired session",
    });
  }
});

test("an injected clock makes tokens deterministic and controls expiry", async () => {
  let now = Date.parse("2026-01-02T03:04:05.000Z");
  const tokens = new JwtTokens(secret, undefined, undefined, { now: () => now });
  const token = await tokens.issue({ id: "alice", tokenVersion: 1 });
  const fromDate = new JwtTokens(secret, undefined, undefined, { now: () => new Date("2026-01-02T03:04:05.999Z") });
  assert.equal(await fromDate.issue({ id: "alice", tokenVersion: 1 }), token);
  const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
  assert.deepEqual(payload, { v: 1, sub: "alice", iss: "rt-app", aud: "rt-app-api", iat: 1767323045, exp: 1767323945 });
  now += 899_999;
  assert.deepEqual(await tokens.verify(token), { id: "alice", version: 1 });
  now += 1;
  await assert.rejects(tokens.verify(token), { status: 401, message: "Invalid or expired session" });
});
