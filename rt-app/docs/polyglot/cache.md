# Cache: contracts and ports

TTL cache-aside with stable content keys. Reference: `packages/cache` (Cache, MemoryCache,
canonical, contentKey, validateEntry), `packages/cache-nosql` (NoSQLCache), `packages/cache-file`
(FileCache) and `packages/cache-dynamodb` (DynamoCache). The module exposes no HTTP endpoints, so
there is no `kind: http` contract.

- Contracts: `spec/contracts/cache.contract.yaml` (every adapter) and
  `spec/contracts/cache-nosql.contract.yaml` (stored format of the NoSQL adapters).
- Hosts: `spec/hosts/node/cache.mjs`, `spec/hosts/python/cache.py`,
  `core-go/cmd/contract-host/cache.go`.
- Ports: Python `rt_app.cache` (`.nosql`, `.file`, `.dynamodb`); Go `rt.local/core-go/cache` and
  `cache/dynamocache`.

## Subjects and init

| Subject | Adapter | `init` |
| --- | --- | --- |
| `cache-memory` | `MemoryCache(capacity, clock)` | `{now, capacity?}`; a bad capacity fails the factory with `Invalid cache capacity` |
| `cache-nosql` | `NoSQLCache(MemoryStore(rows), namespace, clock)` | `{now, namespace?, rows?}` |
| `cache-file` | `FileCache(<temp file>, namespace, clock)` | `{now, namespace?}` |
| `cache-dynamodb` (optional) | `DynamoCache(<fresh table>, …, namespace, clock)` | `{now, namespace?}`; needs `RT_APP_TEST_DYNAMODB_ENDPOINT` |

`now` is epoch milliseconds (default `4102444800000`, 2100-01-01, far enough in the future that the
JSON file store never purges contract rows by real time).

## Facade

Every subject: `get(key)` → `{hit:false}` or `{hit:true, value}` (wire `null` cannot tell a miss
from a cached `null`), `set(key, value, ttlMs)`, `delete(key)`, `remember(namespace, input, ttlMs,
outcome)` (the loader returns `outcome.value` or throws `Error(outcome.error)`), `loads()`,
`rememberConcurrently(namespace, input, ttlMs, value, count)` → `{loads, results}` (count concurrent
calls, loader takes 50 ms), `canonical(value)`, `contentKey(namespace, input)`,
`validateEntry(key, ttlMs)`, `setNow(ms)`.

Extra helpers: `row(pk, sk)` (nosql, file, dynamodb); `injectFaults(kind, count)` with kinds
`ok | conflict | error | lostAck` queued one per transaction, `transacts()` and
`useNamespace(ns)` (nosql); `reopen()` and `file()` (file).

## Semantics ports must copy

- **Canonical JSON**: `JSON.stringify` with object keys sorted by **UTF-16 code units** (`"😀"`
  sorts before `"！"`), not code points. Numbers are float64 written as JavaScript does (`1e+21`,
  `1e-7`, `-0` → `0`, `12345678901234567890` → `12345678901234567000`). Strings escape only `"`,
  `\`, U+0000–U+001F (`\b \f \n \r \t`, else `\u00xx` lowercase) and lone surrogates; never U+2028,
  DEL or `<>&` (Go's `encoding/json` escapes those, so Go uses `internal/canonical`).
- **Errors** (TypeError, no status, exact messages): `Cache requires finite, acyclic JSON values`,
  `Cache accepts plain objects only`, `Invalid cache namespace`,
  `Cache needs a key and TTL between 1 ms and 30 days`, `Cache values are limited to 64 KB`,
  `Invalid cache capacity`. Store errors (409 Conflict, others) propagate unchanged.
- **contentKey** = `namespace + ":" + sha256hex(utf8(canonical(input)))`; namespace
  `^[a-zA-Z0-9:._-]{1,100}$` with `$` at the end of the string only (Python: `fullmatch`, not `$`).
- **validateEntry**: key non-empty, at most 240 UTF-16 units; TTL a safe integer in
  `[1, 2592000000]` ms (`1.5`, `"100"`, `true`, `null` are invalid). `get`/`delete` never validate.
- **set** order: entry, then canonical, then size (`utf8(canonical)` ≤ 64000 bytes: `"x"*63998`
  fits, `"é"*32000` does not). A rejected set changes nothing.
- **Expiry**: `expires = now + ttlMs`; an entry is live while `expires > now`.
  - MemoryCache: reading an expired entry deletes it; every set first drops expired entries, then
    evicts the least recently used beyond capacity (reads refresh recency, overwrite moves to the end).
  - NoSQL adapters: reads never delete, so a clock moving back revives a row.
- **NoSQL rows**: `{pk: "CACHE#" + namespace, sk: sha256hex(utf8(key)), version, data: {value:
  JSON.parse(canonical), expires}, ttl: ceil(expires / 1000)}`. A lone surrogate in a key hashes as
  U+FFFD. The namespace is not validated. A row without `value` or without a numeric `expires` is a
  miss. set/delete read, then write with `expected` = the read version (null when absent; delete of
  an absent row writes nothing), retrying a Conflict for **4 attempts in total**; other errors are
  not retried.
- **remember**: contentKey → validateEntry → adapter get (hit returns) → one in-flight load per key
  per process (Python threads share an event; Go goroutines share a channel) → set → return a copy.
  A failed load or failed set is not cached. `null`/`false` are cached values.
- **FileCache** file = the JsonStore format `{"format":1,"rows":[…]}`, rows in insertion order;
  lock `<file>.lock` (O_EXCL, 20 ms polling, 5 s, message `JSON store locked: <lock>. Stop writers
  before removing a stale lock.`), atomic temp file + fsync + rename, and every write drops
  `CACHE#`/`OBSERVER#`/`VISITS` rows whose `ttl` ≤ **real** time in seconds (not the injected clock).
  Python and Go keep a private port of this store (`JsonFileStore`, `cache.FileStore`) until the
  json module is ported.

## Language notes

- Python: `get` returns the `MISS` sentinel on a miss; clocks are `Clock` (epoch ms or datetime);
  values are copied with `copy.deepcopy`.
- Go: `Get` returns `(value, ok, err)`; TTLs are `time.Duration` (whole milliseconds) and
  `TTLFromMillis` converts loosely typed numbers; `WithClock(func() time.Time)`; values come back as
  decoded JSON (float64 numbers). `NewNoSQL(store, "")` uses the namespace `default` (TypeScript
  would use an empty namespace), and a loader panic becomes an error so waiters are released.
- Known gap: Go cannot receive lone surrogates (its JSON decoder turns them into U+FFFD), so
  canonical text of such strings differs from TypeScript; hashing a key is unaffected.
