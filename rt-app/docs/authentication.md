# Authentication adapters

Local development requires only `ADMIN_PASSWORD` and `npm run dev`. Create an application
user from Admin → Usuarios, then use that account on the public frontend. Admin root
credentials are not an application account. There is no public self-registration.

## Contract and packages

`@gsalgadotoledo/rt-app-auth` owns the routes, limits, one-use flow records and application sessions;
its default local implementation uses `@gsalgadotoledo/rt-app-users` and the selected NoSQL store.
`@gsalgadotoledo/rt-app-auth-cognito` implements the `IdentityProvider` contract for cloud credentials.
`Users` owns profiles, roles, grants and active status; its `CredentialProvider` hook
reserves an inactive profile before provisioning remote credentials. Failed provisioning
can be retried by submitting the same email through the admin with a password. It reuses
the reserved ID; it never silently activates an incomplete account.

| Capability | Local JSON | Cognito |
| --- | --- | --- |
| Admin-created accounts | scrypt hashes | Cognito credentials; no hash in DynamoDB |
| Password login | local verification | USER_PASSWORD_AUTH |
| Email code login | captured development email | USER_AUTH / EMAIL_OTP via SES |
| Password recovery | one-use captured code | Cognito forgot/confirm flows |
| Optional TOTP MFA | RFC 6238, encrypted seed, replay guard | Cognito software-token MFA |
| Email change | verify new email before updating | verify new email, update Cognito and profile |
| Logout | ends the current session; `{all:true}` ends every session | same; `{all:true}` adds Cognito global sign-out |
| Refresh sessions | rotating refresh tokens, 4 days max | same (RT-App sessions, not Cognito refresh tokens) |
| Profile/permissions | JSON | DynamoDB |

`GET /auth/methods` advertises provider and capabilities. A password login can return
`{challenge:"totp",challengeId}` instead of a session. The UI must submit its code to
`POST /auth/mfa/verify`; it must never treat a challenge as an authenticated user.
Email-code initiation also returns a challenge ID with Cognito; include it in
`POST /auth/code/verify`. Both are supported by the shared React AuthPanel.

Cognito validates provider access tokens using GetUser and matches its immutable
username to the app's reserved user ID. RT-App then issues its own 15-minute application
JWT. API authorization always reads the current application profile; Cognito groups or
unverified JWT claims cannot grant application roles. Provider tokens are not exposed
to the frontend. Cognito refresh tokens are not exposed or renewed; RT-App sessions (below) are
independent of them.

AWS SDK clients are created once per application instance and reused across warm
Lambda requests. No new pool, client or user is created during ordinary login.

## Sessions and refresh tokens

Every sign-in (password, email code, password + TOTP, email change) returns

```json
{"token": "<15-minute JWT>", "expiresIn": 900, "refreshToken": "<sessionId>.<secret>",
 "refreshExpiresAt": "2026-01-06T03:04:05.000Z", "sessionId": "<id>", "user": {}}
```

- **Access token:** unchanged, 15 minutes. It is checked once, when a request starts, so work that
  is already running (a long upload, a report, a deployment job) is never cut by expiry.
- **Refresh:** `POST /auth/refresh {refreshToken}` returns a new access token and a new refresh
  token for the same session. The old refresh token stops working; reusing it after 30 seconds is
  treated as theft and ends the session everywhere. Failures are always 401 `Invalid session`:
  send the user to sign in.
- **Lifetime:** a session ends 4 days after sign-in no matter how often it is refreshed
  (`new Auth(..., {sessionTtlMs})` changes it). Then the user signs in again.
- **Immediate cut-off:** refresh re-reads the user every time. Deactivating a user, changing their
  role or grants, a password reset, MFA changes and "log out everywhere" end every session and
  every access token at once. Revoking one session also stops its access tokens immediately.
- **Your sessions:** `GET /auth/sessions` lists your active sessions (`id, createdAt, lastUsedAt,
  expiresAt, current, ip, userAgent`; never secrets). `DELETE /auth/sessions/:id` ends one.
- **Logout:** `POST /auth/logout` now ends only the current session (the device you are on);
  `POST /auth/logout {"all": true}` ends all of them, as logout did before. Old access tokens
  without a session id still log out everywhere. Owners and admins end a user's sessions the
  usual way (deactivate, change grants, reset MFA).
- **Admin console:** with a deployed API the root sign-in also gets a refresh session
  (`POST /admin/identity/auth/refresh`); changing `ADMIN_PASSWORD` ends all of them. The local
  installer keeps 15-minute root tokens.

