# Polyglot RT-App: contracts, Python and Go

Goal: TypeScript stays the reference implementation. Each module has a **contract**, a YAML file
with its inputs, outputs and errors. Python and Go implementations must pass the same contract, and
the same API runs in any of the three languages. Each language has three modes: HTTP server
(local), AWS Lambda and CLI.

## Research summary (September 2026)

- **No standard tool** runs function-level tests unchanged across languages. The established
  pattern is a *conformance suite*: language-neutral vectors plus a small adapter per implementation.
  Examples are test262 (JavaScript), the protobuf conformance runner, the Exercism
  `canonical-data.json` files, and recent suites for HCL, SDK webhooks and expression parsers.
- **HTTP APIs** already have mature tools. OpenAPI with Hurl covers examples, Schemathesis
  covers fuzzing, and Specmatic covers stubs and backward compatibility. Pact targets
  consumer-driven contracts between services, not reimplementations of one API.
- **RT-App choice:** contracts in YAML, `rt-app/spec/contracts/*.contract.yaml`. They are
  run by `@gsalgadotoledo/rt-app-conformance` against a **contract host** per language, over
  loopback HTTP. Hosts build real instances with the case's `init` values and call real methods,
  internal ones included. `kind: http` contracts test a running API the same way.

## Contract format

See `rt-app/packages/conformance/src/contract.ts` and `values.ts`.

- `contract: 1`, `module`, `subject`, `init`, then `cases`. Each case has `steps`, and each step
  has `call`, `args` and `expect`: `{value}` or `{error: {status, message}}`. Single-step cases can
  use a shorthand form.
- **Matchers:**
  - `$any`, `$type`: string, number, integer, boolean, array, object, null, iso-date
  - `$regex`, `$approx`, `$partial`, `$length`, `$oneOf`
- **Macros**, expanded by the runner so hosts never see them:
  - `$ref: "0.value.cursor"` reads the result of an earlier step.
  - `$repeat: {count, start, item}` builds a list, with `{i}` and `{i:03}` for the index.
  - `$text: {repeat, count}` builds a long string.
  - `$concat: [a, b, …]` joins strings after expanding them (`["Bearer ", {$ref: "0.value.token"}]`).
  - In `kind: http` requests, `{{0.body.id}}` works in paths (URL-encoded) and header values (as is).
- **Wire values:**
  - JSON, plus tagged `{"$date"}`, `{"$bytes"}` and `{"$bigint"}`.
  - `null` stands for undefined, None and nil alike.
  - In objects, a null field equals a missing field.
- **Errors:** errors are results, `{type, status?, code?, message}`. Contracts match `status` and
  `message`, never `type`, because type names differ by language.
- **Recording:** `--record` runs the reference implementation (node) and writes the outputs of
  steps without `expect`, such as hash buckets.

### Host protocol v1

The host listens on loopback only and prints `RT_CONTRACT_READY <url>` once it is up.

| Request | Response |
| --- | --- |
| `GET /rt-contract/v1` | `{protocol:1, language, runtime, subjects:[…]}` |
| `POST /rt-contract/v1/instances` with `{subject, init}` | `{ok:true, id}` or `{ok:false, error}` (the factory threw) |
| `POST /rt-contract/v1/instances/<id>/<method>` with `{args:[…]}` | `{ok:true, value}` or `{ok:false, error}` |
| `DELETE /rt-contract/v1/instances/<id>` | `{ok:true}`, after calling close/dispose if present |

- Protocol failures (unknown subject, instance or method) return HTTP 404 with `{protocolError}`.
- Requests with an `Origin` header are refused with 403.
- Method names in contracts are camelCase. Python maps them to snake_case. Go uses explicit
  method tables.
- Names starting with `_` are never callable.

### Semantics that ports must copy exactly (TypeScript is the reference)

- String length limits count **UTF-16 code units** (JavaScript `length`): Python uses
  `len(s.encode("utf-16-le")) // 2`, Go counts runes above U+FFFF twice.
