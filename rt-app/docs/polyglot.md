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
- **Owner and permission endpoints** are mounted under `/admin/app<path>` only.
  - In local mode (`local_admin`) the actor is `{id: "rt-app-root", role: "owner"}`.
  - Without an actor they return 401 `Sign in` (the TypeScript ACL message).
- **Adapters:**
  - Bodies must be JSON objects: 400 `Invalid JSON`.
  - The body limit is 16 KiB: 413 `Request body too large`.
  - Responses are JSON with `cache-control: no-store`.

## Plan (MVP)

1. Done: `npm run link:app` / `unlink:app` use the local core in an app without publishing.
2. Done: `rt-app-conformance` with the contract format, host protocol, runner, `--record` and
   `show`.
3. Done: contracts for `nosql-memory`, `feature-flags` and `feature-flags-api`. The TypeScript
   reference passes all 38 cases. The contract also found that MemoryStore sorted by UTF-16 units,
   which is now fixed.
4. Python: `rt_app` (errors, nosql MemoryStore, feature_flags, health, web with server, Lambda
   and CLI, conformance host), plus `examples/flags-api/python`.
5. Go: the same packages in `core-go`, plus `cmd/contract-host` and `examples/flags-api/go`.
6. Run `npm run contracts` on every target: node, python, python-lambda, go and go-lambda.
7. Next steps:
   - more modules (users, auth, subscriptions ledger)
   - DynamoDB and Postgres stores for Python and Go
   - generator backends that use native modules instead of proxying to the Node core
   - a Service Manager "Contracts" panel
