# Service keys: contracts and ports

Contracts: `spec/contracts/service-keys.contract.yaml` (module, subject `serviceKeys`) and
`subscriptions-service-keys-api.contract.yaml` (HTTP; the file sorts after `subscriptions-api`
because HTTP contracts share one server per target and that contract pins an overview without
customers). Reference: `packages/auth/src/service-keys.ts` and the dispatch in `src/index.ts`.
Ports: `rt_app.service_keys` (Python) and `rt.local/core-go/servicekeys` (Go). User guide:
`docs/authentication.md` "Service keys".

## Why

The consumer (an agent server metering credits, `remote-os-white-label` N3) used the admin root
password to reach the owner metering endpoints. That credential can also manage users, settings
and plans. A service key can only call `access: "service"` endpoints in its scopes, is rotated
and revoked without touching `ADMIN_PASSWORD`, and is rate limited and audited per key.

## Design

- **One prefix, one credential.** Service endpoints are declared with `access: "service"` and a
  path under `/service/`; the framework refuses to start when a service endpoint lives elsewhere
  or another endpoint uses `/service/`. They are never mounted under `/admin/app`, so local admin
  mode never opens them. The actor of a service endpoint comes only from the service key; the
  JWT and admin authenticators never accept a key (and a key never matches a JWT).
- **Scopes are endpoint resources.** A key holds a list of resources; the framework derives the
  valid scopes from the service endpoints (sorted). Adding a service endpoint with a new resource
  creates a new scope; nothing else is ever reachable.
- **Stored hash only.** `sha256hex(utf8("rtsk_<id>.<secret>"))`. The secrets are 256 random bits,
  so a plain SHA-256 is enough (no password hashing) and operators can compute it with `shasum`
  for configured keys. The hash covers the id: a secret moved to another id fails.
- **Constant-time check.** The presented token is hashed and compared with the stored hash (or 64
  zeros when the id is unknown) with `timingSafeEqual` / `hmac.compare_digest` /
  `subtle.ConstantTimeCompare`. Unknown, wrong and revoked keys give the same 401.
- **Revocation is immediate.** Every request reads the key row (one read), so a revoked or
  rotated key fails on its next request. The last use lives in a separate row
  (`SERVICE_KEY_USE`), so usage writes never conflict with admin writes.

## Wire formats and rows

| Item | Format |
| --- | --- |
| Token | `rtsk_<id>.<secret>`, `^rtsk_([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{32,128})$` |
| Generated id / secret | `base64url_nopad(9 random bytes)` (12 chars) / `base64url_nopad(32 random bytes)` (43 chars) |
| Header | `Authorization: Bearer <token>` (exactly one space; anything else is 401 `Invalid service key`) |
| Actor | `{id: "service:<id>", role: "service", grants: scopes, email: "", name: description or id, tokenVersion: 0, active: true}` |
| Rate limit | auth `RATE` row of `"service-key:<id>"`, `rateLimit` per minute (default 600, 1..100000) |

```text
SERVICE_KEYS / <id>                  {id, description, scopes, rateLimit, secretHash, source: "admin",
                                      createdAt, createdBy, rotatedAt, revokedAt, revokedBy}
SERVICE_KEY_USE / <id>               {lastUsedAt}          written when missing or >= 60 s old
SERVICE_KEY_AUDIT#<id> / pad15(at)-pad10(version)
                                     {keyId, action: create|rotate|revoke, actorId, at, scopes?, rateLimit?}
```

Configured keys (`RT_APP_SERVICE_KEYS` JSON, or the file named by `RT_APP_SERVICE_KEYS_FILE`):
`[{id, secretHash | secret, scopes, description?, rateLimit?}]`; `secret` is the secret part and
is hashed at startup. They have no `SERVICE_KEYS` row (only `SERVICE_KEY_USE`), are listed with
`source: "env"` and are rotated or revoked in the configuration (409 from the admin endpoints).

## Algorithms

`actor(authorization)`, in order: missing → 401 `Service key required`; not `Bearer ` + a valid
token → 401 `Invalid service key`; key lookup (configured first, then the row); hash compare;
unknown, different or revoked → 401 `Invalid service key`; per-key limit (429); last use; actor.
`check(endpoint, actor)`: access not `service` → 403; no service actor → 401 `Service key
required`; resource not in grants → 403 `Service key not allowed for this resource`.

`create`, `rotate`, `revoke`, `list` and the validation order: see the contract description.

## HTTP

| Method | Path | Access | Result |
| --- | --- | --- | --- |
| GET | `/admin/app/service-keys` | owner, admin only | `{items, scopes}` (never secrets) |
| POST | `/admin/app/service-keys` | owner, admin only | `{key, token}` (the only time the token is returned) |
| POST | `/admin/app/service-keys/:id/rotate` | owner, admin only | `{key, token}` |
| POST | `/admin/app/service-keys/:id/revoke` | owner, admin only | `{key}` |
| GET | `/service/keys/self` | service, `service-keys.self` | `{id, description, scopes, rateLimit}` |

The metering endpoints (`/service/subscriptions/accounts/:id/*`, scope `subscriptions.meter`) are
listed in `docs/authentication.md`.

## Ports

| | TypeScript | Python | Go |
| --- | --- | --- | --- |
| Service | `new ServiceKeys(store, secret, {keys, scopes, now?, random?})` | `ServiceKeys(store, secret, keys=, scopes=, now=, random=)` | `servicekeys.New(store, secret, keys, scopes, WithClock, WithRandom)` |
| Validate at startup | `validate()` | `validate()` | `New` returns the error |
| From env | `serviceKeysFromEnv(env)` | `service_keys_from_env(env)` | `servicekeys.FromEnv(getenv)` (nil: `os.Getenv`) |
| Web | framework dispatch (`access: "service"`) | `App(..., service=policy)` | `web.WithServiceKeys(policy)` |

What ports get wrong most often: the `Bearer ` prefix is case-sensitive with one space; the
compare must hash first and compare fixed-length digests; failures never write the last use;
the scopes list is sorted in the example APIs (TypeScript derives it from the endpoints).

## Facade (subject `serviceKeys`)

`init: {now?, secret, keys?, scopes, rows?}`. Random bytes are deterministic (call n returns
`bytes` bytes of value n % 256), so generated ids and tokens match across languages. Methods:
`parse(config, scopes)`, `list`, `create`, `rotate`, `revoke`, `actor`, `check`, `authorize`
(actor then check), `self(actor)`, `hash(token)`, `audit(id)`, `row(pk, sk)`, `setNow(iso)`,
`endpoints()`, `admin()`.
