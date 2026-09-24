import test from "node:test";
import assert from "node:assert/strict";
import { ConsoleOutput } from "../dist/index.js";

test("each severity uses its matching console method with structured JSON", (t) => {
  const output = new ConsoleOutput();
  for (const level of ["debug", "info", "warn", "error"]) {
    const sink = t.mock.method(console, level, () => {});
    const event = {
      level,
      message: "test",
      category: "payments",
      requestId: "r1",
    };
    output.write(event);
    assert.equal(sink.mock.callCount(), 1);
    assert.deepEqual(JSON.parse(sink.mock.calls[0].arguments[0]), event);
    sink.mock.restore();
  }
});
