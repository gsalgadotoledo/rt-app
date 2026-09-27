# Health: contracts and ports

Contracts: `spec/contracts/health.contract.yaml` (module) and `health-api.contract.yaml` (HTTP).
Node host: `spec/hosts/node/monitoring.mjs`. The contract description holds the full algorithm;
this page lists what a port exposes and the semantics it must copy.

| Language | Checks | Monitor | HTTP probe |
| --- | --- | --- | --- |
| TypeScript | `new HealthChecks(probes, timeoutMs, cacheMs, {now})` | `new AvailabilityMonitor(checks, notify)` | `httpHealthProbe(id, url, fetch)` |
| Python | `HealthChecks(probes, timeout_ms, cache_ms, now=clock)`, `Probe(id, run, required=True)` | `AvailabilityMonitor(checks, notify)` | `http_health_probe(id, url, transport)` |
| Go | `health.New(probes, WithTimeout, WithCache, WithClock)`, `Probe{ID, Optional, Check}` | `health.NewMonitor(checks, notify)` | `health.HTTPProbe(id, url, client)` |

`HealthChecks` gained an optional clock (`{now: () => number | Date}`, fourth argument); the default is
unchanged. `Health` (Python) and `health.Feature()` (Go) keep the earlier live/ready-only feature.

## Subjects

| Subject | `init` | Methods | Helpers (facade only) |
| --- | --- | --- | --- |
| `health` | `{probes: [{id, required?, behavior?}], timeoutMs?, cacheMs?, now}` | `report()`, `live()`, `ready()`, `healthReport()`, `endpoints()` | `concurrentReports(n)`, `setProbe(id, behavior)`, `calls(id)`, `aborted(id)`, `setNow(iso)` |
| `health-monitor` | same, `cacheMs` defaults to 0 | `poll()` | `alerts()`, `failNotifications(n)`, `setProbe`, `setNow` |
| `health-http-probe` | — | `probe(id, url)` → `{id}` | `check(url, status)` (transport answering `status`) |

Probe behaviors: `up`, `down` (fails with a secret-looking message), `slow` (up after 50 ms) and
`hang` (never completes on its own; it records the abort signal / cancelled context).

## Semantics ports must copy

- **Configuration:** at most 20 probes, unique ids, `timeoutMs` a finite number ≥ 1 and `cacheMs`
  ≥ 0 (JavaScript `typeof number`: `"10"` and `true` fail). Error: plain (no status)
  `Invalid health configuration`. Go takes `time.Duration`s; the host rejects non-numbers.
- **Report:** `{ok, at, checks:[{id, required, status, durationMs}]}` in probe order. `required` is
  false only for `required: false` (Go: `Optional: true`). Failures never leak details. `at` is the
  clock at the end of the run (`toISOString`), `durationMs` is `Math.round` of monotonic time.
- **Parallel and bounded:** probes run concurrently; a probe that exceeds the timeout is down and
  aborted (Python: its `threading.Event` is set; Go: its context is cancelled).
- **Cache:** reuse while `expires > now`, `expires = now + cacheMs` at the end of the run. Concurrent
  callers share one in-flight run (Python: a shared `Future`; Go: a small single-flight).
- **Endpoints:** `GET /health/live` → `{ok: true}`; `GET /health/ready` → `{ok: true}` or 503
  `Service unavailable` (uses the cached report); `GET /health/report` (owner, under `/admin/app`).
  The example APIs register one required probe, `database`, reading `SCHEMA/users` from the store.
- **Monitor:** notify `{service, status, at}` when a status differs from the last saved one, or on a
  first `down`. A check's state is saved only after its notification succeeds; a failing notify
  fails the poll and skips the remaining checks, which the next poll retries.
- **HTTP probe:** the URL must parse as absolute (`Invalid URL`), be http(s) and carry no non-empty
  user name or password (`Invalid health URL`). The check does not follow redirects; only 2xx is up.
