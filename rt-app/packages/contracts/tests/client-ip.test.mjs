import test from "node:test";
import assert from "node:assert/strict";
import { clientIp } from "../dist/index.js";

test("X-Forwarded-For is trusted only from a local proxy, and only its last entry", () => {
  assert.equal(clientIp("127.0.0.1", "203.0.113.9"), "203.0.113.9");
  assert.equal(clientIp("::1", "10.0.0.1, 203.0.113.9"), "203.0.113.9", "leading entries may be forged by the client");
  assert.equal(clientIp("::ffff:127.0.0.1", ["1.1.1.1", "2001:db8::1"]), "2001:db8::1");
  assert.equal(clientIp("198.51.100.4", "203.0.113.9"), "198.51.100.4", "remote callers cannot choose their address");
  assert.equal(clientIp("127.0.0.1", "not an ip"), "127.0.0.1");
  assert.equal(clientIp("127.0.0.1", " , "), "127.0.0.1");
  assert.equal(clientIp("127.0.0.1"), "127.0.0.1");
  assert.equal(clientIp(undefined), "unknown");
});
