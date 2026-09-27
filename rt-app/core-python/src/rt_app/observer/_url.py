"""The part of the WHATWG URL parser (JavaScript ``new URL``) the Observer relies on.

``parse(text, base)`` returns a ``URL`` or raises ``ValueError("Invalid URL")``. It follows the URL
Standard for special schemes (http, https, ws, wss, ftp): trimming, tab/newline removal, relative
resolution against a base, backslashes as slashes, credentials, IPv4 (decimal, octal and hex parts)
and IPv6 hosts, ports, dot segments and the path, query and fragment percent-encode sets (the path
set includes ``^`` like Node 24). Other schemes are only checked roughly (``file:`` is accepted
as is, other schemes need a valid opaque host when they have one) because the Observer rejects them
anyway. Non-ASCII domains are lowercased and Punycode-encoded label by label, without the full
UTS #46 mapping.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

SPECIAL = {"http": 80, "https": 443, "ws": 80, "wss": 443, "ftp": 21, "file": None}

_SCHEME = re.compile(r"[A-Za-z][A-Za-z0-9+.\-]*:")
_LONE_SURROGATE = re.compile("[\ud800-\udfff]")
_FORBIDDEN_HOST = set("\x00\t\n\r #/:<>?@[\\]^|")
_FORBIDDEN_DOMAIN = _FORBIDDEN_HOST | {chr(c) for c in range(0x20)} | {"%", "\x7f"}

_C0 = {chr(c) for c in range(0x20)}
_FRAGMENT_SET = _C0 | set(' "<>`')
_QUERY_SET = _C0 | set(' "#<>')
_SPECIAL_QUERY_SET = _QUERY_SET | {"'"}
_PATH_SET = _QUERY_SET | set("?^`{}")
_USERINFO_SET = _PATH_SET | set("/:;=@[\\]|")


class InvalidURL(ValueError):
    """The input is not a URL (JavaScript: TypeError "Invalid URL")."""

    def __init__(self) -> None:
        super().__init__("Invalid URL")


@dataclass
class URL:
    scheme: str
    username: str = ""
    password: str = ""
    host: str | None = None
    port: int | None = None
    path: list[str] = field(default_factory=list)
    opaque: str | None = None
    query: str | None = None
    fragment: str | None = None

    @property
    def protocol(self) -> str:
        return self.scheme + ":"

    @property
    def pathname(self) -> str:
        return self.opaque if self.opaque is not None else "/" + "/".join(self.path) if self.path or self.scheme in SPECIAL else ""

    @property
    def href(self) -> str:
        """The serialized URL (``url.href``)."""
        out = self.scheme + ":"
        if self.host is not None:
            out += "//"
            if self.username or self.password:
                out += self.username + (":" + self.password if self.password else "") + "@"
            out += self.host + (f":{self.port}" if self.port is not None else "")
        out += self.pathname
        if self.query is not None:
            out += "?" + self.query
        if self.fragment is not None:
            out += "#" + self.fragment
        return out


def _encode(text: str, keep_out: set[str]) -> str:
    """UTF-8 percent-encode the characters in ``keep_out`` and every one above U+007E."""
    out = []
    for ch in text:
        if ch in keep_out or ord(ch) > 0x7E:
            out.extend(f"%{b:02X}" for b in ch.encode("utf-8"))
        else:
            out.append(ch)
    return "".join(out)


def parse(text: str, base: URL | None = None) -> URL:
    """``new URL(text, base)``: raises ``InvalidURL`` when the input is not a URL."""
    if not isinstance(text, str):
        raise InvalidURL()
    text = _LONE_SURROGATE.sub("\ufffd", text)
    text = text.strip("".join(chr(c) for c in range(0x21)))
    text = text.replace("\t", "").replace("\n", "").replace("\r", "")
    match = _SCHEME.match(text)
    if match:
        scheme, rest = match.group()[:-1].lower(), text[match.end() :]
        if scheme == "file":
            return URL("file", host="", path=[_encode(rest, _PATH_SET)])
        if scheme not in SPECIAL:
            return _non_special(scheme, rest)
        if base is not None and base.scheme == scheme:
            if rest.startswith("//"):
                return _authority(scheme, rest[2:].lstrip("/\\"))
            return _relative(rest, base)
        return _authority(scheme, rest.lstrip("/\\"))
    if base is None:
        raise InvalidURL()
    return _relative(text, base)


def _relative(rest: str, base: URL) -> URL:
    """Relative reference against a special base URL."""
    url = URL(base.scheme, base.username, base.password, base.host, base.port, list(base.path))
    if rest == "":
        url.query = base.query
        return url
    first = rest[0]
    if first in "/\\":
        if len(rest) > 1 and rest[1] in "/\\":
            return _authority(base.scheme, rest[2:].lstrip("/\\"))
        url.path = []
        return _path(url, rest[1:], relative=False)
    if first == "?":
        return _path(url, rest, relative=True, keep_path=True)
    if first == "#":
        url.query = base.query
        url.fragment = _encode(rest[1:], _FRAGMENT_SET)
        return url
    url.path = url.path[:-1]
    return _path(url, rest, relative=True)


def _authority(scheme: str, rest: str) -> URL:
    """Credentials, host and port of a special URL, then its path."""
    end = len(rest)
    for i, ch in enumerate(rest):
        if ch in "/\\?#":
            end = i
            break
    authority, rest = rest[:end], rest[end:]
    url = URL(scheme)
    if "@" in authority:
        credentials, _, authority = authority.rpartition("@")
        credentials = credentials.replace("@", "%40")
        username, _, password = credentials.partition(":")
        url.username = _encode(username, _USERINFO_SET)
        url.password = _encode(password, _USERINFO_SET)
        if authority == "":
            raise InvalidURL()
    host, port = _split_port(authority)
    if host == "":
        raise InvalidURL()
    url.host = _host(host)
    if port:
        if not port.isascii() or not port.isdigit() or int(port) > 65535:
            raise InvalidURL()
        url.port = None if int(port) == SPECIAL[scheme] else int(port)
    if rest.startswith(("/", "\\")):
        rest = rest[1:]
    return _path(url, rest, relative=False)


def _split_port(authority: str) -> tuple[str, str]:
    inside = False
    for i, ch in enumerate(authority):
        if ch == "[":
            inside = True
        elif ch == "]":
            inside = False
        elif ch == ":" and not inside:
            return authority[:i], authority[i + 1 :]
    return authority, ""


def _path(url: URL, rest: str, *, relative: bool, keep_path: bool = False) -> URL:
    """Path segments (``rest`` without its leading slash), then query and fragment."""
    cut = len(rest)
    for i, ch in enumerate(rest):
        if ch in "?#":
            cut = i
            break
    path_text, tail = rest[:cut], rest[cut:]
    if not keep_path:
        segments = re.split(r"[/\\]", path_text)
        for i, segment in enumerate(segments):
            segment = _encode(segment, _PATH_SET)
            last = i == len(segments) - 1
            lowered = segment.lower()
            if lowered in ("..", ".%2e", "%2e.", "%2e%2e"):
                if url.path:
                    url.path.pop()
                if last:
                    url.path.append("")
            elif lowered in (".", "%2e"):
                if last:
                    url.path.append("")
            else:
                url.path.append(segment)
    if tail.startswith("?"):
        query, hashed, fragment = tail[1:].partition("#")
        url.query = _encode(query, _SPECIAL_QUERY_SET)
        if hashed:
            url.fragment = _encode(fragment, _FRAGMENT_SET)
    elif tail.startswith("#"):
        url.fragment = _encode(tail[1:], _FRAGMENT_SET)
    return url


def _non_special(scheme: str, rest: str) -> URL:
    """Other schemes: an opaque host when there is an authority, otherwise an opaque path."""
    if rest.startswith("//"):
        end = len(rest)
        for i, ch in enumerate(rest[2:], 2):
            if ch in "/?#":
                end = i
                break
        authority = rest[2:end].rpartition("@")[2]
        host, port = _split_port(authority)
        if host.startswith("["):
            host = "[" + _ipv6(host) + "]"
        elif any(ch in _FORBIDDEN_HOST for ch in host):
            raise InvalidURL()
        if port and (not port.isascii() or not port.isdigit() or int(port) > 65535):
            raise InvalidURL()
        return URL(scheme, host=host, opaque=rest[end:])
    return URL(scheme, opaque=rest)


# ---------------------------------------------------------------- hosts


def _host(text: str) -> str:
    if text.startswith("["):
        if not text.endswith("]"):
            raise InvalidURL()
        return "[" + _ipv6(text[1:-1]) + "]"
    from urllib.parse import unquote_to_bytes

    domain = unquote_to_bytes(text).decode("utf-8", "replace")
    ascii_domain = _to_ascii(domain)
    if not ascii_domain or any(ch in _FORBIDDEN_DOMAIN for ch in ascii_domain):
        raise InvalidURL()
    if _ends_in_number(ascii_domain):
        return _ipv4(ascii_domain)
    return ascii_domain


def _to_ascii(domain: str) -> str:
    """Lowercase; non-ASCII labels become Punycode (no full UTS #46 mapping)."""
    labels = []
    for label in domain.lower().split("."):
        if label.isascii():
            labels.append(label)
        else:
            try:
                labels.append("xn--" + label.encode("punycode").decode("ascii"))
            except UnicodeError:
                raise InvalidURL() from None
    return ".".join(labels)


def _ipv4_number(text: str) -> int | None:
    if text == "":
        return None
    radix = 10
    if text[:2] in ("0x", "0X"):
        radix, text = 16, text[2:]
    elif len(text) > 1 and text[0] == "0":
        radix, text = 8, text[1:]
    if text == "":
        return 0
    digits = {10: "0123456789", 8: "01234567", 16: "0123456789abcdefABCDEF"}[radix]
    if any(ch not in digits for ch in text):
        return None
    return int(text, radix)


def _ends_in_number(domain: str) -> bool:
    parts = domain.split(".")
    if parts[-1] == "":
        if len(parts) == 1:
            return False
        parts.pop()
    last = parts[-1]
    if last and last.isascii() and last.isdigit():
        return True
    return _ipv4_number(last) is not None


def _ipv4(domain: str) -> str:
    parts = domain.split(".")
    if parts[-1] == "" and len(parts) > 1:
        parts.pop()
    if len(parts) > 4:
        raise InvalidURL()
    numbers = [_ipv4_number(part) for part in parts]
    if any(n is None for n in numbers):
        raise InvalidURL()
    values: list[int] = numbers  # type: ignore[assignment]
    if any(n > 255 for n in values[:-1]) or values[-1] >= 256 ** (5 - len(values)):
        raise InvalidURL()
    address = values[-1]
    for i, n in enumerate(values[:-1]):
        address += n * 256 ** (3 - i)
    return ".".join(str((address >> shift) & 255) for shift in (24, 16, 8, 0))


def _ipv6(text: str) -> str:
    """Parse (URL Standard IPv6 parser) and serialize an IPv6 address without brackets."""
    pieces = [0] * 8
    index, compress, i, n = 0, None, 0, len(text)
    hexdigits = "0123456789abcdefABCDEF"
    if text.startswith(":"):
        if not text.startswith("::"):
            raise InvalidURL()
        i, index = 2, 1
        compress = 1
    while i < n:
        if index == 8:
            raise InvalidURL()
        if text[i] == ":":
            if compress is not None:
                raise InvalidURL()
            i += 1
            index += 1
            compress = index
            continue
        value = length = 0
        while length < 4 and i < n and text[i] in hexdigits:
            value = value * 16 + int(text[i], 16)
            i += 1
            length += 1
        if i < n and text[i] == ".":
            if length == 0:
                raise InvalidURL()
            i -= length
            if index > 6:
                raise InvalidURL()
            seen = 0
            while i < n:
                ipv4 = None
                if seen > 0:
                    if text[i] == "." and seen < 4:
                        i += 1
                    else:
                        raise InvalidURL()
                if i >= n or not text[i].isdigit() or not text[i].isascii():
                    raise InvalidURL()
                while i < n and text[i].isascii() and text[i].isdigit():
                    number = int(text[i])
                    if ipv4 is None:
                        ipv4 = number
                    elif ipv4 == 0:
                        raise InvalidURL()
                    else:
                        ipv4 = ipv4 * 10 + number
                    if ipv4 > 255:
                        raise InvalidURL()
                    i += 1
                pieces[index] = pieces[index] * 256 + ipv4  # type: ignore[operator]
                seen += 1
                if seen in (2, 4):
                    index += 1
            if seen != 4:
                raise InvalidURL()
            break
        if i < n and text[i] == ":":
            i += 1
            if i >= n:
                raise InvalidURL()
        elif i < n:
            raise InvalidURL()
        pieces[index] = value
        index += 1
    if compress is not None:
        swaps = index - compress
        index = 7
        while index != 0 and swaps > 0:
            pieces[index], pieces[compress + swaps - 1] = pieces[compress + swaps - 1], pieces[index]
            index -= 1
            swaps -= 1
    elif index != 8:
        raise InvalidURL()
    # Serialize: compress the first longest run of two or more zero pieces.
    best, best_len, run, run_len = None, 1, None, 0
    for j, piece in enumerate(pieces):
        if piece == 0:
            if run is None:
                run, run_len = j, 0
            run_len += 1
            if run_len > best_len:
                best, best_len = run, run_len
        else:
            run = None
    out, j = "", 0
    while j < 8:
        if j == best:
            out += "::" if j == 0 else ":"
            j += best_len
            continue
        out += format(pieces[j], "x") + (":" if j < 7 else "")
        j += 1
    return out
