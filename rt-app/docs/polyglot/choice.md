# Choice in every language

Contracts: `spec/contracts/choice.contract.yaml`, `choice-jev.contract.yaml` and
`choice-transformers.contract.yaml` (module) and `choice-api.contract.yaml` (HTTP, local mode).
Hosts: `spec/hosts/node/choice.mjs`, `spec/hosts/python/choice.py`,
`core-go/cmd/contract-host/choice.go`. Ports: `rt_app.choice` (+ `.jev`, `.transformers`) in
Python and `rt.local/core-go/choice` (+ `/jev`, `/transformers`) in Go. The contract descriptions
hold the full rules; this page lists what a port exposes and the details that are easy to get wrong.

## Surface

| | TypeScript | Python | Go |
| --- | --- | --- | --- |
| Validate | `validateChoice(input)` | `validate_choice(input)` → dict | `choice.Validate(input)` → `choice.Input` |
| Decide | `new Choice(p).decide(input, policy?, signal?)` | `Choice(p).decide(input, policy=None, signal=None)` | `choice.New(p).Decide(ctx, input, choice.Policy{})` |
| Provider | `{id, predict(input, signal?)}` | `id` + `predict(snapshot, signal=None)` → dict | `ID()` + `Predict(ctx, choice.Input)` → `choice.Prediction` |
| Cancel | `AbortSignal` | any `is_set()` object (`threading.Event`) | `ctx` (`*choice.AbortError` wraps `ctx.Err()`) |
| Jev | `new JevProvider(key, model?, fetch?, timeoutMs?)` | `JevProvider(key, model, transport, timeout_ms)` | `jev.New(key, WithModel, WithClient, WithTimeout)` |
| Transformers | `new TransformersChoiceProvider(pipeline, model)` | same; `pipeline(text, labels, multi_label=False)` (Hugging Face signature) | `transformers.New(zeroShot, model)` |
| Endpoint | `choice.feature()` | `Choice.feature()` (`explicit_grant=True`, `tool`) | `Choice.Feature()` + `choice.ExplicitGrant`, `choice.Tool` |

`POST /choice/decide` (resource `choice.decide`, access `permission`, explicit grant) decides the
body with the default policy. TypeScript mounts it only when the app has a provider; the reference
API (`spec/hosts/node-api.mjs`) and both example APIs use the same deterministic *local* provider:
a context object with a `prediction` field is the provider answer (`"fail"` throws), otherwise
every option gets `1/n` as uncalibrated scores, so the decision abstains. Never use it in
production.

## Contract subjects

- **`choice`**: `init: {prediction, error?, id?}` builds a fake provider. Methods:
  `validateChoice(input)`, `decide(input, policy?)`, `decideAborted(input, policy, "before" |
  "during")`, `calls()` (snapshots the provider received), `feature()` (`{id, migrations,
  endpoints:[{method, path, resource, access, explicitGrant, tool}]}`) and `handle(body)`.
- **`choice-jev`**: `init: {apiKey, model?, timeoutMs?, responses}`; each response is `{status,
  json}`, `{status, text}` or `{error}`. Methods: `id()`, `predict(input)`, `decide(input,
  policy?)`, `requests()` → `[{url, method, headers, body, text}]` (headers lowercased).
  Construction errors are pinned with `create:`.
- **`choice-transformers`**: `init: {model, results}`; each result is `{labels, scores}`, `null`
  or `{error}`. Methods: `id()`, `predict(input)`, `predictAborted(input, when)`, `decide(input,
  policy?)`, `calls()` → `[{text, labels, options: {multi_label: false}}]`.

Wire `null` means "not given" for optional arguments (policy, model, timeoutMs). Inside objects
`null` is a value: an option `description: null` and a provider `confidence: null` are invalid.

## Semantics ports must copy

- **Validation order** (first failure wins, all 400): question/options shape → options (object,
  id `^[a-zA-Z0-9_-]{1,80}$` ASCII with no trailing newline, description absent or a string of at
  most 2000 UTF-16 units, unique case-sensitive ids) → size. Python must not use `$` (it matches
  before a trailing newline); Go's `$` is fine. Blank uses JavaScript `trim()` (NBSP, U+FEFF and
  U+2028 are blank; U+200B, U+0085 and U+001C are not).
