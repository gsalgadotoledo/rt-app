"""Composition root of the example API: the shared components plus every module in modules/.

    python -m rt_app.web serve app:app                  # local HTTP server on $PORT
    python -m rt_app.web lambda-local app:app           # the Lambda handler behind local HTTP
    python -m rt_app.web call app:app GET /health/live  # one request from the command line

Each modules/<name>.py defines features(components) -> list[Feature]; add a file per module. The
HTTP contracts in rt-app/spec/contracts/*-api.contract.yaml run against this app, the Go one and
the TypeScript framework.
"""
from __future__ import annotations

import importlib.util
import sys
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from rt_app import Singleton
from rt_app.nosql import MemoryStore, NoSQL
from rt_app.web import App, Feature, Request, ServicePolicy


@dataclass
class Components:
    """Shared singletons modules build on. Swap the store here (PostgreSQL, DynamoDB…)."""

    store: Singleton[NoSQL]
    #: Resolves the actor of a request (set by the identity module: Bearer access tokens).
    authenticate: Callable[[Request], dict | None] | None = None
    #: Authorizes /service/... endpoints (set by the service_keys module: scoped service keys).
    service: ServicePolicy | None = None


def load_modules() -> list:
    folder = Path(__file__).parent / "modules"
    modules = []
    for path in sorted(folder.glob("*.py")):
        spec = importlib.util.spec_from_file_location(f"api_modules.{path.stem}", path)
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        modules.append(module)
    return modules


def create_app() -> App:
    components = Components(store=Singleton(MemoryStore))
    features: list[Feature] = [f for module in load_modules() for f in module.features(components)]
    # Local mode: owner endpoints under /admin/app run as the local owner "rt-app-root".
    return App(features, local_admin=True, authenticate=components.authenticate, service=components.service)


app = create_app()
