import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiAlerts } from "../dist/index.js";
const event = (status = 200, durationMs = 5) => ({
  kind: "request",
  data: { status, durationMs },
});
test("bounded API windows notify once and reset; logs do not recurse", async () => {
  let now = 0;
  const alerts = [];
  const output = new ApiAlerts(
    { requests: 2, errors: 1, averageMs: 4, minimumSamples: 2 },
    async (a) => alerts.push(a),
    () => now,
  );
  await output.write({ kind: "log" });
  await output.write(event());
  await output.write(event(500));
  await output.write(event());
  assert.equal(alerts.length, 1);
  assert.deepEqual(alerts[0].reasons, [
    "request-volume",
    "server-errors",
    "latency",
  ]);
  now = 60000;
  await output.write(event(500));
  assert.equal(alerts.length, 2);
});
test("validation and retry failed notifications without concurrent duplicates", async () => {
  assert.throws(() => new ApiAlerts({ requests: 0 }, async () => {}));
  assert.throws(() => new ApiAlerts({ windowMs: Infinity }, async () => {}));
  let calls = 0;
  const output = new ApiAlerts({ errors: 1 }, async () => {
    calls++;
    if (calls === 1) throw Error("offline");
  });
  for (const bad of [
    event("x"),
    event(99),
    event(600),
    event(200, -1),
    event(200, NaN),
  ])
    await output.write(bad);
  await assert.rejects(output.write(event(500)), /offline/);
  await Promise.all([output.write(event(500)), output.write(event(500))]);
  assert.equal(calls, 2);
  const disabled = new ApiAlerts({}, async () => {
    throw Error("should not alert");
  });
  await disabled.write(event());
});
