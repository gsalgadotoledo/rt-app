"""Mailers (rt_app.mail): address rules, message building, SMTP delivery and TLS requirements."""
from __future__ import annotations

import base64
import os
import shutil
import socket
import ssl
import subprocess
import tempfile
import threading
import unittest
from datetime import datetime, timezone

from rt_app.auth import LocalMailbox
from rt_app.errors import HttpError
from rt_app.mail import LocalSmtpMailer, SmtpMailer, mail_config, mailbox_feature, smtp_options
from rt_app.mail._address import address_list, normalize_address, parse_addresses, punycode_decode, punycode_encode
from rt_app.mail._mime import build_message, encode_word
from rt_app.mail.smtp import SmtpClientTransport
from rt_app.web import App
from rt_app.web.app import Request


class Sink:
    """A tiny SMTP server on 127.0.0.1 (optionally with STARTTLS) that records what it receives."""

    def __init__(self, context: ssl.SSLContext | None = None, reject: tuple[str, ...] = ()) -> None:
        self.context, self.reject = context, reject
        self.commands: list[str] = []
        self.messages: list[dict] = []
        self.auth: list[str] = []
        self.server = socket.create_server(("127.0.0.1", 0))
        self.port = self.server.getsockname()[1]
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self) -> None:
        while True:
            try:
                conn, _ = self.server.accept()
            except OSError:
                return
            threading.Thread(target=self._session, args=(conn,), daemon=True).start()

    def _session(self, conn: socket.socket) -> None:
        stream = conn.makefile("rwb")
        tls = False

        def reply(line: str) -> None:
            stream.write(line.encode() + b"\r\n")
            stream.flush()

        envelope: dict = {"from": None, "to": []}
        try:
            reply("220 test ESMTP")
            while True:
                line = stream.readline().decode("utf-8", "replace").rstrip("\r\n")
                if not line:
                    return
                verb = line.split(" ")[0].split(":")[0].upper()
                self.commands.append(verb + ("+tls" if tls else ""))
                if verb == "EHLO":
                    features = ["test", "SMTPUTF8"] + (["STARTTLS"] if self.context and not tls else []) + ["AUTH PLAIN"]
                    for i, feature in enumerate(features):
                        reply(("250 " if i == len(features) - 1 else "250-") + feature)
                elif verb == "STARTTLS" and self.context and not tls:
                    reply("220 go ahead")
                    stream.close()
                    conn = self.context.wrap_socket(conn, server_side=True)
                    stream = conn.makefile("rwb")
                    tls = True
                elif verb == "AUTH":
                    self.auth.append(base64.b64decode(line.split(" ")[2]).decode())
                    reply("235 ok")
                elif verb == "MAIL":
                    envelope = {"from": line[line.index("<") + 1 : line.rindex(">")], "to": [], "smtputf8": "SMTPUTF8" in line}
                    reply("250 ok")
                elif verb == "RCPT":
                    address = line[line.index("<") + 1 : line.rindex(">")]
                    if address in self.reject:
                        reply("550 no")
                    else:
                        envelope["to"].append(address)
                        reply("250 ok")
                elif verb == "DATA":
                    reply("354 go")
                    lines = []
                    while (data := stream.readline()) != b".\r\n":
                        lines.append(data[1:] if data.startswith(b"..") else data)
                    self.messages.append({**envelope, "data": b"".join(lines).decode()})
                    reply("250 queued")
                elif verb == "QUIT":
                    reply("221 bye")
                    return
                else:
                    reply("454 no")
        except (OSError, ValueError, ssl.SSLError):
            return
        finally:
            stream.close()
            conn.close()

    def close(self) -> None:
        self.server.close()


