"""Subjects: mail-local, mail-smtp (mirrors hosts/node/mail.mjs; see the mail contracts).

Mail goes to an in-process SMTP sink on 127.0.0.1 whose decoder is the same in every host:
delivered() → [{mailFrom, rcptTo, smtputf8, headers, contentType, text, html}].
"""
from __future__ import annotations

import base64
import re
import socketserver
import threading
from datetime import datetime
from typing import Any

from rt_app.auth import LocalMailbox
from rt_app.contracts import epoch_ms
from rt_app.mail import LocalSmtpMailer, SmtpMailer, mail_config, smtp_options
from rt_app.mail.smtp import SmtpOptions

VERBS = {"EHLO", "HELO", "STARTTLS", "AUTH", "MAIL", "RCPT", "DATA"}
HIDDEN = {"date", "message-id", "mime-version", "content-type", "content-transfer-encoding"}
DEFAULT_NOW = "2026-01-02T03:04:05.678Z"
_WORD = re.compile(r"=\?([^?\s]+)\?([QqBb])\?([^?\s]*)\?=")
_HEX = re.compile(r"=([0-9A-Fa-f]{2})")


# --- the sink's decoder (identical in every host) --------------------------------------------


def _q_bytes(text: str) -> bytes:
    return _HEX.sub(lambda m: chr(int(m.group(1), 16)), text).encode("latin-1")


def _b64(text: str) -> bytes:
    text = re.sub(r"[^A-Za-z0-9+/]", "", text)
    return base64.b64decode(text + "=" * (-len(text) % 4))


def decode_words(value: str) -> str:
    """RFC 2047 encoded words; whitespace between two adjacent encoded words is dropped."""
    out: list[str] = []
    pending: list[bytes] = []
    last = 0

    def flush() -> None:
        if pending:
            out.append(b"".join(pending).decode("utf-8", "replace"))
            pending.clear()

    for match in _WORD.finditer(value):
        between = value[last : match.start()]
        if not (pending and re.fullmatch(r"[ \t]*", between)):
            flush()
            out.append(between)
        encoding, text = match.group(2), match.group(3)
        pending.append(_b64(text) if encoding.upper() == "B" else _q_bytes(text.replace("_", " ")))
        last = match.end()
    flush()
    return "".join(out) + value[last:]


def _header_fields(block: str) -> list[list[str]]:
    fields: list[list[str]] = []
    for line in block.split("\r\n"):
        if line[:1] in (" ", "\t") and fields:
            fields[-1][1] += line
        elif line:
            colon = line.find(":")
            if colon > 0:
                fields.append([line[:colon].strip().lower(), line[colon + 1 :]])
    return [[name, value[1:] if value.startswith(" ") else value] for name, value in fields]


def _decode_body(body: str, encoding: str | None) -> str:
    kind = (encoding or "").strip().lower()
    if kind == "base64":
        data = _b64(body)
    elif kind == "quoted-printable":
        data = _q_bytes(body.replace("=\r\n", ""))
    else:
        data = body.encode("latin-1")
    text = data.decode("utf-8", "replace").replace("\r\n", "\n")
    return text[:-1] if text.endswith("\n") else text


def _media_type(value: str | None) -> str:
    return (value if value is not None else "text/plain").split(";")[0].strip().lower()


def _parameter(value: str | None, name: str) -> str | None:
    match = re.search(r";\s*" + name + r'\s*=\s*(?:"([^"]*)"|([^;\s]*))', value or "", re.IGNORECASE)
    return (match.group(1) if match.group(1) is not None else match.group(2)) if match else None


def decode_message(data: str) -> dict[str, Any]:
    """A message as received (latin-1 text of the DATA bytes, dot-unstuffed) → the decoded view."""
    split = data.find("\r\n\r\n")
    head, body = (data, "") if split < 0 else (data[:split], data[split + 4 :])
    fields = _header_fields(head)

    def field(name: str) -> str | None:
        return next((v for n, v in fields if n == name), None)

    headers: dict[str, Any] = {}
    for name, raw in fields:
        if name in HIDDEN:
            continue
        value = decode_words(raw.encode("latin-1").decode("utf-8", "replace"))
        if name in headers:
            previous = headers[name]
            headers[name] = (previous if isinstance(previous, list) else [previous]) + [value]
        else:
            headers[name] = value
    content_type = _media_type(field("content-type"))
    text = html = None
    if content_type.startswith("multipart/"):
        boundary = _parameter(field("content-type"), "boundary") or ""
        for part in body.split("--" + boundary)[1:]:
            if part.startswith("--"):
                break
            content = re.sub(r"\r\n$", "", re.sub(r"^\r\n", "", part))
            at = content.find("\r\n\r\n")
            part_fields = _header_fields(content if at < 0 else content[:at])
            part_field = lambda name: next((v for n, v in part_fields if n == name), None)  # noqa: E731
            decoded = _decode_body("" if at < 0 else content[at + 4 :], part_field("content-transfer-encoding"))
            kind = _media_type(part_field("content-type"))
            if kind == "text/plain":
                text = decoded
            elif kind == "text/html":
                html = decoded
    else:
        decoded = _decode_body(body, field("content-transfer-encoding"))
        if content_type == "text/html":
            html = decoded
        else:
            text = decoded
    return {"headers": headers, "contentType": content_type, "text": text, "html": html}


