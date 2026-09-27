# Queue in every language

Contracts: `spec/contracts/queue.contract.yaml` (module) and `queue-api.contract.yaml` (HTTP,
local mode). Hosts: `spec/hosts/node/queue.mjs`, `spec/hosts/python/queues.py` (not `queue.py`:
that folder is on `sys.path` and would shadow the standard library `queue`),
`core-go/cmd/contract-host/queue.go`. Ports: `rt_app.queue` (Python) and `rt.local/core-go/queue`
(Go). The contract description holds the full rules; this page lists the surface and the details
that are easy to get wrong. Broker adapters (SQS, RabbitMQ) are out of scope; they implement the
same adapter surface.

## Surface and clock

`new Queue(adapter, {now, random}?)` takes an optional clock (epoch ms or a Date; `createdAt`) and
jitter source (retry backoff); both default to the system ones. `new MemoryQueue(capacity = 1000,
leaseSeconds = 30, clock = Date.now)` already took a clock.

| | TypeScript | Python | Go |
| --- | --- | --- | --- |
| Adapter | `QueueAdapter` | `QueueAdapter` protocol (`inspect_failures`/`retry_failure` optional) | `Adapter` + optional `FailureAdmin` |
| Memory | `new MemoryQueue(c, s, clock)` | `MemoryQueue(c, s, now=clock)` | `NewMemory(c, s*time.Second, WithClock(now))` |
| Validate | `validateMessage(m)` | `validate_message(m)` (dicts) | `MessageFrom(decoded)` / `Message.Validate()` |
| Send | `send(type, payload, {id, traceId})` | `send(type, payload, id=, trace_id=)` | `Send(ctx, type, payload, WithID(id), WithTraceID(t))` |
| Work | `workOnce(handler, options, signal)` | `work_once(handler, concurrency=…, stop=event)` (threads) | `WorkOnce(ctx, handler, WorkerOptions)` (goroutines) |
| Loop | `run(handler, options, signal)` | `run(handler, stop, idle_ms=…)` | `Run(ctx, handler, opts)` (nil on cancel) |
| Settlement errors | `AggregateError` | `ExceptionGroup` | `*SettlementError` (`Unwrap() []error`) |
| Endpoints | `feature()` | `feature()`, `status()`, `inspect(body)`, `retry_failed(body)` | `Feature()`, `Status`, `Inspect`, `RetryFailed`, `Admin()` |

Go takes durations (`Retry(ctx, 5*time.Second)`); they must be whole seconds like the TypeScript
integers, and `WorkerOptionsFrom(map)` reads loosely typed options with the TypeScript names.
Python keyword options treat `None` as "use the default", like `??`.

**Contract subject `queue`.** `init: {now, capacity?, leaseSeconds?, random?, capabilities?}`. The
facade numbers deliveries 0, 1, 2… (`receive(limit)` → `[{delivery, attempts, message}]`,
`ack|retry|extend|deadLetter(n, seconds?)`); `workOnce(outcomes, options)` and `run(outcomes,
options, stopAfter)` drive a handler per message id (`ok`, `fail`, `ack`, `nested`), `handled()`
lists the calls in delivery order. Endpoint handlers: `status()`, `inspect(body)`,
`retryFailed(body)`; helpers `endpoints()`, `admin()`, `migrations()`, `validateMessage`,
`validateFailureLimit`, `inspectFailures`, `retryFailure`, `deadLetters`, `capabilities`,
`setNow(iso)`.

## Semantics ports must copy

- **Envelope:** `id` ≤ 200 and `type` ≤ 120 UTF-16 units, non-blank after JavaScript `trim()` (not
  trimmed when stored); `traceId` absent or a string ≤ 200 (`""` valid, `null` invalid; `send`
  drops falsy trace ids); canonical JSON (the cache module's) ≤ 240000 UTF-8 bytes; the result is
  the canonical JSON parsed back, unknown fields included. Messages are always deep copies.
- **`createdAt`:** `Date.parse` must not be NaN. Ports implement the ECMAScript date-time format
  (with V8's quirks: `2026-02-30` rolls over, `24:00:00`, lowercase `t`/`z`, a space for `T`,
  `+0200`, more than 3 fraction digits, the ±8.64e15 ms range). V8's legacy formats
  (`Jan 2 2026`, `2026/01/02`, even `hello 5`) are accepted by TypeScript only and not pinned.
- **Memory adapter:** publish checks capacity (pending + leased) **before** validation; receive
  returns visible entries in **publish order** (a retried message keeps its place;
  `retryFailure` appends); no deduplication. A delivery is stale when redelivered, retried (the
  receipt is cleared), settled, or when `available <= now` (the lease ends exactly at expiry), and
  staleness is reported before an invalid delay. `extend(0)` ends the lease at once. Dead letters
  share the capacity; a full dead-letter list leaves the message leased.
- **Worker:** limits are validated first, then "Worker already receiving" (one `workOnce` per
  Queue at a time, re-entrant calls included), then receive. Backoff:
  `floor(random() * (min(max, base * 2^min(attempts - 1, 20)) + 1))` seconds, 0 when the adapter
  has no `delayedRetry`; `attempts >= maxAttempts` dead-letters. Failed settlements are reported
  together after every delivery settled; the worker is free again afterwards.
- **Errors:** validation and broker errors have no status (TypeScript `TypeError`/`Error`); the
  DLQ ones are HTTP errors: 400 `Limit must be between 1 and 10`, 409 `Message is no longer
  available; refresh the list`, 409 `Queue capacity exceeded`, 501 when the adapter does not
  declare `failedAdmin: true` (checked before the body), 400 `Invalid retry token`.

## HTTP (local mode)

All three endpoints are `owner`: served at their path (401 `Sign in` without a session) and under
`/admin/app` as the local owner. Nothing publishes over HTTP, so the dead-letter list is empty; the
module contract covers the full flow. The reference API (`spec/hosts/node-api.mjs`) must be
composed with `queueAdapter: new MemoryQueue()` for these cases to run on the node target; the
Python and Go example APIs compose the queue in `modules/queue.py` and `queue.go`.
