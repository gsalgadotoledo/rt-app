import test from "node:test";
import assert from "node:assert/strict";
import { SlackOutput } from "../dist/index.js";

test("Slack rejects untrusted destinations and uses event identity when optional context is absent", async () => {
  for (const url of [
    "http://hooks.slack.com/services/x",
    "https://attacker.test/services/x",
    "https://hooks.slack.com/wrong",
  ])
    assert.throws(() => new SlackOutput(url), /Invalid/);
  let payload;
  await new SlackOutput(
    "https://hooks.slack-gov.com/services/x",
    async (_, options) => {
      payload = JSON.parse(options.body);
      return new Response("ok");
    },
  ).write({ id: "e1", source: "app", level: "warn", message: "test" });
  assert.match(payload.text, /app: test\nRequest: e1/);
});