class AddressTest(unittest.TestCase):
    def test_nodemailer_address_lists(self) -> None:
        self.assertEqual(parse_addresses('Ana <ana@example.com>, "Doe, John" <j@example.com>'), [{"address": "ana@example.com", "name": "Ana"}, {"address": "j@example.com", "name": "Doe, John"}])
        self.assertEqual(parse_addresses("Team: a@x.com, b@x.com;")[0]["group"], [{"address": "a@x.com", "name": ""}, {"address": "b@x.com", "name": ""}])
        self.assertEqual(address_list("a@x.com\r\nRCPT TO:<evil@x.com>", encode_word).recipients, ["evil@x.com"])
        self.assertEqual(address_list("root", encode_word).recipients, [])
        self.assertEqual(address_list("Ana ana@example.com", encode_word).header, "Ana <ana@example.com>")

    def test_normalization(self) -> None:
        self.assertEqual(normalize_address("User@EXÄMPLE.com"), "User@xn--exmple-cua.com")
        self.assertEqual(normalize_address("ñandú@XN--EXMPLE-CUA.com"), "ñandú@exämple.com")
        self.assertEqual(normalize_address('"user@evil"@good.com'), '"user@evil"@good.com')
        self.assertEqual(normalize_address("a b@c.com"), '"a b"@c.com')
        self.assertEqual(normalize_address("a@0x7f.1"), "a@127.0.0.1")
        self.assertEqual(punycode_encode("bücher"), "bcher-kva")
        self.assertEqual(punycode_decode("bcher-kva"), "bücher")


class MessageTest(unittest.TestCase):
    def test_headers_cannot_be_injected(self) -> None:
        built = build_message({"from": "RT-App <no-reply@rt-app.test>", "to": "a@example.com", "subject": "Hi\r\nBcc: evil@x.com", "text": "t"}, now=datetime(2026, 1, 2, tzinfo=timezone.utc))
        head = built.data.decode().split("\r\n\r\n")[0]
        self.assertIn("\r\nSubject: Hi Bcc: evil@x.com\r\n", head)
        self.assertNotIn("\r\nBcc:", head)
        self.assertIn("Date: Fri, 02 Jan 2026 00:00:00 +0000", head)
        self.assertEqual((built.sender, built.recipients, built.smtputf8), ("no-reply@rt-app.test", ["a@example.com"], False))

    def test_encoded_subjects_and_bodies(self) -> None:
        data = build_message({"from": "a@b.c", "to": "x@y.z", "subject": "Café ☕", "text": "é\n.\nline", "html": "<p>x</p>"}).data.decode()
        self.assertIn("Subject: =?UTF-8?", data)
        self.assertIn("multipart/alternative", data)
        self.assertTrue(data.endswith("--\r\n"))


class LocalSmtpTest(unittest.TestCase):
    def setUp(self) -> None:
        self.sink = Sink()
        self.addCleanup(self.sink.close)

    def test_delivers_then_captures(self) -> None:
        mailbox = LocalMailbox(now=lambda: 1767323045678)
        mailer = LocalSmtpMailer(self.sink.port, mailbox, env={})
        mailer.send_code("ana@example.com", "123456", "Sign in")
        self.assertEqual(self.sink.messages[0]["to"], ["ana@example.com"])
        self.assertIn("Your code is 123456.", self.sink.messages[0]["data"])
        self.assertEqual(mailbox.messages, [{"email": "ana@example.com", "code": "123456", "purpose": "Sign in", "at": "2026-01-02T03:04:05.678Z"}])
        self.assertEqual(self.sink.commands, ["EHLO", "MAIL", "RCPT", "DATA", "QUIT"])

    def test_failures_are_503_and_not_captured(self) -> None:
        mailbox = LocalMailbox()
        self.sink.close()
        with self.assertRaises(HttpError) as raised:
            LocalSmtpMailer(self.sink.port, mailbox, env={}).send_code("a@b.c", "1", "x")
        self.assertEqual((raised.exception.status, raised.exception.message), (503, "Local inbox is unavailable. Start it with npm run mail or restart npm run dev."))
        self.assertEqual(mailbox.messages, [])

    def test_construction_rules(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "^Local SMTP is disabled in production$"):
            LocalSmtpMailer(1, env={"NODE_ENV": "production"})
        for port in (1023, 65536, 1025.5, "2525", True):
            with self.assertRaisesRegex(ValueError, "^Invalid local SMTP port$"):
                LocalSmtpMailer(port, env={})
        self.assertEqual(LocalSmtpMailer(env={}).port, 1025)

    def test_mail_config(self) -> None:
        self.assertEqual(mail_config({}).url, "http://127.0.0.1:8025")
        self.assertEqual(mail_config({"RT_APP_MAIL_SMTP_PORT": "0x401", "RT_APP_MAIL_UI_PORT": "2e3"}).smtp_port, 1025)
        with self.assertRaisesRegex(ValueError, "must differ"):
            mail_config({"RT_APP_MAIL_UI_PORT": "1025"})
        with self.assertRaisesRegex(ValueError, "integers between"):
            mail_config({"RT_APP_MAIL_SMTP_PORT": ""})

    def test_mailbox_feature(self) -> None:
        mailbox = LocalMailbox(now=lambda: 0)
        mailbox.send_code("a@b.c", "1", "login")
        app = App([mailbox_feature(mailbox)])
        response = app.handle(Request(method="GET", path="/__dev/mailbox"))
        self.assertEqual((response.status, response.body), (200, [{"email": "a@b.c", "code": "1", "purpose": "login", "at": "1970-01-01T00:00:00.000Z"}]))
        self.assertEqual(app.handle(Request(method="POST", path="/__dev/mailbox")).status, 404)


