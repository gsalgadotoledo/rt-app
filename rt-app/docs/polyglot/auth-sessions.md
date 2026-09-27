# Refresh sessions: contracts and ports

Contracts: `spec/contracts/auth-sessions.contract.yaml` (module, subject `auth`) and
`auth-sessions-api.contract.yaml` (HTTP), plus the `sid` cases at the end of `jwt.contract.yaml`
and the updated session shape in `auth.contract.yaml`. Node host: `spec/hosts/node/identity.mjs`.
The contract descriptions hold the full algorithm; this page explains the design and lists what a
port must expose. TypeScript is the reference (`packages/auth/src/sessions.ts`, `index.ts`).

## Design in one paragraph

Access tokens stay 15-minute HS256 JWTs. Every sign-in also starts a **session**: an opaque refresh
token `<sessionId>.<secret>` that lasts at most 4 days from sign-in (absolute, never extended).
`POST /auth/refresh` rotates the secret and returns a new access token for the same session. The
database stores only an HMAC of the current and the previous secret. The previous secret is
accepted again for 30 seconds (two tabs refreshing at once); any other old or unknown secret for a
live session is treated as theft and revokes the session. Refresh re-reads the user every time, so
deactivation, role/grant changes, password reset, MFA changes and "log out everywhere" (all of which
bump `tokenVersion`) end every session at once. Access tokens carry `sid`; `actor()` reads the
session row (one read) so a revoked or expired session also cuts its access tokens immediately.
Tokens without `sid` (issued before this change, or by the admin installer) work exactly as before.

## Wire formats

| Item | Format |
| --- | --- |
| Session id | `base64url_nopad(16 random bytes)`, 22 characters |
| Secret | `base64url_nopad(32 random bytes)`, 43 characters |
| Refresh token | `<sessionId>.<secret>`; must match `^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$` (no padding, no `+/`) |
| Secret hash | `hex(HMAC-SHA256(utf8(app secret), utf8("refresh:<sessionId>:<secret>")))`, compared in constant time |
| JWT payload | `{"v","sid","sub","iss","aud","iat","exp"}` in that order when a session id is given; without it the token is byte-identical to before |
| Session response | `{token, expiresIn: 900, refreshToken, refreshExpiresAt, sessionId, user}` |
| `refreshExpiresAt` | ISO 8601 with milliseconds and `Z` (JavaScript `toISOString`) |

`jwt.verify` returns `{id, version, sid}` when a `sid` claim is present; a `sid` that is present but
not a non-empty string (a number, `""`, `null`) is 401 `Invalid or expired session`. `issue` ignores
a missing, `null` or empty `sid`.

## Rows (shared database)

Two rows are written in **one transaction**, both with `expected: null`, both with
`ttl = floor(expiresAt / 1000)`:

```text
SESSION / <sessionId>             {userId}
SESSIONS#<userId> / <sessionId>   {userId, provider, tokenVersion, secretHash, previousHash,
                                   rotatedAt, createdAt, lastUsedAt, expiresAt,
                                   revokedAt, revokedReason, ip, userAgent}
```

- The pointer (`SESSION`) never changes; refresh tokens only contain the session id, so refresh
  reads the pointer and then the session (2 reads). `actor()` knows `sub` and `sid`, so it reads the
  session row directly (1 read). Listing a user's sessions is one partition query.
- Times are epoch milliseconds (integers). `rotatedAt` starts at `createdAt`; `previousHash`,
  `revokedAt` and `revokedReason` start as `null`.
- `provider` is the credential provider at sign-in: `"local"`, the identity provider id
  (`"cognito"`), or `"admin:<16 hex>"` for the admin root (below).
- `revokedReason`: `"logout"` (current-session logout), `"revoked"` (DELETE /auth/sessions/:id),
  `"reuse"` (theft detection), `"ban"` (account ban, after its `tokenVersion` bump; see
  `users-bans.md`). Expiry and other `tokenVersion` changes write nothing.
- `ip` / `userAgent`: strings only; remove every character outside U+0020–U+007E, then keep the first
  64 / 200 characters; an empty result is `null`. They are informational, never authorization.
- Every update is `version + 1` with `expected = version read`.

## Algorithms

**Live** means `revokedAt == null && now < expiresAt` (`expiresAt <= now` is expired — the same
boundary rule as JWT `exp`).

**refresh(refreshToken, ip)**, in this order:

1. `limit("refresh-ip:<ip>", 60)` — before looking at the token.
2. Format check → 401.
3. `limit("refresh-session:<sessionId>", 10)`.
4. Pointer, then session row; missing → 401. Not live → 401.
5. The user must exist, be active, have `tokenVersion == session.tokenVersion` and a
   `credentialProvider` (default `"local"`) equal to `session.provider`, which must equal the running
   provider. Otherwise 401 and **nothing is written** (the user is checked before the secret).