The database stores only HMACs of refresh secrets (`SESSIONS#<userId>` rows with a TTL at
expiry). Row formats and algorithms: `docs/polyglot/auth-sessions.md`.

### Browser clients

`@gsalgadotoledo/rt-app-auth/client` (`createSessionClient`) is used by the starter SPA, the SSR
account menu and the admin console. It refreshes about 90 seconds before the access token expires,
refreshes once and retries when the API answers 401 with a session error, runs one refresh at a
time (across tabs with Web Locks, sharing rotations over a `BroadcastChannel`), and signs out only
when the server rejects the refresh token. Network errors and 429/5xx keep the session and retry
after 30 seconds.

Storage choices and XSS trade-offs:

- **Starter SPA:** `sessionStorage` (as before): survives reloads and payment redirects in the tab,
  gone when the tab closes. Pass `storage: localStorage` to stay signed in across browser restarts
  for up to 4 days.
- **SSR account menu and admin console:** memory only (as before); a reload asks to sign in again.
- Any script running on your origin (XSS) can read a token kept in JavaScript memory or Web
  Storage, and a stolen refresh token lives up to 4 days instead of 15 minutes. Rotation and reuse
  detection limit the damage (the first reuse ends the session for both parties), and `GET
  /auth/sessions` + `DELETE` let users end sessions they do not recognize. An HttpOnly cookie
  would hide the token from scripts, but it needs a same-site API and CSRF protection, which the
  split SPA/API deployment does not have; prefer a strict Content-Security-Policy.

## Service keys (backend credentials)

A backend that meters credits for users (an agent server) must not hold `ADMIN_PASSWORD`: the
root session can manage users, settings and plans. It uses a **service key** instead.

- **Format:** `Authorization: Bearer rtsk_<id>.<secret>` (id: `A-Z a-z 0-9 _ -`, up to 64;
  secret: 32 to 128 of the same characters). Only `sha256hex(token)` is stored or configured;
  the token is compared in constant time and never logged or returned after creation.
