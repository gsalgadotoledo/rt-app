# Analytics: contract and ports

Contract: `spec/contracts/analytics.contract.yaml`. Node host: `spec/hosts/node/monitoring.mjs`.
Analytics has no endpoints and no storage, so there is no HTTP contract: it validates the event name
and delegates to the Observer under the log context `{category: "analytics"}`.

| Language | Constructor | Methods | Observer it needs |
| --- | --- | --- | --- |
| TypeScript | `new Analytics(observer)` | `track(name, properties = {}, source = "app")`, `pageView(title, options)` | `Observer` |
| Python | `Analytics(observer)` | `track(name, properties=None, source=None)`, `page_view(title, options)` | `AnalyticsObserver` protocol: `with_context(ctx, fn)`, `emit(...)`, `count_view(message, options)` |
| Go | `analytics.New(observer)` | `Track(ctx, name, properties, source)`, `PageView(ctx, title, View)` | `analytics.Observer`: `WithContext(ctx, fields) context.Context`, `Emit(ctx, …)`, `CountView(ctx, message, View)` |

The interfaces use plain types (strings, maps), so an Observer port satisfies them directly or with a
three-method adapter. In Go the log context travels in `context.Context`.

## Subject

`analytics` (`init` ignored). The observer is a spy that records every call with the context active
at that moment. Methods: `track(name, properties?, source?)` → null, `pageView(title, options)` →
null, `calls()` → `[{method: "emit", level, kind, source, message, data, context} |
{method: "countView", message, options, context}]`.

## Semantics ports must copy

- Names match `^[a-zA-Z][a-zA-Z0-9._-]{0,79}$`: ASCII only, no case folding (U+212A is not `K`),
  `$` is the end of the string (Python: `fullmatch`; Go: `^…$` without `(?m)`). Non-strings are
  invalid. Error: plain (no status) `Use a stable analytics event name`, and nothing is emitted.
- `track` → `emit("info", "analytics", source, name, properties)`; missing properties are `{}` and a
  missing source is `"app"` (Go: `nil` properties and `""` source take the defaults).
- `pageView` → `countView(title, options)` with the options unchanged; the Observer validates the
  URL and defaults `source` to `"spa"`.
- Properties and sources are passed through unchanged: redaction belongs to the Observer contract.

TypeScript change: `track` now rejects non-string names; before, `String()` coercion accepted
`undefined`, `null` and `["ok"]` as the names "undefined", "null" and "ok".