6. Compare the hash:
   - equals `secretHash` → rotation: `previousHash = secretHash`, `rotatedAt = now`;
   - equals `previousHash` and `now - rotatedAt <= 30000` → grace: `previousHash` and `rotatedAt`
     stay (the grace window is measured from the last *normal* rotation, inclusive);
   - otherwise → `revokedAt = now`, `revokedReason = "reuse"`, then 401.
7. New secret: `secretHash = hash(new)`, `lastUsedAt = now`, version-guarded write. On a version
   conflict go back to step 4 (4 attempts in total), then 409 `Conflict: refresh and try again`.
   Two tabs sending the same token at once: one wins the write, the other re-reads, lands in the
   grace branch and also succeeds. Whichever wrote last holds the current secret; the other tab's
   new token is now "older" and is theft if used — clients share rotations between tabs (below).
8. Respond with the same `sessionId` and `refreshExpiresAt`.

Every refresh failure is 401 with the single message **`Invalid session`** (no detail leaks). The
one exception is a banned account: right after step 4 (before liveness), when the user is active and
banned, refresh answers 403 `Account suspended` to whoever presents the session's current or
previous secret and 401 to anyone else, writing nothing (`docs/polyglot/users-bans.md`).

**actor(header)**: unchanged for tokens without `sid`. With `sid`: after the existing user checks,
read `SESSIONS#<sub>/<sid>`; not live → 401 `Invalid session`; the actor gets `sessionId`.

**sessions(userId, current)** → `{items}`: rows of `SESSIONS#<userId>` (all pages) that are live and
whose `tokenVersion` and `provider` equal the user's current ones. Order: `createdAt` descending,
then id ascending (code points). Item: `{id, createdAt, lastUsedAt, expiresAt (ISO), current, ip,
userAgent}`.

**revokeSession(userId, id)**: 404 `Session not found` unless the row exists, is live and has the
user's current `tokenVersion` (ids that are not strings or longer than 100 UTF-16 units are never
looked up) → `revokedAt = now`, `revokedReason = "revoked"` → `{ok: true}`.

**logout(userId, sessionId, all)**: `all === true` (the JSON boolean) **or** no `sessionId` → the old
behavior (identity provider logout, then `tokenVersion + 1`). Otherwise revoke the current session
(`"logout"`; nothing written when it is already dead) → `{ok: true}`.

## HTTP

| Method | Path | Access | Body | Result |
| --- | --- | --- | --- | --- |
| POST | `/auth/refresh` | guest | `{refreshToken}` | session response |
| GET | `/auth/sessions` | authenticated | – | `{items}` (current = the calling token's `sid`) |
| DELETE | `/auth/sessions/:id` | authenticated | – | `{ok: true}` or 404 |
| POST | `/auth/logout` | authenticated | `{all?: true}` | `{ok: true}` |

`GET /auth/methods` reports `refreshTokens: true`. `login`, `code/verify`, `mfa/verify` and
`email-change/verify` pass the `User-Agent` header (when it is one string) to the session.

## Facade (subject `auth`)

`init` gains optional `sessionTtlMs` (default 345600000). Changed and new methods:

| Method | Notes |
| --- | --- |
| `login(email, password, ip, userAgent?)` | trailing optional argument |
| `consume(email, code, purpose, ip, password?, challengeId?, userAgent?)` | |
| `verifyMfa(challengeId, code, ip, userAgent?)` | |
| `confirmEmailChange(id, code, ip, userAgent?)` | |
| `refresh(refreshToken, ip)` | |
| `sessions(userId, currentSessionId?)` | |
| `revokeSession(userId, sessionId)` | |
| `logout(userId, sessionId?, all?)` | |

The runner gained a `$concat` macro (`{$concat: ["Bearer ", {$ref: "0.value.token"}]}`) and HTTP
header values accept `{{N.body.field}}` like paths do; both are expanded by the runner only.

## Admin root (TypeScript only for now)

`AdminIdentity(verifier, secret, localAccess, store?)`: with a store (the framework passes the
application store) root sign-in also returns a refresh session under `SESSIONS#rt-app-root`, with
`provider = "admin:" + hex(HMAC-SHA256(secret, "rt-app:root-sessions:" + verifier))[0:16]`, so a new
`ADMIN_PASSWORD` ends every root session. `POST /admin/identity/auth/refresh` (limits
`admin-refresh-ip:<ip>` 30, `admin-refresh-session:<id>` 10) and `POST /admin/identity/auth/logout`
(revokes the current root session). Root access tokens carry `sid` and are checked against the row.
Without a store (the local installer) root tokens stay stateless 15-minute tokens. Python and Go do
not serve `/admin/identity/*` yet; port this together with that endpoint.

## Not in the contract

Client behavior (see `docs/authentication.md`), the admin root flow, and concurrency beyond the
conflict retry are covered by TypeScript unit tests (`packages/auth/tests/sessions.test.mjs`,
`client.test.mjs`, `admin/tests/identity.test.mjs`).
