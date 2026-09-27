# Observer and its outputs: contracts and ports

Contracts: `spec/contracts/observer.contract.yaml` (pipeline, storage, reports, log search,
endpoints), `observer-rules.contract.yaml` (redaction, URL paths, log queries),
`observer-api.contract.yaml` (HTTP), and one per output: `observer-console`, `observer-webhook`,
`observer-slack`, `observer-email` (SES and the local mail viewer) and `observer-sms`. Node host:
`spec/hosts/node/observer.mjs`. The contract descriptions hold the full algorithms. Cloud outputs
(CloudWatch, Datadog, Sentry) are not ported; they only need the output interface below.

| Language | Observer | Storage and endpoints | Outputs |
| --- | --- | --- | --- |
| TypeScript | `new Observer(outputs, timeoutMs?, {now, newId})` | `new ObserverStore(store, {now})`, `observerFeature(observer, storage, logs?, {now})` | `ConsoleOutput(sink?)`, `WebhookOutput(id, url, headers, fetch)`, `SlackOutput(url, fetch)`, `EmailOutput(from, to, client)`, `LocalEmailOutput(from, to, port)`, `SmsOutput(phone, client)` |
| Python `rt_app.observer` | `Observer([Output(handler, …)], timeout_ms=1500, *, now, new_id)` | `ObserverStore(store, *, now)`, `observer_feature(observer, storage, logs=None, *, now)` | `console.ConsoleOutput(sink)`, `webhook.WebhookOutput(id, url, headers, transport)`, `slack.SlackOutput(url, transport)`, `email.EmailOutput(from_, to, client)`, `email.LocalEmailOutput(from_, to, port, *, send, production)`, `sms.SmsOutput(phone, client)` |
| Go `rt.local/core-go/observer` | `observer.New([]Output, WithTimeout, WithClock, WithIDs)` | `observer.NewStore(db, now)`, `observer.Feature(o, storage, logs, now)` | `console.New(sink)`, `webhook.New(id, url, headers, transport)`, `slack.New(url, transport)`, `email.New(from, to, client)`, `email.NewLocal(from, to, port, WithSender, WithProduction)`, `sms.New(phone, client)` |

- **Output interface.** TypeScript `{id, write(event, signal)}`; Python any object with `id` and
  `write(event, signal)` (`signal` is a `threading.Event` set on timeout; awaitables are run);
  Go `observer.Handler` (`ID()`, `Write(ctx, Event) error`; ctx is cancelled on timeout). A
  subscription adds `enabled`, `levels`, `kinds`, `sources`, `categories`, `filter` and
  `maxPerMinute` (Go: `Disabled`, nil lists mean "all", `MaxPerMinute *int`).
- **Methods.** `emit`, `write`, `log`/`info`/`debug`/`warn`/`warning`/`error`, `countView`,
  `recordRequest`, `measure` (Go: generic `observer.Measure(ctx, o, name, source, op)`),
  `withContext` (Go: returns a `context.Context`), `health` (Go: `Health()`). Python and Go
  satisfy the Analytics observer interfaces directly.
- **Transports are injected.** HTTP outputs take `transport(request, signal) → status`
  (Python) / `observer.Transport` (Go); the defaults (urllib / `net/http`, 10 s timeout) never
  follow redirects. SES and SNS clients are boto3 clients created on first use (Python) or small
  interfaces to adapt the AWS SDK (Go `email.Client`, `sms.Client`); the local mail viewer
  sender is smtplib / `net/smtp` to 127.0.0.1 only.

TypeScript gained backward-compatible options so contracts can pin time and ids: the Observer,
ObserverStore and observerFeature take `{now}` (epoch ms or Date; the Observer also takes `newId`,
and uses `now` for `measure` durations when given), and `ConsoleOutput` takes an optional sink.

## Subjects

- `observer`: `init {now, ids?, timeoutMs?, outputs?, rows?}`. Outputs are scripted (`behavior`
  ok/fail/hang/slow/mutate, `filter` {messageIncludes}/{throws}/{mutates}) or `type: store` (the
  ObserverStore over a memory store holding `rows`). Helpers: `withContext(context, steps)`,
  `parallel(branches)`, `burst(count, level, message)` (concurrent), `emitMany` (sequential),
  `delivered(id)`, `aborted(id)`, `setBehavior`, `health`, `setNow`, `measure(name, {value, fail,
  advanceMs})`, plus the storage (`search`, `storeReport`, `storeWrite`, `list`) and endpoint
  handlers (`report`, `logs`, `ingest(body, ip)`, `ingestEach`, `endpoints`, `admin`).
- `observer-rules`: `sanitize`, `safePath`, `validateLogQuery`, `matchesLog`.
- Output subjects take their configuration and a fake transport in `init` (`status`, `fail`) and
  expose `requests()` / `sent()` / `lines()`.

