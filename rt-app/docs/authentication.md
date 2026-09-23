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
| Logout | invalidate all app sessions | Cognito global sign-out + app invalidation |
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
to the frontend. Refresh tokens are not exposed or automatically renewed.

AWS SDK clients are created once per application instance and reused across warm
Lambda requests. No new pool, client or user is created during ordinary login.

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
the Cognito console do not instantly revoke RT-App JWTs; they can last up to 15 minutes
unless application sessions are also invalidated.

Not implemented by this contract: social/SAML/OIDC federation, passkeys, hosted/managed
login pages, refresh-session UI, SMS MFA, remembered devices, adaptive risk protection,
public sign-up or a general Cognito administration console. These require additional
provider capabilities rather than pretending every adapter supports them.

References: [Cognito authentication flows](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-authentication-flow-methods.html),
[MFA rules](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-mfa.html),
[SES configuration](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-email.html).

Local `npm run dev` also starts Mailpit at http://127.0.0.1:8025. The core's
`@gsalgadotoledo/rt-app-mail-local` SMTP adapter delivers authentication messages to that inbox and
keeps the existing in-memory development code preview. Mailpit stores its history in
`.rt-app/mail/`; no message is forwarded to a real mailbox. AWS email delivery is unchanged.
