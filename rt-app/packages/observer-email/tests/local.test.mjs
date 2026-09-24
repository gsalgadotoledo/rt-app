import test from "node:test";
import assert from "node:assert/strict";
import { EmailOutput, LocalEmailOutput } from "../dist/index.js";

test("local email guards environment/ports and formats events without opening a socket", async (t) => {
  const previous = process.env.NODE_ENV;
  t.after(() => {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  });
  process.env.NODE_ENV = "production";
  assert.throws(
    () => new LocalEmailOutput("a@example.test", "b@example.test"),
    /production/,
  );
  process.env.NODE_ENV = "test";
  for (const port of [0, 1023, 65536, 2.5])
    assert.throws(
      () => new LocalEmailOutput("a@example.test", "b@example.test", port),
      /port/,
    );
  const output = new LocalEmailOutput("a@example.test", "b@example.test");
  let message;
  output.transport = {
    sendMail: async (value) => {
      message = value;
    },
  };
  const event = { level: "error", source: "payments", message: "Declined" };
  await output.write(event);
  assert.equal(message.to, "b@example.test");
  assert.equal(message.subject, "[error] payments");
  assert.deepEqual(JSON.parse(message.text), event);
  assert.throws(
    () => new EmailOutput("invalid", "b@example.test", {}),
    /addresses/,
  );
  assert.throws(
    () => new EmailOutput("a@example.test", "invalid", {}),
    /addresses/,
  );
});