- **Scopes:** a key authenticates ONLY endpoints declared with `access: "service"` (all under
  `/service/`, never mounted under `/admin/app`) whose `resource` is one of its scopes. It is not
  a user session and not an admin session: every other endpoint rejects it (401). Scopes today:
  `subscriptions.meter` (the metering calls below) and `service-keys.self` (`GET
  /service/keys/self`, the key's own id, scopes and limit, for a startup check).
- **Errors:** no header → 401 `Service key required`; malformed, unknown, rotated-out or revoked →
  401 `Invalid service key` (no detail); outside its scopes → 403 `Service key not allowed for
  this resource`; over its limit → 429 `Too many attempts; wait one minute`.
- **Rate limit:** per key, `rateLimit` requests per minute (default 600, up to 100000).
- **Audit:** metering entries and reservation receipts carry `source: "api"` and `actorId:
  "service:<id>"`; creating, rotating and revoking a key writes `SERVICE_KEY_AUDIT#<id>` rows;
  the last use is kept per key (written at most once a minute).

**Metering endpoints** (scope `subscriptions.meter`; the same calls as the owner endpoints
`/admin/app/subscriptions/admin/accounts/:id/*`, acting on the account in the path):

| Method | Path |
| --- | --- |
| GET | `/service/subscriptions/accounts/:id/usage` |
| POST | `/service/subscriptions/accounts/:id/preflight` |
| POST | `/service/subscriptions/accounts/:id/reservations` |
| POST | `/service/subscriptions/accounts/:id/reservations/:key/settle` |
| POST | `/service/subscriptions/accounts/:id/reservations/:key/release` |
| POST | `/service/subscriptions/accounts/:id/ledger` (debits only: `credits < 0`; 403 for credits) |

**Two ways to create keys** (both can be used at once):

1. **Admin-managed (recommended):** Admin → Service keys (or `POST /admin/app/service-keys`
   `{description, scopes, id?, rateLimit?}`): the token is shown once. Rotate (`POST
   /admin/app/service-keys/:id/rotate`: new token, the old one stops at once) and revoke (`POST
   .../revoke`: rejected from the next request) without touching `ADMIN_PASSWORD` or deploying.
   For a rotation without downtime, create a second key, deploy it to the backend, then revoke
   the first.
2. **Configured:** `RT_APP_SERVICE_KEYS` (JSON) or `RT_APP_SERVICE_KEYS_FILE` (a secrets file with
   the same JSON). Prefer `secretHash` so the secret never sits in the configuration:

   ```sh
   TOKEN="rtsk_agent-server.$(openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n' | cut -c1-43)"
   printf %s "$TOKEN" | shasum -a 256   # -> secretHash
   ```

   ```json
   [{"id": "agent-server", "secretHash": "<64 hex>", "scopes": ["subscriptions.meter"],
     "description": "Agent server", "rateLimit": 600}]
   ```

   An invalid configuration stops the application at startup (`Invalid service key
   configuration`). Configured keys are listed in the admin but rotated or revoked in the
   configuration.

Python and Go serve the same endpoints (`rt_app.service_keys`, `core-go/servicekeys`). Wire formats
and rows: `docs/polyglot/service-keys.md`.

## TOTP and recovery

On the public frontend, sign in and open **Seguridad · Autenticador TOTP**. Re-enter the
current password, add the displayed secret manually to an authenticator (6 digits,
30 seconds, SHA-1), and confirm a code. Activation invalidates app sessions; sign in
again with password plus TOTP. Setup records expire after five minutes. Passwords,
raw provider sessions and TOTP seeds are not stored as plaintext in the database.

With MFA enabled, email-only login is blocked in both implementations. Password recovery
does not remove MFA. Losing the authenticator requires an administrator to verify the
user's identity and use Admin → Autenticación → Recuperar acceso, providing their user ID.
The root/owner-only endpoint is `POST /admin/app/auth/mfa/reset` with `{userId}`.
This removes MFA and invalidates app sessions. No recovery-code feature is provided.

The JSON adapter is for development. Its `.key` file must stay with the corresponding
JSON database. Losing/changing the key makes encrypted local MFA/flow records unreadable.
Do not commit either file. The local mailbox exists only on the loopback server; AWS
uses SES. This is not a Cognito emulator: AWS policies, delivery, quotas and operations
must also be validated in an AWS test environment.

## Cloud deployment

Each configured environment gets an independent Cognito Essentials pool/client.
Infrastructure is owned by `rt-app/packages/auth-cognito/infra`; the starter composes it
from `infra/aws`. Pools allow administrator-created accounts only. SMS is not configured.
TOTP is optional, so email OTP remains available for users who have not enabled MFA.
The SES sender address itself must be verified in the selected region; the current
Terraform source ARN points to that email identity (not just a verified domain).
SES sandbox recipient restrictions still apply. Regional Cognito/SES availability must
be checked before selecting a region other than the default us-east-1.

The installation IAM policy adds Cognito provisioning and its email service-linked role.
Before upgrading an existing installation, rerun the installer to update the bootstrap
IAM policies; a normal CI application deploy does not update bootstrap roles.
CI deployment roles are tagged per environment; the Lambda role is restricted to its
pool ARN. As with the rest of the installer, the initial provisioning identity is
powerful. Review its policy in the target account.

Switching adapters does **not** migrate users, passwords, sessions or MFA enrollments.
Local and cloud are separate datasets. Existing cloud users from the previous scrypt
implementation need an explicit migration/invitation plan before enabling Cognito;
never copy a local password hash into Cognito or infer/link an existing identity by email.
New installations start with empty application users.

Cognito and DynamoDB are separate systems; there is no distributed transaction. Account
provisioning keeps incomplete profiles inactive. Email changes and MFA changes can need
administrator reconciliation if the remote step succeeds but a subsequent database
write fails. Retrying a failed user creation is supported; ambiguous MFA changes should
be reset by an authorized administrator before re-enrolling. Changes made directly in
the Cognito console do not revoke RT-App sessions: refresh checks the RT-App profile, not
Cognito, so a session can keep refreshing for up to 4 days. Deactivate the user (or reset MFA)
in RT-App to end their sessions immediately.

Not implemented by this contract: social/SAML/OIDC federation, passkeys, hosted/managed
login pages, a session-management UI (the API exists), SMS MFA, remembered devices, adaptive risk protection,
public sign-up or a general Cognito administration console. These require additional
provider capabilities rather than pretending every adapter supports them.

References: [Cognito authentication flows](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-authentication-flow-methods.html),
[MFA rules](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-mfa.html),
[SES configuration](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-email.html).

Local `npm run dev` also starts Mailpit at http://127.0.0.1:8025. The core's
`@gsalgadotoledo/rt-app-mail-local` SMTP adapter delivers authentication messages to that inbox and
keeps the existing in-memory development code preview. Mailpit stores its history in
`.rt-app/mail/`; no message is forwarded to a real mailbox. AWS email delivery is unchanged.