- Sort keys are ordered by **Unicode code point**. This is the order of DynamoDB and of Postgres
  `COLLATE "C"`. Python `<` already does this, and Go compares UTF-8 bytes.
- JSON typing follows JavaScript `typeof`:
  - `true` is not a number. Python `bool` is an `int`, so check it first.
  - `1.5` is not an integer version.
- `new Date().toISOString()` looks like `2026-01-02T03:04:05.678Z`: milliseconds, `Z`.
- MemoryStore cursor: base64url, no padding, of compact JSON `{"pk":…,"sk":…}`. Cursors are opaque
  to clients, but they must be rejected on another partition (400 `Invalid cursor`).

## Module philosophy per language (idiomatic, same idea)

TypeScript composes modules in one place (`createRTApp({...})` / `createApplication`). Swapping
an implementation means changing one line, and every module is a singleton per application.

| | TypeScript | Python | Go |
| --- | --- | --- | --- |
| Composition root | registry object | one `app.py`: `Singleton(partial(Impl, **config))` per component | one `main.go`: `rtcore.New(func() (T, error) {...})` per component |
| Swap implementation | change `module:` | change the class or `partial(...)` | change the import or the constructor |
| Singleton | `RTAppManager` | `rt_app.Singleton` (thread-safe, lazy, `close`) | `rtcore.Singleton[T]` (`sync.OnceValues`) |
| Dependencies | `bindings` / `dependsOn` | constructor arguments (`Protocol` types) | constructor arguments (small interfaces defined by the consumer) |
| HTTP | framework `handle(request)` | `rt_app.web.App` + stdlib `http.server` | `web.App` implements `http.Handler` (small router with the TypeScript rules) |
| Lambda | `apps/lambda-ts` | `handler_for(app)` (API Gateway v1/v2 events, no dependencies) | `aws-lambda-go` + `events.APIGatewayV2HTTPRequest` |
| CLI | `rta` | `python -m rt_app.web call app:app GET /path` | `-mode=cli GET /path` |

No dependency-injection framework is needed:

- **Python:** constructor injection plus `Singleton` is what `svcs` and `dependency-injector`
  formalize.
- **Go:** explicit constructors are the community norm. `wire` and `fx` are optional.
- **Libraries:** only well-established ones are used. `aws-lambda-go` is the official AWS library
  for Go. Python needs none: the Lambda event format is plain dicts.

## API behavior shared by every language (from the TypeScript framework)

- **Features:** a feature is `{id, endpoints}`. An endpoint is `{method, path, access,
  resource, handle(ctx)}`.
- **Routing:**
  - Literal routes win over routes with `:params`.
  - Params are URL-decoded, and a bad encoding returns 400 `Invalid URL`.
  - No match returns 404 `Endpoint not found`.
- **Error responses:**
  - An `HttpError` answers with its status and `{"error": message}`.
  - Anything else answers 500 `{"error":"Internal error"}` and is logged.
- **Owner and permission endpoints** are served at their path and again under `/admin/app<path>`.
  Only a few are admin-only (owner feature-flags/visits, `/health/report`, `/infra*`, `/aws/*`,
  `/observer/report|logs`, `/subscriptions/admin/*`, `/service-keys*`), the same list as the
  TypeScript framework.
- **Service endpoints** (`access: "service"`) live under `/service/` only, are never mounted under
  `/admin/app` and take only service keys (`Bearer rtsk_<id>.<secret>`) holding their resource
  as a scope; see `docs/polyglot/service-keys.md`.
  - In local mode (`local_admin`) the actor is `{id: "rt-app-root", role: "owner"}`.
  - Without an actor they return 401 `Sign in` (the TypeScript ACL message).
- **Adapters:**
  - Bodies must be JSON objects: 400 `Invalid JSON`.
  - The body limit is 16 KiB: 413 `Request body too large`.
  - Responses are JSON with `cache-control: no-store`.

## Status

