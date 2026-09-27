# Idempotency: contract and ports

Persisted "at most once" execution of side effects. Reference: `packages/idempotency`
(`RTAppIdempotencyModule`, `NoSQLIdempotencyStore`, `createIdempotency`, `RTAppIdempotentModule`).
The module exposes no HTTP endpoints, so there is no `kind: http` contract.

- Contract: `spec/contracts/idempotency.contract.yaml`.
- Hosts: `spec/hosts/node/idempotency.mjs`, `spec/hosts/python/idempotency.py`,
  `core-go/cmd/contract-host/idempotency.go`.
- Ports: Python `rt_app.idempotency` (`Idempotency`, `NoSQLIdempotencyStore`, `create_idempotency`,
  `IdempotentModule`, `IdempotencyError`); Go `rt.local/core-go/idempotency` (`Executor`,
  `NoSQLStore`, `NewNoSQL`, `Idempotent`, `*Error` with `Code()`).
- TypeScript change: `new NoSQLIdempotencyStore(store, {now})` and `createIdempotency(store, {now})`
  accept an optional clock (epoch ms or Date); the default is unchanged.

## Subject `idempotency`

`init: {now: ISO 8601, rows}`: an executor over `NoSQLIdempotencyStore` on a MemoryStore holding
`rows`, behind a store that can fail on purpose.

| Method | Meaning |
| --- | --- |
| `execute(request, outcome)` | `request = {scope, key, input}`. The work logs `{input, idempotencyKey}`, then: `{result}` is returned, `{error}` is thrown as `Error(error)`, `{during: [request, outcome]}` first runs a nested execute and logs its outcome as `during: {value}` or `{error: {code, message}}` |
| `calls()` | the log of works that ran |
| `claim(claim)`, `complete(claim, result)`, `markUncertain(claim)` | the store surface; `claim = {scope, key, fingerprint, owner}` |
| `row(pk, sk)` | raw stored row or null |
| `injectFaults(kind, count)` | the next transactions: `ok` (pass), `conflict` (409, no write), `error` (`Store unavailable`, no write), `lostAck` (write, then `Acknowledgement lost`) |
| `setNow(iso)` | move the clock |
| `initUnconfigured()`, `executeUnconfigured(request)` | an executor without a store |

## Semantics ports must copy

- **Errors**: `{code, message: "RT-App idempotency: <CODE>"}`, no status. Order: `NOT_CONFIGURED`
  → `INVALID_KEY` → `INVALID_JSON` → store → state.
- **INVALID_KEY**: scope and key must be strings, not blank after JavaScript `trim()` (NBSP, BOM,
  U+2028, U+3000, U+2000–U+200A are whitespace; U+200B, U+0085, U+001F are not), at most 512 / 256
  **UTF-16 units**. They are stored untrimmed.
- **INVALID_JSON**: a missing `input` (undefined) is rejected; `null` is a valid input. Python checks
  key presence; Go uses `Request.NoInput`.
- **Fingerprint** = `sha256hex(canonical(input))`, canonical JSON exactly as in the cache doc (keys
  by UTF-16 units, JavaScript numbers, `JSON.stringify` strings). The work receives
  `JSON.parse(canonical(input))`, and results are stored and returned as
  `JSON.parse(canonical(result))`.
- **idempotencyKey** = `"rtapp-" + sha256hex(JSON.stringify([scope, key]))`; it depends on scope
  and key only. `JSON.stringify` does not escape U+2028, DEL or `<>&`.
- **owner** = a random UUID v4 per execute call.
- **Claim**: transact `{pk: "IDEMPOTENCY#" + scope, sk: key, version: 1, data: {fingerprint, owner,
  state: "pending", createdAt}}` with `expected: null`. On a Conflict, read the row: another
  fingerprint → `conflict`; `completed` → `{state: completed, result}`; `uncertain` → `uncertain`;
  any other state → `pending`; a vanished row rethrows the Conflict (409). Other store errors
  propagate as they are and the work never runs.
- **Execute**: `completed` replays without running; `pending`/`uncertain`/`conflict` throw the
  upper-cased code; `acquired` runs the work, normalizes the result, then `complete`s. If the work,
  the normalization or `complete` fails: `markUncertain` (its own failure is swallowed and the claim
  stays `pending`) and throw `UNCERTAIN` (the cause is attached).
- **complete / markUncertain**: read the row; missing, other owner or other fingerprint → 409
  Conflict; a `completed` row is left untouched (so a lost acknowledgement stays replayable);
  otherwise write version+1 with `{...data, state, updatedAt[, result]}` expecting the read version.
  An `uncertain` row can still be completed by its owner. Nothing is retried.
- **Time**: `createdAt`/`updatedAt` are `toISOString()` of the injected clock
  (`2026-01-02T03:04:05.678Z`). Nothing expires; there is no takeover.
