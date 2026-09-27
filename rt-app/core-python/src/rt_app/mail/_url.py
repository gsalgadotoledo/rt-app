"""The part of the WHATWG URL parser (JavaScript ``new URL``) that SMTP_URL values need.

``smtp:`` and ``smtps:`` are not special schemes, so their host is an *opaque host*: its case is
kept, non-ASCII characters are percent-encoded and IPv4 numbers are not rewritten. Other schemes
are only checked for validity (the caller refuses them).
"""
from __future__ import annotations

import ipaddress
import re
import urllib.parse
from dataclasses import dataclass

from ._address import _domain_to_ascii, js_lower

SPECIAL = {"ftp": 21, "file": None, "http": 80, "https": 443, "ws": 80, "wss": 443}
_SCHEME = re.compile(r"[A-Za-z][A-Za-z0-9+\-.]*")
_FORBIDDEN_HOST = frozenset("\x00\t\n\r #/:<>?@[\\]^|")
_USERINFO_ENCODE = frozenset(' "#<>?`{}/:;=@[\\]^|')


class URLError(ValueError):
    """``new URL(text)`` throws TypeError "Invalid URL"."""


@dataclass
class URL:
    scheme: str
    username: str = ""
    password: str = ""
    hostname: str = ""
    port: str = ""


def _percent_encode(text: str, extra: frozenset[str]) -> str:
    out = []
    for ch in text:
        if ord(ch) < 0x20 or ord(ch) > 0x7E or ch in extra:
            out.append("".join(f"%{b:02X}" for b in ch.encode("utf-8", "surrogatepass")))
        else:
            out.append(ch)
    return "".join(out)


def serialize_ipv6(packed: bytes) -> str:
    """WHATWG IPv6 serializer: lower-case hex, the first longest run of 2+ zero pieces as ``::``."""
    pieces = [int.from_bytes(packed[i : i + 2], "big") for i in range(0, 16, 2)]
    best_start, best_len = -1, 1
    i = 0
    while i < 8:
        if pieces[i] == 0:
            j = i
            while j < 8 and pieces[j] == 0:
                j += 1
            if j - i > best_len:
                best_start, best_len = i, j - i
            i = j
        else:
            i += 1
    out = ""
    ignore = False
    for i, piece in enumerate(pieces):
        if ignore and piece == 0:
            continue
        ignore = False
        if i == best_start:
            out += "::" if i == 0 else ":"
            ignore = True
            continue
        out += format(piece, "x")
        if i != 7:
            out += ":"
    return out


def _ipv6(text: str) -> str:
    if not text or "%" in text or not all(c in "0123456789abcdefABCDEF:." for c in text):
        raise URLError("Invalid URL")
    try:
        return serialize_ipv6(ipaddress.IPv6Address(text).packed)
    except ValueError:
        raise URLError("Invalid URL") from None


def _port(text: str) -> str:
    if text == "":
        return ""
    if not text.isascii() or not text.isdigit() or int(text) > 65535:
        raise URLError("Invalid URL")
    return str(int(text))


def _host_and_port(text: str, special: bool) -> tuple[str, str]:
    if text.startswith("["):
        end = text.find("]")
        if end < 0:
            raise URLError("Invalid URL")
        host = "[" + _ipv6(text[1:end]) + "]"
        rest = text[end + 1 :]
        if rest and not rest.startswith(":"):
            raise URLError("Invalid URL")
        return host, _port(rest[1:]) if rest else ""
    host, colon, port = text.partition(":")
    if colon and not host:
        raise URLError("Invalid URL")  # a port needs a host
    if special:
        # Special hosts are percent-decoded, then go through "domain to ASCII" (IDNA, forbidden
        # code points, IPv4 numbers); only their validity matters here.
        decoded = urllib.parse.unquote(host, errors="replace")
        if not host or "\ufffd" in decoded or not _domain_to_ascii(js_lower(decoded)):
            raise URLError("Invalid URL")
        return host.lower(), _port(port)
    if any(c in _FORBIDDEN_HOST for c in host):
        raise URLError("Invalid URL")
    return _percent_encode(host, frozenset()), _port(port)


def parse_url(text: str) -> URL:
    """``new URL(text)`` for the fields SMTP_URL needs; URLError when JavaScript would throw."""
    text = text.strip("".join(chr(c) for c in range(0x21)))
    text = re.sub(r"[\t\n\r]", "", text)
    colon = text.find(":")
    if colon <= 0 or not _SCHEME.fullmatch(text[:colon]):
        raise URLError("Invalid URL")
    scheme = text[:colon].lower()
    rest = text[colon + 1 :]
    special = scheme in SPECIAL
    if scheme == "file":
        return URL(scheme)
    if special:
        rest = rest.lstrip("/\\")
        authority = re.split(r"[/\\?#]", rest, maxsplit=1)[0]
    elif rest.startswith("//"):
        authority = re.split(r"[/?#]", rest[2:], maxsplit=1)[0]
    else:
        return URL(scheme)
    url = URL(scheme)
    at = authority.rfind("@")
    if at >= 0:
        userinfo, authority = authority[:at], authority[at + 1 :]
        user, _, password = userinfo.partition(":")
        url.username = _percent_encode(user, _USERINFO_ENCODE)
        url.password = _percent_encode(password, _USERINFO_ENCODE)
        if not authority:
            raise URLError("Invalid URL")
    url.hostname, url.port = _host_and_port(authority, special)
    return url


_BAD_PERCENT = re.compile(r"%(?![0-9A-Fa-f]{2})")


def decode_uri_component(text: str) -> str:
    """JavaScript ``decodeURIComponent``: ValueError("URI malformed") on bad escapes or bad UTF-8."""
    if _BAD_PERCENT.search(text):
        raise ValueError("URI malformed")
    out = bytearray()
    i = 0
    while i < len(text):
        if text[i] == "%":
            out.append(int(text[i + 1 : i + 3], 16))
            i += 3
        else:
            out.extend(text[i].encode("utf-8", "surrogatepass"))
            i += 1
    try:
        return out.decode("utf-8")
    except UnicodeDecodeError:
        raise ValueError("URI malformed") from None
