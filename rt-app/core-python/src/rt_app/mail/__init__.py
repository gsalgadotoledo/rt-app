"""Mailers: development inbox (``local``) and production SMTP (``smtp``), ports of
``@gsalgadotoledo/rt-app-mail-local`` and ``@gsalgadotoledo/rt-app-mail-smtp``.

Both implement the auth ``Mailer`` protocol (``send(message)`` and ``send_code(email, code,
purpose)``) and build messages with the rules of nodemailer, the TypeScript transport: address
lists (``Name <addr>``, groups, IDN domains, SMTPUTF8), subjects that can never add a header, and
text/HTML bodies. See ``rt-app/docs/polyglot/mail.md``.
"""
from __future__ import annotations

from .local import LocalSmtpMailer, MailConfig, mail_config, mailbox_feature
from .smtp import SmtpAuth, SmtpClientTransport, SmtpMailer, SmtpOptions, SmtpTransport, smtp_options

__all__ = [
    "LocalSmtpMailer",
    "MailConfig",
    "mail_config",
    "mailbox_feature",
    "SmtpMailer",
    "SmtpOptions",
    "SmtpAuth",
    "SmtpTransport",
    "SmtpClientTransport",
    "smtp_options",
]