## Semantics ports must copy

- **Events:** `{category: "app", id, at, level, kind, source, message, data}` then the context's
  string `category`/`requestId`/`sessionId`. Source cut to 80 UTF-16 units, context values
  sanitized and cut to 120, `at` is `toISOString()` of the injected clock. Nothing is built (no id
  used) when no output is enabled; 32 emits in flight at most (then `dropped`).
- **Delivery, per output in order:** subscription lists (sources before truncation), then the
  filter on a deep copy (a throw is `failed`), then the budget of the clock minute
  `floor(ms / 60000)` (default 600, 0 drops all; filtered events use none), then the write on its
  own deep copy with the timeout (a throw or the timeout is `failed`). Writes run in parallel and
  a write that ended in time counts even while an earlier output was awaited. Errors never reach
  the caller.
- **Redaction:** JavaScript regular expressions with `/i` but no `/u`: only ASCII letters fold
  (U+017F and U+212A are not s and k) and `\s` is the JavaScript set (NBSP, U+2028 and U+FEFF
  are whitespace, U+200B is not). Python uses `re.IGNORECASE | re.ASCII` with explicit classes;
  Go spells `[Bb][Ee]…` because `(?i)` folds Unicode. Strings are cut to 1000 units before redaction; order: bearer, e-mail,
  key-value. Secret keys match anywhere in the key (`zip`, `description`, `barcode`).
- **Object order:** objects keep 30 keys in JavaScript property order (array-index keys first,
  ascending). JSON text (console lines, webhook bodies, pretty e-mail text) uses the same order and
  JSON.stringify escapes and numbers (`1e-7`, integers without `.0`, `<&>` and U+2028 unescaped).
- **URLs:** `safePath` and the HTTP outputs use the WHATWG URL parser, not the language's URL
  library: `rt_app/observer/_url.py` and `core-go/observer/internal/whatwg` implement the needed
  part (special schemes, IPv4/IPv6 hosts, ports, dot segments, percent-encode sets with `^` in the
  path set like Node 24). They were checked against Node on 20 000 generated inputs. Destinations
  are sent to the serialized `href` (lowercase host, default port removed).
- **Reports:** JavaScript `Number()` and `String()` of stored fields (missing fields read
  `"undefined"`), `Math.round` halves up (0.125 ms → 0.13; Python `round` and Go
  `math.RoundToEven` differ), stable sorts, events newest first by code point order of `at`
  (TypeScript `localeCompare` gives the same order for ISO timestamps), expired rows (truthy
  `ttl <= now / 1000`) skipped. Days are real proleptic Gregorian dates (year 0000 included).
- **Page events:** the message is checked first (present, even null, must be a string of ≤ 200
  units), then source and path; the rate limit comes after validation: 60 per client per clock
  minute keyed `sha256hex(ip ?? "unknown")`, 4000 clients, older minutes purged above 2000.

## Differences left by the language

- **Go maps have no insertion order.** Non-index keys are ordered by UTF-16 code units, so when an
  object has more than 30 keys Go may keep other keys than TypeScript, and data keys in JSON text
  are sorted. Contracts give keys in code point order. Stored events are read back in event key
  order for the text search.
- **Go strings cannot hold lone surrogates.** A cut that would split a surrogate pair drops the
  pair (JavaScript keeps its high half); the contracts avoid such cuts.
- **Go typed fields.** Log context values are strings (non-string values cannot be set), an empty
  `Category`/`RequestID` means "absent" for the Slack text, an empty `View.Source` is `"spa"`,
  and `RequestMetric` uses numbers (the host maps wrong JSON types to `Invalid request metric`).
- **Hosts:** non-ASCII domains are lowercased and Punycode-encoded without the full UTS #46
  mapping; other schemes than http(s) are only checked roughly (they are refused anyway).
- **Python and Go are synchronous per call** (threads / goroutines per delivery). Measure durations
  use the injected clock, or `perf_counter` / a monotonic clock by default.

## Fixed in TypeScript

`POST /observer/events` accepted paths starting with `//` (they pass the path pattern), and
`safePath` then read them as a host: `//` answered 500 `Internal error` and `//evil.test/x`
recorded `/x`. Such paths are now 400 `Invalid page event` (test in `packages/observer/tests`,
pinned by both contracts).

## Example APIs

`examples/api/python/modules/observer.py` and `examples/api/go/observer.go` mount the feature with
an ObserverStore over the shared store. The web adapters do not record requests (that is the
framework's job in TypeScript), so the Python and Go reports show page views and whatever the
application logs. The TypeScript reference API (`spec/hosts/node-api.mjs`) runs with no outputs,
so `observer-api` only pins validation, mounting and empty past days.
