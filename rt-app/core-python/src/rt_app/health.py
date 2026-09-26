"""Liveness and readiness endpoints for load balancers and the contract runner."""
from __future__ import annotations

from .web.app import Endpoint, Feature


class Health:
    """``GET /health/live`` and ``GET /health/ready`` answer ``{"ok": true}`` to guests."""

    def feature(self) -> Feature:
        return Feature(
            id="health",
            endpoints=[
                Endpoint(method="GET", path="/health/live", resource="health.live", access="guest", handle=lambda _: {"ok": True}),
                Endpoint(method="GET", path="/health/ready", resource="health.ready", access="guest", handle=lambda _: {"ok": True}),
            ],
        )


__all__ = ["Health"]
