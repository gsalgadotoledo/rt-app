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

test("an injected clock sets `at` and the cache expiry", async () => {
  let now = Date.parse("2026-01-02T03:04:05.678Z"),
    calls = 0;
  const health = new HealthChecks([{ id: "db", check: async () => { calls++; } }], 100, 1000, { now: () => now });
  assert.equal((await health.report()).at, "2026-01-02T03:04:05.678Z");
  now += 999;
  assert.equal((await health.report()).at, "2026-01-02T03:04:05.678Z");
  assert.equal(calls, 1);
  now += 1;
  assert.equal((await health.report()).at, "2026-01-02T03:04:06.678Z");
  assert.equal(calls, 2);
  const dated = new HealthChecks([], 100, 0, { now: () => new Date(0) });
  assert.equal((await dated.report()).at, "1970-01-01T00:00:00.000Z");
});