- **Size**: UTF-8 bytes of the canonical JSON (`canonical` of rt-app-cache: keys sorted by UTF-16
  code units, JavaScript number text such as `1e+21` and `100`, JSON escapes such as `\n` and
  `\u0001`) must be at most 128000. The HTTP body limit (16 KiB, 413) is hit first over HTTP.
- **Snapshot order**: `JSON.parse(canonical(input))` puts array-index keys (`"0"` …
  `"4294967294"`) first in numeric order, then the rest in UTF-16 order (U+1F600 before U+FF01).
  This order is visible in the Jev body and the classifier text, so both ports write JSON with
  their own writer (`rt_app/choice/_json.py`, `core-go/choice/internal/jsjson`): only `"`, `\` and
  control characters are escaped; U+2028, DEL and `<>&` stay raw (Go's `encoding/json` would
  escape them).
- **Decision**: thresholds default with `??` (null and missing), a non-object policy is `{}`,
  `allowUncalibrated` must be exactly `true`. The sum of probabilities is float64 addition in
  option order, tolerance `> 0.001` (so `0.5 + 0.499` is invalid). Ranking is a stable sort by
  probability descending (ties keep option order); `accepted` also needs `top > second`, and
  `top - second >= minMargin` is float64 subtraction (`0.5 - 0.4 < 0.1`).
- **Errors**: `Invalid choice provider response`, `Invalid Jev response`, `Jev request failed:
  HTTP <status>`, `Invalid classifier response`, `This operation was aborted` and `Invalid Jev
  configuration` carry no status (500 over HTTP, message hidden). Provider errors propagate
  unchanged. Response bodies are never echoed.
- **Jev body**: `{"model","state","questions":{"decision":{"type":"choice","instructions",
  "criteria"}}}`; `state` is left out without a context; criteria are `description ?? null`
  (an empty description stays `""`) with array-index ids first. The key is not trimmed.
- **Classifier text**: `question + "\n\n" + JSON.stringify(context)`, `undefined` without a
  context. Labels are `id` or `id: description` (non-empty description).

## Language notes

- **Typed Go providers.** A Go `Prediction` cannot hold a string probability or a null
  confidence, so `choice.ParsePrediction` turns loosely typed JSON answers (Jev bodies, the local
  provider) into `ErrInvalidResponse`, the error the reference ends with in `Choice.decide`. As a
  consequence Go's `jev.Provider.Predict` fails early where TypeScript returns the loose answer;
  the contracts pin those cases through `decide` only. The Go host's fake pipeline does the same
  for non-string labels (`Invalid classifier response`) and maps non-number scores to NaN.
- **Extra fields.** TypeScript and Python keep unknown input fields in the snapshot and spread
  unknown provider fields into the decision; Go drops them. Not part of the contract.
- **Probabilities as an array** (`[0.9, 0.1]` with ids `"0"`, `"1"`) are accepted like
  JavaScript `Object.keys`; Go returns them as an object.
- **Lone surrogates.** Python keeps and escapes them like JavaScript. Go's `encoding/json`
  replaces them with U+FFFD when decoding, so they are not pinned.
- **Transports.** TypeScript uses `fetch` with `redirect: "error"` and `AbortSignal.timeout`.
  Python's default `urllib_transport` refuses redirects and uses `timeout_ms` as the socket
  timeout; Go's default client refuses redirects and applies a context deadline (a timeout is
  `*choice.AbortError` "The operation was aborted due to timeout").
- **Web layers (shared, pending).** Go's `web.Endpoint` has no explicit-grant or tool fields, so
  `choice.ExplicitGrant`/`choice.Tool` carry them and a Go owner session can call the non-admin
  route. Python's `rt_app.web` applies `explicit_grant` under `/admin/app` too (TypeScript's admin
  mount only requires the local root), so the example module clears the flag on that mount.
