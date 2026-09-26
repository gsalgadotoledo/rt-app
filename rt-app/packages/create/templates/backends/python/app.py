"""Composition root of the Python API: one line per component; change a line to swap one.

Native modules answer here (health, feature flags and your own features). Every other route
(admin, auth, users, CRUD…) is forwarded to the RT-App Node core, so modules can move to Python
one at a time. Contracts in the RT-App repository keep both implementations equivalent.
"""
from __future__ import annotations

import os
from functools import partial

from rt_app import Singleton
from rt_app.feature_flags import FeatureFlags
from rt_app.health import Health
from rt_app.nosql import MemoryStore, NoSQL
from rt_app.web import App, Endpoint, Feature, proxy_to


class Greeting:
    """An application module: plain class, constructor configuration, no framework base class."""

    def __init__(self, *, name: str) -> None:
        self.name = name

    def hello(self) -> str:
        return f"Hello from {self.name}"

    def feature(self) -> Feature:
        return Feature("greeting", [
            Endpoint(method="GET", path="/hello", resource="greeting", access="guest",
                     handle=lambda ctx: {"message": self.hello(), "language": "python"}),
        ])


def store_from_environment() -> NoSQL:
    """PostgreSQL (DATABASE_URL), DynamoDB (TABLE_NAME) or memory; the same rows as the Node core."""
    if os.environ.get("DATABASE_URL"):
        from rt_app.nosql.postgres import PostgresStore  # needs the `postgres` extra
        return PostgresStore(os.environ["DATABASE_URL"])
    if os.environ.get("TABLE_NAME"):
        from rt_app.nosql.dynamodb import DynamoStore  # needs the `dynamodb` extra
        return DynamoStore(os.environ["TABLE_NAME"], endpoint=os.environ.get("DYNAMODB_ENDPOINT"))
    return MemoryStore()


def create_app() -> App:
    store: Singleton[NoSQL] = Singleton(store_from_environment)
    health = Singleton(Health)
    flags = Singleton(lambda: FeatureFlags(store.get()))
    greeting = Singleton(partial(Greeting, name="Python"))
    core = os.environ.get("RT_APP_CORE_API_URL")  # the Node core, started by `npm run dev`
    return App(
        [health.get().feature(), flags.get().feature(), greeting.get().feature()],
        # Local development only: owner endpoints under /admin/app act as the local owner.
        local_admin=os.environ.get("RT_APP_TARGET", "local") == "local",
        fallback=proxy_to(core) if core else None,
    )
