"""SmtpMailer: production SMTP with TLS required (port of ``@gsalgadotoledo/rt-app-mail-smtp``).

For deployments outside AWS (Resend, Postmark, SendGrid, Mailgun SMTP…)::

    mailer = Singleton(lambda: SmtpMailer(os.environ["SMTP_URL"], os.environ["MAIL_FROM"]))

``SMTP_URL`` is ``smtps://user:password@host:465`` (implicit TLS) or ``smtp://user:password@host:587``
(STARTTLS, required): plain-text SMTP is refused so credentials never cross the network in clear.
Rules shared with TypeScript: ``rt-app/spec/contracts/mail-smtp.contract.yaml``.
"""
from __future__ import annotations

import ssl
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Final, Protocol

from ..errors import HttpError
from ._mime import SmtpConnection, build_message, deliver
from ._url import URLError, decode_uri_component, parse_url
from .local import code_message

UNAVAILABLE: Final = "Email delivery is temporarily unavailable"
FROM_REQUIRED: Final = "MAIL_FROM is required"
BAD_URL: Final = "SMTP_URL must be a URL like smtps://user:password@smtp.example.com:465"
BAD_SCHEME: Final = "SMTP_URL must use smtp:// or smtps://"


@dataclass(frozen=True)
class SmtpAuth:
    user: str
    password: str


@dataclass(frozen=True)
class SmtpOptions:
    """What ``smtp_options(url)`` returns (nodemailer's transport options in TypeScript)."""

    host: str
    port: int
    secure: bool
    require_tls: bool
    auth: SmtpAuth | None
    connection_timeout: int = 10_000
    greeting_timeout: int = 10_000
    socket_timeout: int = 20_000
    disable_file_access: bool = True
    disable_url_access: bool = True


def smtp_options(url: Any) -> SmtpOptions:
    """Parse ``SMTP_URL`` like JavaScript ``new URL`` (the host is kept as parsed).

    ``smtp_options("smtps://re%40send:p%3Ass@smtp.resend.com")`` →
    ``SmtpOptions(host="smtp.resend.com", port=465, secure=True, require_tls=False, auth=SmtpAuth("re@send", "p:ss"))``.
    Raises ``ValueError`` with the TypeScript messages (``URI malformed`` for bad escapes).
    """
    try:
        parsed = parse_url("undefined" if url is None else str(url))
    except URLError:
        raise ValueError(BAD_URL) from None
    if parsed.scheme not in ("smtp", "smtps"):
        raise ValueError(BAD_SCHEME)
    secure = parsed.scheme == "smtps"
    auth = SmtpAuth(decode_uri_component(parsed.username), decode_uri_component(parsed.password)) if parsed.username else None
    return SmtpOptions(
        host=parsed.hostname,
        port=int(parsed.port) if parsed.port else (465 if secure else 587),
        secure=secure,
        require_tls=not secure,
        auth=auth,
    )


class SmtpTransport(Protocol):
    """What the mailer needs from a transport (inject a fake one in tests)."""

    def send_mail(self, message: Mapping[str, Any]) -> Any: ...


class SmtpClientTransport:
    """The real transport: builds the message and delivers it over TLS."""

    def __init__(self, options: SmtpOptions, *, tls_context: ssl.SSLContext | None = None) -> None:
        self.options = options
        self._connection = SmtpConnection(
            host=options.host,
            port=options.port,
            secure=options.secure,
            require_tls=options.require_tls,
            user=options.auth.user if options.auth else None,
            password=options.auth.password if options.auth else None,
            connection_timeout=options.connection_timeout / 1000,
            greeting_timeout=options.greeting_timeout / 1000,
            socket_timeout=options.socket_timeout / 1000,
            tls_context=tls_context,
        )

    def send_mail(self, message: Mapping[str, Any]) -> None:
        deliver(self._connection, build_message(message))


class SmtpMailer:
    """``SmtpMailer(url, from_)``: MAIL_FROM is required; provider errors become 503 without details."""

    def __init__(self, url: str, from_: str, transport: SmtpTransport | None = None) -> None:
        if not from_:
            raise ValueError(FROM_REQUIRED)
        self.url = url
        self.from_ = from_
        self.transport: SmtpTransport = transport if transport is not None else SmtpClientTransport(smtp_options(url))

    def send(self, message: Mapping[str, Any]) -> None:
        """Hand ``{from, ...message}`` to the transport; any failure is 503."""
        try:
            self.transport.send_mail({"from": self.from_, **message})
        except Exception:
            raise HttpError(503, UNAVAILABLE) from None

    def send_code(self, email: str, code: str, purpose: str) -> None:
        self.send(code_message(email, code, purpose))


__all__ = ["SmtpMailer", "SmtpOptions", "SmtpAuth", "SmtpTransport", "SmtpClientTransport", "smtp_options"]
