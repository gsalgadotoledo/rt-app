import test from "node:test";
import assert from "node:assert/strict";
import { CloudWatchLogReader, CloudWatchOutput } from "../dist/index.js";

test("reader skips malformed/nonmatching records and terminates repeated pagination tokens", async () => {
  const event = {
    id: "event",
    at: "2026-09-23T12:00:00Z",
    level: "error",
    message: "Declined",
    category: "payments",
    requestId: "r1",
    sessionId: "s1",
    data: {},
  };
  let input;
  const reader = new CloudWatchLogReader("group", {
    send: async (command) => {
      input = command.input;
      return {
        nextToken: "same",
        events: [
          {},
          { message: "invalid" },
          { message: "{}" },
          { message: JSON.stringify({ ...event, level: "info" }) },
          { message: JSON.stringify(event) },
        ],
      };
    },
  });
  const page = await reader.search({
    day: "2026-09-23",
    level: "error",
    category: "payments",
    requestId: "r1",
    sessionId: "s1",
    cursor: "same",
  });
  assert.deepEqual(page.events, [event]);
  assert.equal(page.cursor, undefined);
  assert.match(input.filterPattern, /requestId/);
  await assert.rejects(reader.search({ day: "bad" }));
  assert.throws(() => new CloudWatchOutput("", "stream", {}), /group/);
  assert.throws(() => new CloudWatchOutput("group", "", {}), /stream/);
  assert.deepEqual(
    (
      await new CloudWatchLogReader("group", { send: async () => ({}) }).search(
        { day: "2026-09-23" },
      )
    ).events,
    [],
  );
});
