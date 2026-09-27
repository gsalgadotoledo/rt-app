"""Identity: users (/users…, owner endpoints under /admin/app/users) and sign-in (/auth…).

Sign-in returns a 15-minute access token plus a rotating refresh token (POST /auth/refresh, GET and
DELETE /auth/sessions, POST /auth/logout). Access tokens authenticate every other module's
protected endpoints (``Authorization: Bearer <token>``). Codes are kept by a LocalMailbox (swap in
SesMailer to send them). Tokens are signed with RT_APP_SECRET (at least 32 characters); without it a
random secret is used, which is fine for one local process but not for several instances or Lambda
cold starts.
"""
import os
import secrets

from rt_app.auth import Auth, LocalMailbox
from rt_app.jwt import JwtTokens
from rt_app.users import Users


def features(components):
    secret = os.environ.get("RT_APP_SECRET") or secrets.token_hex(48)
    users = Users(components.store.get())
    auth = Auth(users, JwtTokens(secret), LocalMailbox(), secret)
    components.authenticate = auth.actor_from_request
    return [users.feature(), auth.feature()]
