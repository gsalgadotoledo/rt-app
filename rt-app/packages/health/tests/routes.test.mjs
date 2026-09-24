import test from "node:test";
import assert from "node:assert/strict";
import { HealthChecks } from "../dist/index.js";

test("liveness/readiness and private report work without dependencies; invalid settings fail early", async () => {
  const health = new HealthChecks();
  for (const route of health.feature().endpoints)
    assert.equal((await route.handle()).ok, true);
  for (const [probes, timeout, cache] of [
    [[], 0, 1],
    [[], 10, -1],
    [[{ id: "db" }, { id: "db" }], 10, 1],
    [Array(21).fill({ id: "db" }), 10, 1],
  ]) {
    assert.throws(() => new HealthChecks(probes, timeout, cache), TypeError);
  }
});

test("uncached probes rerun and callers cannot mutate the retained report", async () => {
  let calls = 0;
  const health = new HealthChecks(
    [
      {
        id: "db",
        check: async () => {
          calls++;
        },
      },
    ],
    100,
    0,
  );
  const first = await health.report();
  first.checks[0].status = "down";
  assert.equal((await health.report()).checks[0].status, "up");
  assert.equal(calls, 2);
});
