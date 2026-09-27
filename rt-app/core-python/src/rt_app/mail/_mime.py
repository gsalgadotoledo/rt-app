"""Message building (headers, bodies) and SMTP delivery with the rules of nodemailer 10.

What a mail client shows is the same as with the TypeScript mailers (the contracts decode what an
SMTP sink receives); the exact MIME bytes (boundaries, chunking of encoded words) may differ.
"""
from __future__ import annotations

import base64
import re
import secrets
import smtplib
import socket
import ssl
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import format_datetime
from typing import Any

from ._address import address_list, js_trim, needs_smtputf8

HEADER_WIDTH = 76
_HEADER_CONTROLS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
# nodemailer encodeWords(…, encodeAll): any '"' or non-ASCII character encodes the whole value.
_NEEDS_WORDS = re.compile('["\u0080-\U0010ffff]')
_NEWLINES = re.compile(r"\r?\n|\r")
_PLAIN_BODY = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\u0080-\U0010ffff]")
_Q_SAFE = frozenset(b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!*+-/")


class DeliveryError(Exception):
    """The message could not be delivered (no recipient, refused, network or protocol error)."""


# --- encoded words ---------------------------------------------------------------------------


def _utf16_units(ch: str) -> int:
    return 2 if ord(ch) > 0xFFFF else 1


def text_encoding(value: str) -> str:
    """nodemailer ``_getTextEncoding``: "Q" when Latin letters outnumber binary/non-ASCII units, else "B"."""
    non_latin = latin = 0
    for ch in value:
        code = ord(ch)
        if code <= 0x08 or code in (0x0B, 0x0C) or 0x0E <= code <= 0x1F or code >= 0x80:
            non_latin += _utf16_units(ch)
        elif "A" <= ch <= "Z" or "a" <= ch <= "z":
            latin += 1
    return "Q" if non_latin < latin else "B"


def _q_char(ch: str) -> str:
    out = []
    for byte in ch.encode("utf-8", "surrogatepass"):
        if byte == 0x20:
            out.append("_")
        elif byte in _Q_SAFE:
            out.append(chr(byte))
        else:
            out.append(f"={byte:02X}")
    return "".join(out)


def encode_word(value: str, encoding: str | None = None) -> str:
    """RFC 2047 encoded words for ``value`` (UTF-8, Q or B), split on character boundaries."""
    encoding = encoding or text_encoding(value)
    chunks: list[str] = []
    current = ""
    if encoding == "Q":
        for ch in value:
            piece = _q_char(ch)
            if current and len(current) + len(piece) > 40:
                chunks.append(current)
                current = ""
            current += piece
        chunks.append(current)
    else:
        size = 0
        raw: list[str] = []
        for ch in value:
            n = len(ch.encode("utf-8", "surrogatepass"))
            if raw and size + n > 30:
                chunks.append(base64.b64encode("".join(raw).encode("utf-8", "surrogatepass")).decode("ascii"))
                raw, size = [], 0
            raw.append(ch)
            size += n
        chunks.append(base64.b64encode("".join(raw).encode("utf-8", "surrogatepass")).decode("ascii"))
    return " ".join(f"=?UTF-8?{encoding}?{chunk}?=" for chunk in chunks)


def encode_header_text(value: str) -> str:
    """An unstructured header value (Subject): encoded when it has controls, '"' or non-ASCII."""
    if _HEADER_CONTROLS.search(value) or _NEEDS_WORDS.search(value):
        return encode_word(value)
    return value


def fold(line: str, width: int = HEADER_WIDTH) -> str:
    """Fold a header line before spaces so lines stay within ``width`` when possible."""
    if len(line) <= width:
        return line
    out: list[str] = []
    start = 0
    while len(line) - start > width:
        cut = line.rfind(" ", start + 1, start + width + 1)
        if cut <= start:
            cut = line.find(" ", start + width + 1)
        if cut < 0 or not line[cut:].strip(" "):
            break
        out.append(line[start:cut])
        start = cut
    out.append(line[start:])
    return "\r\n".join(out)


# --- bodies ----------------------------------------------------------------------------------


def _crlf(text: str) -> str:
    """nodemailer's line ending rule: every LF becomes CRLF, a lone CR stays."""
    return re.sub(r"(?<!\r)\n", "\r\n", text)


def _quoted_printable(text: str) -> str:
    """nodemailer's quoted-printable: CR and LF stay raw, a space or tab before a line break or at
    the end is encoded, lines are soft-wrapped at 76 characters."""
    data = text.encode("utf-8", "surrogatepass")
    out: list[str] = []
    line = 0
    for i, byte in enumerate(data):
        following = data[i + 1] if i + 1 < len(data) else None
        if byte in (0x0A, 0x0D):
            out.append(chr(byte))
            if byte == 0x0A:
                line = 0
            continue
        raw = byte == 0x09 or 0x20 <= byte <= 0x7E and byte != 0x3D
        if byte in (0x20, 0x09) and following in (None, 0x0A, 0x0D):
            raw = False
        token = chr(byte) if raw else f"={byte:02X}"
        if line + len(token) > 75:
            out.append("=\r\n")
            line = 0
        out.append(token)
        line += len(token)
    return "".join(out)


def _base64_lines(data: bytes) -> str:
    text = base64.b64encode(data).decode("ascii")
    return "\r\n".join(text[i : i + 76] for i in range(0, len(text), 76))


def _long_lines(text: str) -> bool:
    return any(len(line) > 76 for line in re.split(r"\r\n|\r|\n", text))


def _part(content_type: str, content: str) -> tuple[list[tuple[str, str]], str]:
    """Headers and encoded body of one text part."""
    if content == "":
        return [("Content-Type", content_type)], ""
    body = _crlf(content)
    if not _PLAIN_BODY.search(content) and not _long_lines(content):
        encoding, encoded = "7bit", body
    elif text_encoding(content) == "Q":
        encoding, encoded = "quoted-printable", _quoted_printable(body)
    else:
        encoding, encoded = "base64", _base64_lines(body.encode("utf-8", "surrogatepass"))
    return [("Content-Type", content_type + "; charset=utf-8"), ("Content-Transfer-Encoding", encoding)], encoded


# --- messages --------------------------------------------------------------------------------


@dataclass
class Built:
    """A message ready for SMTP: envelope and the DATA bytes (CRLF lines, not dot-stuffed)."""

    sender: str
    recipients: list[str]
    data: bytes
    smtputf8: bool


def _string(value: Any) -> str:
    return value if isinstance(value, str) else "" if value is None else str(value)


def build_message(message: Mapping[str, Any], *, now: datetime | None = None) -> Built:
    """``{from, to, subject, text, html?}`` → envelope and bytes, like nodemailer's MailComposer."""
    sender = address_list(_string(message.get("from")), encode_word)
    to = address_list(_string(message.get("to")), encode_word)
    if not to.recipients:
        raise DeliveryError("No recipients defined")
    envelope_from = sender.recipients[0] if sender.recipients else ""
    headers: list[tuple[str, str]] = []
    if sender.header:
        headers.append(("From", sender.header))
    if to.header:
        headers.append(("To", to.header))
    subject = _string(message.get("subject"))
    if subject:
        encoded = encode_header_text(_NEWLINES.sub(" ", subject))
        if js_trim(encoded):
            headers.append(("Subject", encoded))
    domain = envelope_from.rsplit("@", 1)[-1] if "@" in envelope_from else "localhost"
    headers.append(("Message-ID", f"<{uuid.uuid4()}@{domain}>"))
    text, html = _string(message.get("text")), _string(message.get("html"))
    moment = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    date = format_datetime(moment).replace("-0000", "+0000")
    if text and html:
        boundary = f"--_RtApp-{secrets.token_hex(8)}-Part_1"
        headers += [("Date", date), ("MIME-Version", "1.0"), ("Content-Type", f'multipart/alternative; boundary="{boundary}"')]
        parts = []
        for content_type, content in (("text/plain", text), ("text/html", html)):
            part_headers, part_body = _part(content_type, content)
            parts.append("\r\n".join(f"{k}: {v}" for k, v in part_headers) + "\r\n\r\n" + part_body)
        body = "".join(f"--{boundary}\r\n{part}\r\n" for part in parts) + f"--{boundary}--\r\n"
    else:
        part_headers, body = _part("text/html" if html else "text/plain", html or text)
        content_type = part_headers[0][1]
        encoding = [v for k, v in part_headers if k == "Content-Transfer-Encoding"]
        if encoding:
            headers.append(("Content-Transfer-Encoding", encoding[0]))
        headers += [("Date", date), ("MIME-Version", "1.0"), ("Content-Type", content_type)]
    head = "\r\n".join(fold(f"{key}: {value}") for key, value in headers)
    data = (head + "\r\n\r\n" + body).encode("utf-8", "surrogatepass")
    # nodemailer's LastNewline: the message ends with a line break; a final CR only gets its LF.
    data += b"" if data.endswith(b"\n") else b"\n" if data.endswith(b"\r") else b"\r\n"
    recipients = to.recipients
    return Built(envelope_from, recipients, data, needs_smtputf8([envelope_from, *recipients]))


# --- SMTP ------------------------------------------------------------------------------------


@dataclass(frozen=True)
class SmtpConnection:
    """How to reach an SMTP server (the options nodemailer's SMTP transport uses)."""

    host: str
    port: int
    secure: bool = False
    require_tls: bool = False
    ignore_tls: bool = False
    user: str | None = None
    password: str | None = None
    connection_timeout: float = 10.0
    greeting_timeout: float = 10.0
    socket_timeout: float = 20.0
    tls_context: ssl.SSLContext | None = None


def _hostname() -> str:
    name = socket.gethostname()
    return name if name and name.isascii() else "localhost"


def _connect_host(host: str) -> str:
    return host[1:-1] if host.startswith("[") and host.endswith("]") else host


def _starttls(smtp: smtplib.SMTP, connection: SmtpConnection, context: ssl.SSLContext) -> None:
    code, _ = smtp.docmd("STARTTLS")
    if code != 220:
        raise DeliveryError("STARTTLS refused")
    smtp.sock = context.wrap_socket(smtp.sock, server_hostname=_connect_host(connection.host) or None)  # type: ignore[arg-type]
    smtp.file = None
    smtp.helo_resp = smtp.ehlo_resp = None
    smtp.esmtp_features = {}
    smtp.does_esmtp = False
    smtp.ehlo()


def deliver(connection: SmtpConnection, built: Built) -> None:
    """Send one message; DeliveryError (or an OSError/smtplib error) when it cannot be delivered.

    TLS rules: ``secure`` starts with a TLS handshake; ``require_tls`` sends STARTTLS right after
    EHLO (even when not offered) and fails when it is refused, before any AUTH or MAIL;
    ``ignore_tls`` never upgrades; otherwise STARTTLS is used when offered.
    """
    for address in (built.sender, *built.recipients):
        if "\r" in address or "\n" in address:
            raise DeliveryError("Invalid address")
    context = connection.tls_context or ssl.create_default_context()
    host, local = _connect_host(connection.host) or "localhost", _hostname()
    smtp: smtplib.SMTP
    if connection.secure:
        smtp = smtplib.SMTP_SSL(host, connection.port, local_hostname=local, timeout=connection.connection_timeout, context=context)
    else:
        smtp = smtplib.SMTP(host, connection.port, local_hostname=local, timeout=connection.connection_timeout)
    try:
        if smtp.sock is not None:
            smtp.sock.settimeout(connection.socket_timeout)
        code, _ = smtp.ehlo()
        if code != 250:
            smtp.helo()
        if not connection.secure:
            if connection.require_tls:
                _starttls(smtp, connection, context)
            elif not connection.ignore_tls and smtp.has_extn("starttls"):
                _starttls(smtp, connection, context)
        if connection.user:
            smtp.login(connection.user, connection.password or "")
        params = ""
        if built.smtputf8:
            if not smtp.has_extn("smtputf8"):
                raise DeliveryError("The server does not support SMTPUTF8")
            smtp.command_encoding = "utf-8"
            params = " SMTPUTF8"
        code, _ = smtp.docmd("MAIL", f"FROM:<{built.sender}>{params}")
        if code != 250:
            raise DeliveryError("Sender refused")
        accepted = 0
        for recipient in built.recipients:
            code, _ = smtp.docmd("RCPT", f"TO:<{recipient}>")
            if code in (250, 251):
                accepted += 1
        if not accepted:
            raise DeliveryError("Every recipient was refused")
        code, _ = smtp.data(built.data)
        if code != 250:
            raise DeliveryError("Message refused")
        try:
            smtp.quit()
        except (smtplib.SMTPException, OSError):
            pass
    finally:
        smtp.close()
