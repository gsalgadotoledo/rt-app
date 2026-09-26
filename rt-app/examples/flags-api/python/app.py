"""Composition root of the flags API: one provider per component, swap a line to change one.

    python -m rt_app.web serve app:app                  # local HTTP server on $PORT
    python -m rt_app.web lambda-local app:app           # the Lambda handler behind local HTTP
    python -m rt_app.web call app:app GET /health/live  # one request from the command line
"""
from __future__ import annotations

from rt_app import Singleton
from rt_app.feature_flags import FeatureFlags
from rt_app.health import Health
from rt_app.nosql import MemoryStore, NoSQL
from rt_app.web import App


def create_app() -> App:
    # Swap the store here, e.g. Singleton(partial(DynamoStore, table="flags")); modules only see NoSQL.
    store: Singleton[NoSQL] = Singleton(MemoryStore)
    health = Singleton(Health)
    flags = Singleton(lambda: FeatureFlags(store.get()))
    # Local mode: owner endpoints under /admin/app run as the local owner "rt-app-root".
    return App([health.get().feature(), flags.get().feature()], local_admin=True)


app = create_app()
