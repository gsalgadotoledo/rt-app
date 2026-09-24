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
