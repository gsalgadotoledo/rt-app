"""Slack output: a plain-text message per event to an incoming webhook owned by the operator.

``SlackOutput(webhook, transport=None)`` accepts only ``https://hooks.slack.com/services/…`` and
``https://hooks.slack-gov.com/services/…`` and posts ``{"text", "mrkdwn": false}`` with
``[<level>] <category or source>: <message>`` and ``Request: <requestId or event id>``.
"""
from __future__ import annotations

import threading
from collections.abc import Mapping
from typing import Any

from .._jsnum import js_string
from . import Transport, _url, post_output
from ._json import stringify

HOSTS = ("hooks.slack.com", "hooks.slack-gov.com")


def _text(value: Any) -> str:
    return "undefined" if value is None else js_string(value)


class SlackOutput:
    """Disabled until explicitly configured; the webhook URL is a secret of the server."""

    id = "slack"

    def __init__(self, webhook: str, transport: Transport | None = None) -> None:
        url = _url.parse(webhook)
        if url.scheme != "https" or url.host not in HOSTS or not url.pathname.startswith("/services/"):
            raise ValueError("Invalid Slack incoming webhook")
        self.webhook = webhook
        self.transport = transport

    def write(self, event: Mapping[str, Any], signal: threading.Event | None = None) -> None:
        category = event.get("category")
        request = event.get("requestId")
        text = (
            f"[{_text(event.get('level'))}] {_text(event.get('source') if category is None else category)}: "
            f"{_text(event.get('message'))}\nRequest: {_text(event.get('id') if request is None else request)}"
        )
        post_output(self.webhook, stringify({"text": text, "mrkdwn": False}), {"Content-Type": "application/json"}, signal, self.transport)


__all__ = ["SlackOutput", "HOSTS"]