def _path(argument: str) -> tuple[str, list[str]]:
    text = argument.strip()
    if not text.startswith("<"):
        parts = text.split(" ")
        return parts[0], parts[1:]
    end = text.rfind(">")
    return text[1:end], [p for p in text[end + 1 :].strip().split() if p]


class SmtpSink:
    """An SMTP sink on 127.0.0.1: starttls/auth only advertise; reject answers RCPT with 550."""

    def __init__(self, starttls: bool = False, auth: bool = False, reject: list[str] | None = None) -> None:
        self.messages: list[dict[str, Any]] = []
        self.commands: list[str] = []
        self._lock = threading.Lock()
        sink = self
        options = {"starttls": starttls, "auth": auth, "reject": list(reject or [])}

        class Handler(socketserver.StreamRequestHandler):
            def handle(self) -> None:
                sink._session(self.rfile, self.wfile, options)

        class Server(socketserver.ThreadingTCPServer):
            allow_reuse_address = True
            daemon_threads = True

        self._server = Server(("127.0.0.1", 0), Handler)
        self.port = self._server.server_address[1]
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    def _session(self, rfile: Any, wfile: Any, options: dict[str, Any]) -> None:
        def reply(line: str) -> None:
            wfile.write((line + "\r\n").encode("utf-8"))
            wfile.flush()

        envelope: dict[str, Any] = {"from": None, "to": [], "smtputf8": False}
        try:
            reply("220 rt-app-sink ESMTP")
            while True:
                raw = rfile.readline()
                if not raw:
                    return
                line = raw.rstrip(b"\r\n").decode("utf-8", "replace")
                verb = line.split(" ")[0].split(":")[0].upper()
                if verb in VERBS:
                    with self._lock:
                        self.commands.append(verb)
                argument = line[line.find(":") + 1 :]
                if verb == "EHLO":
                    lines = ["rt-app-sink", "8BITMIME", "SMTPUTF8"] + (["STARTTLS"] if options["starttls"] else []) + (["AUTH PLAIN LOGIN"] if options["auth"] else [])
                    for i, text in enumerate(lines):
                        reply(f"250{' ' if i == len(lines) - 1 else '-'}{text}")
                elif verb == "HELO":
                    reply("250 rt-app-sink")
                elif verb == "MAIL":
                    address, params = _path(argument)
                    envelope = {"from": address, "to": [], "smtputf8": any(p.upper() == "SMTPUTF8" for p in params)}
                    reply("250 2.1.0 ok")
                elif verb == "RCPT":
                    address, _ = _path(argument)
                    if address in options["reject"]:
                        reply("550 5.1.1 rejected")
                    else:
                        envelope["to"].append(address)
                        reply("250 2.1.5 ok")
                elif verb == "DATA":
                    if not envelope["to"]:
                        reply("554 5.5.1 no valid recipients")
                        continue
                    reply("354 end with .")
                    lines_in: list[bytes] = []
                    while True:
                        data_line = rfile.readline()
                        if not data_line:
                            return
                        if data_line == b".\r\n":
                            break
                        lines_in.append(data_line[1:] if data_line.startswith(b"..") else data_line)
                    text = b"".join(lines_in).decode("latin-1")
                    with self._lock:
                        self.messages.append({"mailFrom": envelope["from"], "rcptTo": envelope["to"], "smtputf8": envelope["smtputf8"], **decode_message(text)})
                    envelope = {"from": None, "to": [], "smtputf8": False}
                    reply("250 2.0.0 queued")
                elif verb == "QUIT":
                    reply("221 2.0.0 bye")
                    return
                elif verb == "RSET":
                    envelope = {"from": None, "to": [], "smtputf8": False}
                    reply("250 ok")
                elif verb == "NOOP":
                    reply("250 ok")
                elif verb == "STARTTLS":
                    reply("454 4.7.0 TLS not available")
                elif verb == "AUTH":
                    reply("535 5.7.8 authentication refused")
                else:
                    reply("502 5.5.2 unknown command")
        except (OSError, ValueError):
            return

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()


