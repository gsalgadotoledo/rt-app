import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HealthChecks,
  AvailabilityMonitor,
  httpHealthProbe,
} from "../dist/index.js";

test("availability alerts failure and recovery, retries notification failures", async () => {
  let down = false,
    fail = true;
  const alerts = [];
  const checks = new HealthChecks(
    [
      {
        id: "api",
        check: async () => {
          if (down) throw Error("down");
        },
      },
    ],
    100,
    0,
  );
  const monitor = new AvailabilityMonitor(checks, async (a) => {
    if (fail) {
      fail = false;
      throw Error("mail offline");
    }
    alerts.push(a.status);
  });
  await monitor.poll();
  down = true;
  await assert.rejects(monitor.poll(), /mail offline/);
  await Promise.all([monitor.poll(), monitor.poll()]);
  await monitor.poll();
  down = false;
  await monitor.poll();
  assert.deepEqual(alerts, ["down", "up"]);
});
test("HTTP probe cancels body, passes abort and rejects unhealthy responses and credentials", async () => {
  let cancelled = false;
  const signal = new AbortController().signal;
  await httpHealthProbe(
    "api",
    "http://localhost/health",
    async (url, options) => {
      assert.equal(options.signal, signal);
      assert.equal(options.redirect, "error");
      return {
        ok: true,
        body: {
          cancel: async () => {
            cancelled = true;
          },
        },
      };
    },
  ).check(signal);
  assert.ok(cancelled);
  await assert.rejects(
    httpHealthProbe("api", "https://example.test", async () => ({
      ok: false,
    })).check(signal),
  );
  assert.throws(() => httpHealthProbe("x", "ftp://example.test"));
  assert.throws(() => httpHealthProbe("x", "https://user:pass@example.test"));
});

test('initial outage notifies and credential-only URLs are rejected', async () => {
  const alerts = [];
  const monitor = new AvailabilityMonitor(new HealthChecks([{ id: 'api', check: async () => { throw Error('down'); } }], 100, 0), async alert => { alerts.push(alert); });
  await monitor.poll();
  assert.equal(alerts[0].status, 'down');
  assert.throws(() => httpHealthProbe('api', 'https://:secret@example.test'));
  assert.equal(httpHealthProbe('api', 'https://example.test').id, 'api');
});
