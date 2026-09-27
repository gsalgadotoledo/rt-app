"""LocalSmtpMailer: development mail delivered to a local SMTP inbox (port of ``@gsalgadotoledo/rt-app-mail-local``).

The inbox is Mailpit on 127.0.0.1 (``rta mail`` installs and starts it); this module only sends to
it and never uses TLS, authentication or another host. Compose it like any component::

    mailbox = LocalMailbox()                                   # rt_app.auth: what GET /__dev/mailbox shows
    mailer = Singleton(lambda: LocalSmtpMailer(port=mail_config().smtp_port, capture=mailbox))
    features = [..., mailbox_feature(mailbox)]                 # local development only, never on Lambda

Rules shared with TypeScript: ``rt-app/spec/contracts/mail-local.contract.yaml``.
"""
from __future__ import annotations

import math
import os
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Final, Protocol

from .._js import is_number
from ..errors import HttpError
from ..nosql.json import js_number
from ._mime import SmtpConnection, build_message, deliver

LOCAL_FROM: Final = "RT-App <no-reply@rt-app.test>"
UNAVAILABLE: Final = "Local inbox is unavailable. Start it with npm run mail or restart npm run dev."
PRODUCTION: Final = "Local SMTP is disabled in production"
INVALID_PORT: Final = "Invalid local SMTP port"
PORTS: Final = "Local mail ports must be integers between 1024 and 65535"
SAME_PORTS: Final = "Local mail SMTP and UI ports must differ"


class Capture(Protocol):
    """Where sent codes are also recorded (``rt_app.auth.LocalMailbox``)."""

    def send_code(self, email: str, code: str, purpose: str) -> None: ...


def code_message(email: str, code: str, purpose: str) -> dict[str, str]:
    """The sign-in code email every mailer sends."""
    return {
        "to": email,
        "subject": f"RT-App: {purpose}",
        "text": f"Your code is {code}. It expires in 10 minutes. If you did not request it, ignore this email.",
    }


def _valid_port(value: Any) -> bool:
    return is_number(value) and math.isfinite(value) and float(value).is_integer() and 1024 <= value <= 65535


class LocalSmtpMailer:
    """Development-only SMTP mailer; the host is fixed to 127.0.0.1.

    ``LocalSmtpMailer(port=1025, capture=mailbox)``. Raises ``RuntimeError`` in production
    (``NODE_ENV=production``) and ``ValueError`` for a port outside 1024–65535. Every delivery
    failure is 503 ``Local inbox is unavailable…``; ``send_code`` records the code in ``capture``
    only after it was delivered.
    """

    def __init__(
        self,
        port: Any = 1025,
        capture: Capture | None = None,
        *,
        env: Mapping[str, str] | None = None,
        now: Callable[[], datetime] | None = None,
    ) -> None:
        environment = os.environ if env is None else env
        if environment.get("NODE_ENV") == "production":
            raise RuntimeError(PRODUCTION)
        if not _valid_port(port):
            raise ValueError(INVALID_PORT)
        self.port = int(port)
        self.capture = capture
        self._now = now
        self._connection = SmtpConnection(
            host="127.0.0.1",
            port=self.port,
            ignore_tls=True,
            connection_timeout=3.0,
            greeting_timeout=3.0,
            socket_timeout=5.0,
        )

    def send(self, message: Mapping[str, Any]) -> None:
        """Deliver ``{to, subject, text, html?}`` from ``RT-App <no-reply@rt-app.test>``."""
        try:
            built = build_message({"from": LOCAL_FROM, **message}, now=self._now() if self._now else None)
            deliver(self._connection, built)
        except Exception:
            raise HttpError(503, UNAVAILABLE) from None

    def send_code(self, email: str, code: str, purpose: str) -> None:
        self.send(code_message(email, code, purpose))
        if self.capture is not None:
            self.capture.send_code(email, code, purpose)


@dataclass(frozen=True)
class MailConfig:
    smtp_port: int
    ui_port: int
    url: str


def mail_config(env: Mapping[str, str] | None = None) -> MailConfig:
    """Ports of the local inbox: ``RT_APP_MAIL_SMTP_PORT`` (1025) and ``RT_APP_MAIL_UI_PORT`` (8025).

    Values are read like JavaScript ``Number`` (``" 2525 "``, ``"0x401"`` and ``"2e3"`` are numbers,
    ``""`` is 0); both must be integers in 1024–65535 and differ (``ValueError`` otherwise).
    """
    environment = os.environ if env is None else env

    def port(name: str, fallback: int) -> int:
        value = environment.get(name)
        number = js_number(fallback if value is None else value)
        if not (math.isfinite(number) and number.is_integer() and 1024 <= number <= 65535):
            raise ValueError(PORTS)
        return int(number)

    smtp_port, ui_port = port("RT_APP_MAIL_SMTP_PORT", 1025), port("RT_APP_MAIL_UI_PORT", 8025)
    if smtp_port == ui_port:
        raise ValueError(SAME_PORTS)
    return MailConfig(smtp_port, ui_port, f"http://127.0.0.1:{ui_port}")


def mailbox_feature(mailbox: Any) -> Any:
    """``GET /__dev/mailbox``: the captured codes, newest first (local development only).

    The TypeScript server answers it on its loopback-only local process and not on Lambda; mount it
    only in a local composition root. ``mailbox`` is an ``rt_app.auth.LocalMailbox``.
    """
    from ..web.app import Endpoint, Feature

    def handle(_context: Any) -> list[dict[str, str]]:
        return list(mailbox.messages)

    return Feature("mail-local", [Endpoint("GET", "/__dev/mailbox", "mail.mailbox", "guest", handle)])


__all__ = ["LocalSmtpMailer", "MailConfig", "mail_config", "mailbox_feature", "code_message", "UNAVAILABLE"]
