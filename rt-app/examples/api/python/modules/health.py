"""Health: GET /health/live and /health/ready (guests) and GET /admin/app/health/report (owner).

The "database" probe reads one row of the shared store, like the TypeScript framework's default.
"""
from rt_app.health import HealthChecks, Probe


def features(components):
    store = components.store
    database = Probe("database", lambda signal: store.get().get("SCHEMA", "users"))
    return [HealthChecks([database]).feature()]
