"""Health: GET /health/live and /health/ready."""
from rt_app.health import Health


def features(components):
    return [Health().feature()]