- **Contracts:** every file in `spec/contracts` (nosql on memory, PostgreSQL and DynamoDB, the
  identity modules including refresh sessions, service keys, account bans and test users, subscriptions,
  observer, cache, queue, tasks and the other modules, plus their `*-api` HTTP contracts). Run them
  with `npm run contracts:stores`: node, python and go pass all 1226 cases; the Lambda targets pass
  the 82 HTTP API cases (September 2026).
- **Ports:** Python `rt_app` and Go `rt.local/core-go` implement every contracted module. Each has
  server, Lambda (plus a local bridge) and CLI modes, and can fall back to the Node core.
- **Generator:** `npm create @gsalgadotoledo/rt-app` with the Python or Go backend produces a
  native API with a composition root. Native routes answer there; other routes use the Node core.
- **Development:** `npm run link:app` uses this checkout in an app. The Service Manager has a
  Contracts panel (matrix per case × language) and a Terraform tab per project.
- **Next:** port the remaining modules (content, visits, analytics, the subscriptions service,
  deployments…) contract by contract, then drop the Node core fallback for fully native backends.

## Subscriptions ledger and credits contracts

Credit reservations (holds, settlement, pre-flight checks, thresholds):
`docs/polyglot/subscriptions-reservations.md` and `spec/contracts/subscriptions-reservations*.contract.yaml`.

Finance limits (short window, model caps, provider costs, margin rule) and unit economics:
`docs/polyglot/subscriptions-limits.md` and `spec/contracts/subscriptions-{limits,economics,limits-api}.contract.yaml`.

Contracts: `spec/contracts/subscriptions-ledger.contract.yaml` and
`subscriptions-credits.contract.yaml`. Node host: `spec/hosts/node/billing.mjs`. The contract
descriptions hold the full algorithm; this section lists what a port has to expose.

**`subscriptions-ledger`** is a stateless object over the pure functions of
`packages/subscriptions/src/ledger.ts`. `init` is ignored.

| Method | Returns |
| --- | --- |
| `emptyTotals()` | `{creditsIn, creditsOut, expired, paidMinor:{}, grantedValueMinor:{}}` |
| `LEDGER(userId)` | `"SUB_LEDGER#" + userId`. Python's `snake_case` maps it to `ledger`. |
| `ledgerKey(at, seed, sequence?)` | `pad15(at)-pad10(sequence)-sha256hex(utf8(seed))[:16]` |
| `ledgerWrite(userId, entry, seed, sequence?)` | `{entry, write:{row:{pk, sk, version:1, data}, expected:null}}` |
| `applyTotals(totals?, entry)` | new totals. The input is never mutated. |
| `rollover(previous?, current?, used, now)` | `{entries, state}` |

- `used` is a function in TypeScript. On the wire it is a table `{productId: {"<start>": credits}}`,
  and a missing entry means 0.
- Wire `null` means "not given", so optional parameters take their default.

**`subscriptions-credits`** is built from `init.credits` (raw settings, validated when the instance is
created) or from the defaults. Methods: `defaults()`, `validateCredits(input)`,
`estimate({rateId, inputTokens, outputTokens?})`, `validCurrency(code)`, `currencyDecimals(code)`
and `validMinorAmount(amount, code)`. The account preview of `estimate` (`userId`) is not part of the
contract.

**Numeric and time conventions (TypeScript is the reference):**

- **Numbers:** all numbers are IEEE-754 float64. Use `float`/`float64`, never `Decimal`/`big.Float`.
  - `0.1 + 0.2` credits is `0.30000000000000004`.
  - The rate check `Math.round(n*1e4) === n*1e4` rejects some 2-decimal rates, such as 0.07.
  - Integers stay exact up to 2^53.
- **Rounding:** `Math.round` rounds halves up (`floor(x + 0.5)`). Python `round()` and Go
  `math.Round`/`RoundToEven` differ at .5 (Go `math.Round` rounds -2.5 away from zero), so use
  `floor(x + 0.5)`.