# --- subjects --------------------------------------------------------------------------------


def _init(init: Any) -> dict[str, Any]:
    return init if isinstance(init, dict) else {}


class MailLocalSubject:
    def __init__(self, init: Any) -> None:
        init = _init(init)
        self._sink = SmtpSink(**(init.get("sink") or {}))
        now = init.get("now") or DEFAULT_NOW
        self._now_ms = epoch_ms(lambda: datetime.fromisoformat(now.replace("Z", "+00:00")))
        self._capture = None if init.get("capture") is False else LocalMailbox(now=lambda: self._now_ms)
        env = {} if init.get("nodeEnv") is None else {"NODE_ENV": init["nodeEnv"]}
        if init.get("defaultPort"):
            port_args: dict[str, Any] = {}
        elif "port" in init and init["port"] is not None:
            port_args = {"port": init["port"]}
        else:
            port_args = {"port": self._sink.port}
        try:
            self._mailer = LocalSmtpMailer(capture=self._capture, env=env, **port_args)
        except BaseException:
            self._sink.close()
            raise
        self._stopped = False

    def send(self, message: Any) -> None:
        self._mailer.send(message)

    def send_code(self, email: Any, code: Any, purpose: Any) -> None:
        self._mailer.send_code(email, code, purpose)

    def delivered(self) -> list[dict[str, Any]]:
        return self._sink.messages

    def commands(self) -> list[str]:
        return self._sink.commands

    def mailbox(self) -> Any:
        return None if self._capture is None else self._capture.messages

    def stop_sink(self) -> None:
        self._stop()

    def set_now(self, iso: str) -> None:
        self._now_ms = epoch_ms(lambda: datetime.fromisoformat(iso.replace("Z", "+00:00")))

    def mail_config(self, env: Any) -> dict[str, Any]:
        config = mail_config(env or {})
        return {"smtpPort": config.smtp_port, "uiPort": config.ui_port, "url": config.url}

    def _stop(self) -> None:
        if not self._stopped:
            self._stopped = True
            self._sink.close()

    def close(self) -> None:
        self._stop()


def _options(options: SmtpOptions) -> dict[str, Any]:
    return {
        "host": options.host,
        "port": options.port,
        "secure": options.secure,
        "requireTLS": options.require_tls,
        "auth": None if options.auth is None else {"user": options.auth.user, "pass": options.auth.password},
        "connectionTimeout": options.connection_timeout,
        "greetingTimeout": options.greeting_timeout,
        "socketTimeout": options.socket_timeout,
        "disableFileAccess": options.disable_file_access,
        "disableUrlAccess": options.disable_url_access,
    }


class _Recorder:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    def send_mail(self, message: Any) -> None:
        self.sent.append(dict(message))


class _Failing:
    def __init__(self, url: str) -> None:
        self._url = url

    def send_mail(self, message: Any) -> None:
        raise RuntimeError(f"535 auth failed for {self._url}")


class MailSmtpSubject:
    def __init__(self, init: Any) -> None:
        init = _init(init)
        kind = init.get("transport") or "fake"
        self._recorder = _Recorder()
        self._sink = SmtpSink(**(init.get("sink") or {})) if kind == "sink" else None
        url = init.get("url")
        if self._sink is not None:
            url = url.replace("{port}", str(self._sink.port))
        transport = {"fake": self._recorder, "failing": _Failing(str(url))}.get(kind)
        try:
            self._mailer = SmtpMailer(url, init.get("from"), transport)
        except BaseException:
            if self._sink is not None:
                self._sink.close()
            raise

    def send(self, message: Any) -> None:
        self._mailer.send(message)

    def send_code(self, email: Any, code: Any, purpose: Any) -> None:
        self._mailer.send_code(email, code, purpose)

    def sent(self) -> list[dict[str, Any]]:
        return self._recorder.sent

    def delivered(self) -> list[dict[str, Any]]:
        return [] if self._sink is None else self._sink.messages

    def commands(self) -> list[str]:
        return [] if self._sink is None else self._sink.commands

    def smtp_options(self, url: Any) -> dict[str, Any]:
        return _options(smtp_options(url))

    def close(self) -> None:
        if self._sink is not None:
            self._sink.close()


SUBJECTS = {"mail-local": MailLocalSubject, "mail-smtp": MailSmtpSubject}
