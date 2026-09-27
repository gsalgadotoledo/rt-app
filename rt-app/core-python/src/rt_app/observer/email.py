"""Email outputs: SES v2 (``EmailOutput``) and the local mail viewer (``LocalEmailOutput``).

Both send the subject ``[<level>] <source>`` and the pretty JSON of the event as text.

- ``EmailOutput(from_, to, client=None)`` calls ``client.send_email(FromEmailAddress=…,
  Destination=…, Content=…)``, the boto3 ``sesv2`` client API; the default client is created on the
  first write (boto3 is an optional dependency). Both addresses must contain "@".
- ``LocalEmailOutput(from_, to, port=1025, *, send=None, production=None)`` sends plain SMTP to
  127.0.0.1 with 1-second timeouts. It refuses production (``NODE_ENV=production`` unless
  ``production`` is given) and ports outside 1024-65535.
"""
from __future__ import annotations

import os
import smtplib
import threading
from collections.abc import Callable, Mapping
from email.message import EmailMessage
from typing import Any, TypedDict

from .. import _js
from .._jsnum import js_string
from ._json import stringify


def _subject(event: Mapping[str, Any]) -> str:
    level, source = event.get("level"), event.get("source")
    return f"[{'undefined' if level is None else js_string(level)}] {'undefined' if source is None else js_string(source)}"


class EmailOutput:
    """SES v2 SendEmail per event (verified sender, permitted recipient)."""

    id = "email"

    def __init__(self, from_: str, to: str, client: Any = None) -> None:
        if "@" not in from_ or "@" not in to:
            raise ValueError("Observer email requires valid from/to addresses")
        self.from_, self.to = from_, to
        self._client = client
        self._lock = threading.Lock()

    def _ses(self) -> Any:
        with self._lock:
            if self._client is None:
                import boto3  # optional dependency, loaded on first use

                self._client = boto3.client("sesv2")
            return self._client

    def write(self, event: Mapping[str, Any], signal: threading.Event | None = None) -> None:
        self._ses().send_email(
            FromEmailAddress=self.from_,
            Destination={"ToAddresses": [self.to]},
            Content={"Simple": {"Subject": {"Data": _subject(event)}, "Body": {"Text": {"Data": stringify(event, 2)}}}},
        )


class LocalMail(TypedDict):
    from_: str
    to: str
    subject: str
    text: str


def smtp_sender(port: int) -> Callable[[Mapping[str, str]], None]:
    """Plain SMTP to the loopback mail viewer; never an arbitrary server."""

    def send(mail: Mapping[str, str]) -> None:
        message = EmailMessage()
        message["From"], message["To"], message["Subject"] = mail["from"], mail["to"], mail["subject"]
        message.set_content(mail["text"])
        with smtplib.SMTP("127.0.0.1", port, timeout=1) as smtp:
            smtp.send_message(message)

    return send


class LocalEmailOutput:
    """The local mail viewer (development only)."""

    id = "email"

    def __init__(
        self,
        from_: str,
        to: str,
        port: Any = 1025,
        *,
        send: Callable[[Mapping[str, str]], object] | None = None,
        production: bool | None = None,
    ) -> None:
        if production if production is not None else os.environ.get("NODE_ENV") == "production":
            raise ValueError("Local observer email is disabled in production")
        if not (_js.is_finite_number(port) and float(port).is_integer() and 1024 <= port <= 65535):
            raise ValueError("Invalid local SMTP port")
        self.from_, self.to = from_, to
        self.send = send or smtp_sender(int(port))

    def write(self, event: Mapping[str, Any], signal: threading.Event | None = None) -> None:
        self.send({"from": self.from_, "to": self.to, "subject": _subject(event), "text": stringify(event, 2)})


__all__ = ["EmailOutput", "LocalEmailOutput", "smtp_sender"]