- **Validation errors** use status 400, except `Credit rate not found` (404). Messages must match
  exactly, and checks run in the documented order.
- **Number to string:** numbers inside keys and seeds use JavaScript Number to String.
  - Integers are written as plain digits: `1.0` is written `1`, not `1.0`.
  - Other examples: `1.5`, `-1`, `1e+21`, `1e-7`.
  - Python `repr(float)` and Go `strconv.FormatFloat(x, 'f', -1, 64)` need adjusting for integral
    floats and exponents.
- **Padding:** `padStart` pads and never truncates.
- **Hashing:** seeds are hashed as UTF-8. A lone surrogate becomes U+FFFD.
- **Time:** timestamps are epoch milliseconds. Nothing reads the clock: `rollover` takes `now`
  explicitly, and `estimate` does not depend on time.
- **Entry order** in `rollover`:
  - Entries are sorted stably by `at`.
  - For the same `at`, expiries come first, in reverse generation order, then allowances in
    generation order.
  - Expiries are generated in JavaScript property order of `previous.products`: array-index keys
    such as `"2"` or `"10"` in ascending numeric order, then the other keys in JSON order. Go
    ports must decode that object with its key order preserved.

## Identity contracts: jwt, users, acl and auth

Refresh sessions (rotating refresh tokens, `SESSIONS#<userId>` rows, `/auth/refresh`,
`/auth/sessions`): `docs/polyglot/auth-sessions.md` and `spec/contracts/auth-sessions*.contract.yaml`.

Account bans (an extension of users: `data.ban` on the user row, the sign-in gate, `USER_BANS#`
history, `/users/:id/ban|unban|bans`): `docs/polyglot/users-bans.md` and
`spec/contracts/users-bans*.contract.yaml`.

Test users (`data.testUser` on the user row, set by administrators on create and
`PATCH /users/:id`, the admin view field, the `?testUser=` filter and `testUserIds` for reports):
`docs/polyglot/users-test-flag.md`, `spec/contracts/users.contract.yaml` (tag `test-users`) and
`users-test-flag-api.contract.yaml`.

Service keys (scoped backend credentials, `access: "service"` endpoints under `/service/`):
`docs/polyglot/service-keys.md` and `spec/contracts/service-keys.contract.yaml`,
`subscriptions-service-keys-api.contract.yaml`.

Contracts: `spec/contracts/{jwt,users,acl,auth}.contract.yaml`. Node host:
`spec/hosts/node/identity.mjs`. The contract descriptions hold the full algorithms (claim rules,
validation order, hash, HMAC and vault formats, rate-limit keys); this section lists what a port has
to expose. Every subject is a small facade, so every language exposes the same surface.

**Clock.** Every identity subject takes `init.now`, an ISO 8601 instant, and reads the time only
from that clock. The TypeScript classes accept an optional clock (`() => number | Date`, epoch
milliseconds or a Date; the system clock when omitted):

- `new JwtTokens(secret, issuer?, audience?, {now})`
- `new Users(store, credentials?, {now})`
- `new ACL(store, resources, {now})`
- `new Auth(users, tokens, mailer, secret, provider?, {now, sessionTtlMs?, refreshGraceMs?})`
- `totpStep(secret, code, last?, nowMs?)`

The audit helpers (`auditCreate`, `auditUpdate`, `auditDelete`, `auditRestore`) take an optional
`at: Date`. Ports must inject the clock the same way, with production defaults unchanged.

