# Microservices: contract and ports

Contract: `spec/contracts/microservices.contract.yaml`. Reference:
`packages/microservices/src/index.ts` (`createMicroservice`, `SessionAuthenticator`,
`SignedJwtAuthenticator`, `remoteJwtAuthenticator`, `remoteFeature`). The package hosts other
features and has no endpoints of its own, so there is no `kind: http` contract. Hosts:
`spec/hosts/node/microservices.mjs`, `spec/hosts/python/microservices.py`,
`core-go/cmd/contract-host/microservices.go`.

| | TypeScript | Python (`rt_app.microservices`) | Go (`rt.local/core-go/microservices`) |
| --- | --- | --- | --- |
| Service | `createMicroservice({features, authenticate, invokeMetered?, observe?})` → `handle(request)` | `Microservice(features, authenticate, invoke_metered=None, observe=None)` → `handle(request)` returns `web.Response` | `New(Options{Features, Authenticate, InvokeMetered, Observe})` → `Handle(ctx, web.Request) Response` |
| Metered endpoint | `endpoint.subscription` | `MeteredEndpoint(…, subscription=…)` (a `web.Endpoint`) | `Endpoint{web.Endpoint; Subscription any}`, `FromWeb(web.Feature)` |
| Session tokens | `new SessionAuthenticator(tokens, resolve)` | `SessionAuthenticator(tokens, resolve)` | `NewSessionAuthenticator(*jwt.Tokens, resolve)` |
| Service JWTs | `new SignedJwtAuthenticator(key, issuer, audience, resolve)` | `SignedJwtAuthenticator(jwks_or_key_fn, issuer, audience, resolve, now=None)` (needs `cryptography`) | `NewSignedJWTAuthenticator(KeySource, issuer, audience, resolve, WithClock)`, `ParseJWKS` |
| Remote JWKS | `remoteJwtAuthenticator(url, issuer, audience, resolve)` | `remote_jwt_authenticator(…, fetch=None)`, `RemoteJWKSet` | `NewRemoteJWTAuthenticator(…, WithJWKSClient)` |
| Forwarding | `remoteFeature(feature, baseUrl, transport?, timeoutMs?)` | `remote_feature(feature, base_url, transport=None, timeout_ms=10000)` | `RemoteFeature(f, baseURL, WithTransport, WithTimeout)`, `WithQueryOrder(ctx, keys)` |

Remote key sets behave like jose's `createRemoteJWKSet`: fetched lazily, cached for 10 minutes,
fetched again for an unknown key after a 30-second cooldown, 5-second timeout, redirects refused.

## TypeScript changes (backward compatible)

- `remoteFeature` refuses a route parameter equal to `.` or `..` with 400 `Invalid route parameter`.
  URL parsing removes those path segments, so `/x/:id` with `id = ".."` was forwarded to another
  remote route with the caller's authorization.
- `remoteFeature` requires `timeoutMs` to be an integer from 1 to 2147483647. A fractional value
  passed validation and then failed every call (`AbortSignal.timeout` RangeError), and larger values
  were silently replaced by 1 ms by Node timers.

## Subjects

| Subject | `init` | Methods |
| --- | --- | --- |
| `microservice` | `{features, tokens, metering?, observe?}` | `handle(request)`, `authentications()`, `observations()`, `metered()` |
| `session-authenticator` | `{secret, now, issuer?, audience?, actors}` | `authenticate(token)`, `issue(user)`, `resolved()`, `setNow(iso)` |
| `signed-jwt-authenticator` | `{jwks, issuer, audience, actors}` | `authenticate(token)`, `resolved()`, `remote(url, issuer, audience)` |
| `remote-feature` | `{feature, baseUrl, timeoutMs?, responses}` | `call(index, context)`, `requests()`, `feature()` |

- Endpoints are declared as data: `{method, path, access, resource, explicitGrant?, subscription?,
  reply?}`. `reply: {value}` returns it, `reply: {error: {status?, message}}` throws (an HTTP error
  when it has a status); without `reply` the handler echoes `{params, actor, headers}`.
