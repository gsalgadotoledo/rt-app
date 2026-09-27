"""Visits: POST /visits/start and /visits/events (guests); GET/DELETE /admin/app/visits (owner).

Tokens are signed with RT_APP_SECRET (at least 32 characters). Without it a random secret is used,
which is fine for one local process but not for several instances or Lambda cold starts.
"""
import os
import secrets

from rt_app.visits import Visits


def features(components):
    secret = os.environ.get("RT_APP_SECRET") or secrets.token_hex(48)
    return [Visits(components.store.get(), secret).feature()]