| Subject | `init` | Module methods | Helpers (facade only) |
| --- | --- | --- | --- |
| `jwt` | `{secret, issuer?, audience?, now}` | `issue(user)`, `verify(token)` | `setNow(iso)` → null |
| `users` | `{rows, now}` (rows seed a MemoryStore) | `get(id)`, `byEmail(email)`, `create(input, role?, actor?)`, `bootstrapOwner(input)`, `profile(id, input, actor?)` | `validatePassword(p)` → null, `hashPassword(p)`, `verifyPassword(p, stored)`, `row(pk, sk)` |
| `acl` | `{rows, resources, now}` (resources are the registered endpoints) | `allows(actor, resource)`, `check(endpoint, actor)` → null | `resources(query)` (GET /acl/resources handler), `assign(id, body, actor)` (PUT /acl/users/:id handler), `row(pk, sk)` |
| `auth` | `{secret, now, rows, sessionTtlMs?}` | `login`, `issue`, `consume`, `actor`, `limit` → null, `settings`, `updateSettings`, `hasMfa`, `setupMfa`, `enableMfa`, `verifyMfa`, `resetMfa`, `requestEmailChange`, `confirmEmailChange`, `refresh`, `sessions`, `revokeSession`, `logout` | `mailbox()`, `row(pk, sk)`, `setNow(iso)`, `totpCode(secret, step)`, `unseal(sealed)` |

**Helper details:**

- `setNow(iso)` moves the clock that the subject shares with its JWT signer. It is how contracts
  cross expiry and rate-limit boundaries.
- `row(pk, sk)` returns the raw stored row or null. It is used to pin the storage formats (users,
  EMAIL index, RATE, CHALLENGE, AUTH_FLOW, MFA) that another language must be able to read.
- `mailbox()` returns the codes sent by a capturing mailer, newest first, as `[{email, code, purpose}]`.
  Contracts read an emailed code with `$ref: "N.value[0].code"`.
- `totpCode(secret, step)` is the RFC 6238 six-digit code for an explicit 30-second step.
- `unseal(sealed)` opens a vault value.
- Wire `null` stands for an omitted optional argument: role defaults to `user`, actor defaults
  to the user itself, and `password`/`challengeId` are optional in `consume`.
- `auth` wires `Users` + `JwtTokens(secret)` + a capturing mailbox + `Auth(secret)` over one
  MemoryStore, with no identity provider.

**Interop details ports get wrong most often:**

- **JWT:**
  - The key is the UTF-8 secret, which needs at least 32 bytes.
  - Payload key order is `v, sub, iss, aud, iat, exp` (`v, sid, sub, …` for session tokens), so
    tokens are byte-identical across languages.
  - `exp <= now` is expired, with no leeway.
  - A future `iat` is accepted; `nbf` is honored.
  - `aud` may be an array.
  - `v` must be an integer, and `true` is not one.
- **Passwords:**
  - The hash format is `scrypt$<32 hex salt>$<128 hex>`.
  - The scrypt salt is the hex **text** as UTF-8, with N=32768, r=8, p=3 and dkLen=64. Python
    needs `maxmem=64 MiB`.
  - Lengths count UTF-16 units, and there is no Unicode normalization.
- **Emails:**
  - Normalization is JavaScript `trim()` + `toLowerCase()`: `İ` becomes `i̇`. U+FEFF is trimmed;
    U+0085 and U+001F are not.
  - Validation uses the JavaScript regular-expression `\s`: NBSP and U+2028 count as whitespace;
    U+200B and U+0085 do not. Go's `\s` is ASCII-only and Python's differs, so port the exact sets.
  - Auth methods never normalize; only the HTTP endpoints do.
- **Codes:** codes are `^\d{6}$` with ASCII digits only. Python must use `re.ASCII` or `[0-9]`.
- **HMAC keys:** CHALLENGE, RATE and code hashes are `hex(HMAC-SHA256(secret, text))`. The texts
  are `"<purpose>:<email>"`, `"<purpose>:<email>:<code>"`, `"<key>:<floor(ms/60000)>"` and
  `"email-change:<id>[:<email>:<code>]"`.
- **Vault:** the key is `SHA-256("rt-app-auth-vault:" + secret)`, the cipher is AES-256-GCM, and
  the stored value is `base64url_nopad(iv12 || tag16 || ciphertext)` of compact JSON. The
  contracts include values sealed with fixed IVs.