class SmtpTest(unittest.TestCase):
    def test_options(self) -> None:
        options = smtp_options("smtps://re%40send:p%3Ass@smtp.resend.com")
        self.assertEqual((options.host, options.port, options.secure, options.require_tls, options.auth.user, options.auth.password), ("smtp.resend.com", 465, True, False, "re@send", "p:ss"))
        self.assertEqual(smtp_options("smtp://[0:0::1]:0025").host, "[::1]")
        with self.assertRaisesRegex(ValueError, "must use smtp://"):
            smtp_options("http://smtp.example.com")
        with self.assertRaisesRegex(ValueError, "must be a URL"):
            smtp_options("smtp://h:99999")
        with self.assertRaisesRegex(ValueError, "^URI malformed$"):
            smtp_options("smtp://u:%zz@h")

    def test_fake_transport_and_errors(self) -> None:
        sent: list = []

        class Fake:
            def send_mail(self, message):
                sent.append(message)

        SmtpMailer("not a url", "App <a@b.c>", Fake()).send_code("x@y.z", "1", "login")
        self.assertEqual(sent[0]["from"], "App <a@b.c>")

        class Failing:
            def send_mail(self, message):
                raise RuntimeError("535 secret")

        with self.assertRaises(HttpError) as raised:
            SmtpMailer("smtps://h", "a@b.c", Failing()).send({"to": "x@y.z", "subject": "s", "text": "t"})
        self.assertEqual(raised.exception.message, "Email delivery is temporarily unavailable")
        with self.assertRaisesRegex(ValueError, "MAIL_FROM is required"):
            SmtpMailer("smtps://h", "")

    def test_plain_servers_never_see_credentials(self) -> None:
        sink = Sink()
        self.addCleanup(sink.close)
        with self.assertRaises(HttpError):
            SmtpMailer(f"smtp://user:secret@127.0.0.1:{sink.port}", "a@b.c").send({"to": "x@y.z", "subject": "s", "text": "t"})
        self.assertEqual(sink.commands[:2], ["EHLO", "STARTTLS"])
        self.assertNotIn("AUTH", sink.commands)
        self.assertEqual(sink.auth, [])

    @unittest.skipUnless(shutil.which("openssl"), "needs openssl to create a test certificate")
    def test_starttls_then_auth_then_delivery(self) -> None:
        folder = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, folder, True)
        cert, key = os.path.join(folder, "cert.pem"), os.path.join(folder, "key.pem")
        subprocess.run(
            ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"],
            check=True,
            capture_output=True,
        )
        server = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
        server.load_cert_chain(cert, key)
        sink = Sink(server)
        self.addCleanup(sink.close)
        client = ssl.create_default_context(cafile=cert)
        transport = SmtpClientTransport(smtp_options(f"smtp://us%40er:p%3Ass@127.0.0.1:{sink.port}"), tls_context=client)
        SmtpMailer("unused", "App <a@b.c>", transport).send_code("ñ@exämple.com", "123456", "login")
        self.assertEqual(sink.commands[:2], ["EHLO", "STARTTLS"])
        self.assertIn("AUTH+tls", sink.commands)
        self.assertEqual(sink.auth, ["\x00us@er\x00p:ss"])
        self.assertEqual(sink.messages[0]["to"], ["ñ@exämple.com"])
        self.assertTrue(sink.messages[0]["smtputf8"])


if __name__ == "__main__":
    unittest.main()