- `tokens` maps a bearer token to an actor or `{error}`; unknown tokens fail with 401
  `Unknown token`. `metering` is absent (no adapter), `{}` (run the work) or `{error}`.
  `observe` is `record` (default), `fail` or `none`.
- Signed JWT cases use fixed RSA-2048, RSA-1024, P-256 and P-384 keys and tokens signed once
  (expiry in 2100), so they need no clock.
- The remote transport records `{url, method, headers, body, redirect, timeout}` and answers
  `{status, json}`, `{status, text}`, `{status}` or `{network: message}` in order.

## Semantics ports must copy

- **Routing:** endpoints in declaration order, the first match wins (no literal-over-parameter
  priority, unlike the application router). `:name` matches `[^/]+`, literal segments match
  exactly, one trailing `/` is allowed, methods compare exactly. The same method and path string
  twice fails when the service is built (`Duplicate service route`).
- **Order of checks:** route (404 `Not found`), authorization header, authenticator, access, then
  `decodeURIComponent` of parameters (400 `Invalid route encoding` on bad escapes, invalid or
  overlong UTF-8, encoded surrogates), metering, handler. A missing parameter check never hides a
  401.
- **Authorization header:** only a non-empty header is read. It must match
  `/^Bearer [^\s]+$/i` with the JavaScript `\s` set (NBSP and U+FEFF are whitespace, U+200B is
  not; no trailing newline), otherwise 401 `Invalid authorization`. The token is sent to the
  authenticator even for guest endpoints.
- **Access:** `guest` passes; otherwise a missing or inactive actor is 401 `Sign in`; `owner` needs
  the owner role (403 `Owner permission required`); `permission` needs the grant or, without
  `explicitGrant`, the owner role (403 `Permission required`); any other access value only needs
  an active actor.
- **Answers:** 200 with the handler value; HTTP errors keep status and message; anything else is
  500 `Internal error`. Every answer carries a new UUID v4 `x-request-id`, which also replaces the
  incoming header the handler sees. Other request headers (such as `x-user-id`) reach the handler
  but never decide the actor.
- **Metering:** any non-null `subscription` (even `{}`) needs `invokeMetered`, else 503
  `Metering adapter required`.
- **Telemetry:** `observe({requestId, route, status, durationMs})` after every request, route
  `/unmatched` for 404s; its failures are ignored.
- **Session tokens:** `JwtTokens.verify` (401 `Invalid or expired session`), then the resolver;
  a missing, other-id, inactive or other-`tokenVersion` actor is 401 `Invalid or revoked session`.
- **Service JWTs** (jose `jwtVerify` with a JWK Set): RS256 or ES256 only, one usable key
  (kty from alg, P-256 for ES256, matching `kid`, `alg`, `use: sig`, `key_ops` with `verify`,
  public keys, RSA ≥ 2048 bits), ES256 signatures as raw `r||s`, `crit` limited to `b64`,
  required `exp`, `iat`, `sub`, `iss`, `aud`; numeric dates; `exp <= now` and `nbf > now` refused,
  a future `iat` accepted. Every failure is 401 `Invalid service JWT`. The resolver receives the
  payload; `actor.id !== sub` (so `"5"` is not `5`) or an inactive actor is 401
  `Inactive service identity`.
- **Remote JWKS:** the URL must parse and be `https:` without user name or password
  (`JWKS requires HTTPS`), checked before issuer and audience. Keys are fetched from that URL only.
- **Remote features:** see the contract description for the URL, query, header and body rules.
  Only `content-type` and `authorization` are sent; non-2xx answers become
  `Remote service request failed` with the remote status and no body; 204 is null; redirects are
  errors.

## Known differences

- **Go maps have no order.** Forwarded query strings follow `WithQueryOrder(ctx, keys)` when given
  (the contract host passes the wire order); otherwise integer-like keys come first, then the
  others sorted. Forwarded bodies are rebuilt from `Request.Raw` when present, keeping key order;
  otherwise keys are sorted. Python dicts keep insertion order (integer-like keys first, like
  JavaScript property order).
- URL parsing in Python and Go covers the WHATWG subset the contract needs (no IDNA).
- The TypeScript `key` may also be a `CryptoKey`; Python takes a key function and Go a `KeyFunc`.
