import test from "node:test";
import assert from "node:assert/strict";
import { SentryOutput } from "../dist/index.js";

test("Sentry validates DSNs, supports path prefixes and maps warning severity", async () => {
  for (const dsn of [
    "http://key@host.test/1",
    "https://host.test/1",
    "https://key:secret@host.test/1",
    "https://key@host.test/",
    "https://key@host.test/no",
    "https://key@host.test/1?q=1",
    "https://key@host.test/1#x",
  ])
    assert.throws(() => new SentryOutput(dsn), /Invalid/);
  let payload;
  await new SentryOutput(
    "https://key@host.test/prefix/42",
    async (url, options) => {
      assert.equal(String(url), "https://host.test/prefix/api/42/envelope/");
      payload = JSON.parse(options.body.split("\n")[2]);
      return new Response("");
    },
  ).write({
    id: "a-b",
    at: new Date().toISOString(),
    level: "warn",
    source: "app",
    message: "test",
  });
  assert.equal(payload.level, "warning");
  assert.equal(payload.tags.category, "app");
  assert.equal(payload.tags.requestId, "");
});
