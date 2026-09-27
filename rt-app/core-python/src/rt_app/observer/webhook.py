"""Webhook output: each event as JSON to a trusted HTTPS receiver configured in server code.

``WebhookOutput(id, url, headers=None, transport=None)`` posts ``stringify(event)`` with
``Content-Type: application/json`` followed by ``headers`` (which may replace it) through
``post_output``: HTTPS without URL credentials, no redirects, non-2xx statuses are errors.
"""
from __future__ import annotations

import threading
from collections.abc import Mapping
from typing import Any

from . import Transport, _url, post_output
from ._json import stringify


class WebhookOutput:
    """Generic JSON sink; errors (never shown to clients) name the status only."""

    def __init__(self, id: str, url: str, headers: Mapping[str, str] | None = None, transport: Transport | None = None) -> None:
        if _url.parse(url).scheme != "https":
            raise ValueError("Webhook output requires HTTPS")
        self.id = id
        self.url = url
        self.headers = dict(headers or {})
        self.transport = transport

    def write(self, event: Mapping[str, Any], signal: threading.Event | None = None) -> None:
        post_output(self.url, stringify(event), {"Content-Type": "application/json", **self.headers}, signal, self.transport)


__all__ = ["WebhookOutput"]
