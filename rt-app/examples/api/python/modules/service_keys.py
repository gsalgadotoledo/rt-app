"""Service keys: scoped credentials for backends (Authorization: Bearer rtsk_<id>.<secret>).

Keys reach only /service/... endpoints whose resource is one of their scopes (e.g. the metering
endpoints /service/subscriptions/accounts/:id/...). Configure them in RT_APP_SERVICE_KEYS (JSON) or
the file named by RT_APP_SERVICE_KEYS_FILE, or manage them under /admin/app/service-keys (the token
is shown once). Rate-limit rows are keyed with RT_APP_SECRET (a random secret without it).
"""
import os
import secrets

from rt_app.service_keys import ServiceKeys, service_keys_from_env

#: Resources of the service endpoints this API serves (sorted, like the TypeScript framework).
SCOPES = ["service-keys.self", "subscriptions.meter"]


def features(components):
    secret = os.environ.get("RT_APP_SECRET") or secrets.token_hex(48)
    keys = ServiceKeys(components.store.get(), secret, keys=service_keys_from_env(), scopes=SCOPES)
    keys.validate()  # refuse to start with an invalid RT_APP_SERVICE_KEYS
    components.service = keys
    return [keys.feature()]
