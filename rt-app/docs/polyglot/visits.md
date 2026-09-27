# Visits: contracts and ports

Contracts: `spec/contracts/visits.contract.yaml` (module) and `visits-api.contract.yaml` (HTTP).
Node host: `spec/hosts/node/monitoring.mjs`. The contract description holds the full algorithm.

| Language | Constructor |
| --- | --- |
| TypeScript | `new Visits(store, secret, pages?, clock = Date.now, newId = randomUUID)` |
| Python | `Visits(store, secret, pages=DEFAULT_PAGES, *, now=clock, new_id=uuid4)` |
| Go | `visits.New(store, secret, WithPages, WithClock, WithIDs)` |

Methods: `start(ip)`, `ingest({token, sequence, points}, ip)`, `list()`, `detail(id)`, `remove(id)`,
`feature()` (`POST /visits/start`, `POST /visits/events` for guests; `GET /visits`,
`GET /visits/:id`, `DELETE /visits/:id` for the owner under `/admin/app`). TypeScript gained the
optional `newId` argument so contracts can pin tokens.

## Subject

`visits`: `init {secret, pages?, now, ids?, rows?}`; `ids` are returned by the id generator in
order, then random UUIDs. Helpers: `startEach(ips)` (one `start` per ip) → null, `row(pk, sk)`,
`setNow(iso)`, `sign(payload)` → `payload + "." + signature`.

## Semantics ports must copy

- **Tokens:** `payload = base64url_nopad(utf8(JSON.stringify({id, startedAt})))` with keys in that
  order, `signature = base64url_nopad(HMAC-SHA256(utf8(secret), "visits:" + payload))`, compared in
  constant time. Tokens are byte-identical across languages (the contracts pin them).
- **Token checks, in order:** string of ≤ 500 UTF-16 units, exactly two dot-separated parts, a
  43-character base64url signature equal to the expected one (`Invalid visit token`); then Node's
  lenient base64url decode (both alphabets, stop at `=`), UTF-8 with replacement, `JSON.parse`, an
  object with a string `id` and a safe-integer `startedAt` (`1893456000000.0` counts) that is not in
  the future and at most 1 800 000 ms old (`Expired or invalid visit token`).
- **Order of checks in ingest:** rate limit, token, batch, points.
- **Rate limit:** per instance, key `sha256hex(ip)`, entries older than 60 000 ms are dropped on
  every call, a new key when 2000 are tracked is 429 `Visits busy`, the 61st call of a window is
  429 `Visit rate limit` (rejected calls count).
- **Numbers:** `sequence` and `t` are safe integers, `x`/`y` integers (`Number.isInteger`);
  booleans and numeric strings are invalid.
- **Storage:** one row `VISITS/recent`, `version` + 1 per write (1 when new), `ttl =
  ceil((now + 86 400 000) / 1000)`, `data.sessions` = `[{id, startedAt, updatedAt, sequence,
  points:[{type, path, t, x, y}]}]`. Every ingest (also a replay) and every remove rewrites the row;
  reads rewrite it only when a session expired (`startedAt <= now - 86 400 000`).
- **Order:** sessions sorted by `startedAt` descending, then `id` ascending. TypeScript uses
  `localeCompare`; for lowercase UUIDs this equals code point order, which the ports use. Only the
  first 10 are kept; `recorded` tells whether the session is among them. `list` keeps stored order.
- **Ports keep only `id` and `startedAt` from a token payload** (TypeScript spreads the whole
  payload into a new session; the server only signs these two fields). Go decodes sessions into
  structs, so unknown stored fields are not preserved.
- **Secrets:** the example APIs read `RT_APP_SECRET` and fall back to a random secret per process.
