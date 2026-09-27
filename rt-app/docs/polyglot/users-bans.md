# Account bans: contracts and ports

Contracts: `spec/contracts/users-bans.contract.yaml` (module, subject `userBans`, fixed clock) and
`users-bans-api.contract.yaml` (HTTP). Reference: `packages/users-bans/src/index.ts` (writes, history,
endpoints), `packages/users/src/suspension.ts` (row format and reader) and the gate in
`packages/auth/src/index.ts`. Ports: `rt_app.users_bans` + `rt_app.users` (Python) and
`rt.local/core-go/users/bans` + `users` (Go). User guide: `docs/authentication.md` "Account bans".

## Design

- **An extension of users, not a new identity.** The ban lives on the user row (`data.ban`). The
  users module owns that format and its reader (`activeBan`), and auth enforces it on every
  sign-in path in every language. The `users-bans` module only writes bans, keeps the history and
  serves the admin endpoints. Leaving the module out removes the endpoints, never the enforcement:
  a ban written by any implementation is refused everywhere.
- **Immediate cut-off.** A ban bumps `tokenVersion` in the same transaction that stores it, so
  every access token and refresh session of the account stops working on its next request. The
  live session rows are then marked `revokedReason: "ban"` (informational; separate writes).
- **Refused only after the credential is proven.** Login answers 403 `Account suspended` only when
  the password matched (a wrong password stays 401), code sign-in only when the code matched (the
  code stays unused), TOTP after the challenge and the code format, refresh only for whoever holds
  the session's current or previous secret (anyone else: 401 `Invalid session`). So the ban is not
  an account-enumeration oracle. The reason is never sent to the user: the only public text is
  `Account suspended`.
- **Temporary bans lift by themselves.** `until <= now` is lifted (the JWT `exp` boundary rule);
  nothing is written at expiry. An `until` that cannot be read keeps the ban (fail closed).
- **Unban restores sign-in, not sessions.** Unban clears `data.ban` without touching
  `tokenVersion`; the user signs in again.
- **Idempotency.** Banning a banned account is not an error: it replaces reason, until and
  category, bumps `tokenVersion` again and records `action: "update"`. After a temporary ban
  expired, a new ban is `action: "ban"`. Unbanning an account that is not banned (or whose
  temporary ban expired) is 409 `User is not banned`.
- **Who can ban whom.** The endpoint permission (`users.ban`) comes first (owners always pass).
  Then: nobody bans or unbans themselves; an owner only by the admin root (`rt-app-root`, the
  `ADMIN_PASSWORD` principal, i.e. `/admin/app/...` from the console, CLI or MCP); an administrator
  only by an owner (or the root). Owners cannot ban each other: a compromised owner account cannot
  lock the other owners out.
- **Password reset** still works while banned (it is not a sign-in and does not lift the ban).

## Rows

```text
USERS/<id>                        data.ban = {reason, category, until, at, by} | null
                                  (until: ISO 8601 with ms and Z, or null = permanent; at: ISO; by: actor id)
USER_BANS#<userId>/pad15(atMs)-pad10(user row version)
                                  {userId, action: ban | update | unban, reason, category, until, actorId, at}
SESSIONS#<userId>/<sessionId>     revokedAt = now, revokedReason = "ban"   (existing session rows)
```

The ban write is one transaction: the user row (`version + 1`, `expected` = the version read,
`ban`, `tokenVersion + 1`, `updatedAt`, `updatedBy`) and the audit row (`expected: null`). The
audit sort key uses the new user row version, so it is unique per user and sorts by time. A version
conflict re-reads the user and re-checks the rules (4 attempts), then 409. Unban writes `ban: null`,
`updatedAt`/`updatedBy` and an audit row with `category: null, until: null`.

## Validation (in order, before the user is read)

| Field | Rule | Error (400) |
| --- | --- | --- |
| `reason` | string; JavaScript `trim()`, then 3..500 UTF-16 units | `A reason of 3 to 500 characters is required` |
| `until` | optional; `parseInstant` (below) | `Invalid until: use an ISO 8601 date and time` |
| | must be after now | `until must be in the future` |
| `category` | optional; `^[a-z][a-z0-9_-]{0,39}$` | `Invalid category` |

Then the user: an id that is not a string of at most 100 units, a missing or deleted user → 404
`User not found`; then the rules (403) and, for unban, 409.

**`parseInstant`** is one strict grammar in every language (never a lenient `Date.parse`):
`^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$`, ASCII
digits (Python `re.ASCII` and `fullmatch`, not `$`), a real Gregorian date, year ≥ 1970, hours ≤ 23,
minutes/seconds ≤ 59, offset ≤ 23:59, result within `0..253402300799999` (9999-12-31T23:59:59.999Z)
after the offset. The fraction is right-padded to milliseconds. `until` is stored normalized
(`toISOString`).

## HTTP

| Method | Path | Access | Body | Result |
| --- | --- | --- | --- | --- |
| POST | `/users/:id/ban` | permission `users.ban` | `{reason, until?, category?}` | admin user view |
| POST | `/users/:id/unban` | permission `users.ban` | `{reason}` | admin user view |
| GET | `/users/:id/bans` | permission `users.bans.read` | – | `{items}` newest first |

Served at the path and under `/admin/app` (like every permission endpoint). Admin tools (CLI/MCP):
`users_ban`, `users_unban`, `users_bans`. The **admin user view** of `GET /users` and `GET /users/:id`
(also returned by ban and unban) is the user view plus `banned` (boolean) and `ban` (the ban in
force or null); `banned` is also a list filter (`?banned=true`). History item: `{id (sort key),
userId, action, reason, category, until, actorId, at}`.

## The gate (auth, every language)

| Path | When | Answer |
| --- | --- | --- |
| login | after the password matched an active account, before MFA | 403 `Account suspended` |
| code login (`consume`) | after the code matched (code not consumed) | 403 |
| TOTP (`verifyMfa`) | after the challenge and the code format | 403 |
| access tokens (`actor`) | after the existing checks | 401 `Invalid session` (bumped tokenVersion); 403 if a ban was written without a bump |
| refresh | after rate limits and format; session row found; user active and banned; before liveness | 403 for the holder of the current or previous secret, else 401; nothing written (no rotation, no reuse revocation) |

The browser session client (`@gsalgadotoledo/rt-app-auth/client`) treats a 403 `Account suspended`
refresh as a rejection and signs out (other 403s keep the session and retry).

## Ports

| | TypeScript | Python | Go |
| --- | --- | --- | --- |
| Reader | `activeBan`, `parseInstant`, `viewAccount` (rt-app-users) | `rt_app.users.active_ban`, `parse_instant`, `view_account` | `users.ActiveBan`, `ParseInstant`, `ViewAccount` |
| Module | `new UserBans(users, {now?, sessions?})` | `UserBans(users, now=, sessions=)` | `bans.New(users, WithClock, WithSessions)` |
| Sessions | `auth.refreshSessions.revokeAll` | `auth.refresh_sessions.revoke_all` | `auth.RevokeAll` |

## Facade (subject `userBans`)

`init: {secret, now, rows}`; Users + JwtTokens + capturing mailbox + Auth + UserBans over one
MemoryStore and one settable clock. Methods: `ban`, `unban`, `history`, `view` (GET /users/:id),
`list` (GET /users), `activeBan(data)` (at the clock), `parseInstant(value)` (ms or null), `login`,
`issue`, `consume`, `verifyMfa`, `refresh`, `actor`, `sessions`, `mailbox`, `row(pk, sk)`,
`endpoints()`, `setNow(iso)`.
