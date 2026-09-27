"""Address lists the way nodemailer 10 reads them (TypeScript mailers delegate to it).

``parse_addresses(text)`` is nodemailer's ``addressparser`` (``,``/``;`` lists, ``Name <addr>``,
quoted names, comments, groups, bare addresses found in free text); ``normalize_address`` and
``convert_addresses`` are its ``MimeNode`` rules that decide what goes into the To header and the
SMTP envelope. Indices are code points here and UTF-16 units in JavaScript; every rule only looks
at ASCII characters and whitespace, so the results are the same.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

#: JavaScript ``\\s``.
JS_SPACE = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
_S = "[" + re.escape(JS_SPACE) + "]"
_NS = "[^" + re.escape(JS_SPACE) + "]"
_ANY = r"[\s\S]"

_HAS_WHITESPACE = re.compile(_S)
_QUOTED_LOCAL_ADDR = re.compile(r'("(?:[^"\\]|\\' + _ANY + r')*"@' + _NS + r"+)(?:" + _S + r"+(" + _ANY + r"+))?", re.DOTALL)
_ADDR_SPEC = re.compile(r"[^@" + re.escape(JS_SPACE) + r"]+@[^@" + re.escape(JS_SPACE) + r"]+")
_LOOSE_ADDR_SPEC = re.compile(r"[^@" + re.escape(JS_SPACE) + r"]+@" + _NS + r"+")
_PLAIN_LOCAL = re.compile(r'[^' + re.escape(JS_SPACE) + r'"(),:;<>@\[\\\]]+')
_QUOTED_STRING = re.compile(r'"(?:[^"\\]|\\[\s\S])*"', re.DOTALL)
_SPLIT_SPACE = re.compile(_S + "+")
_ADDRESS_ANGLE = re.compile(r"^[^<]*<" + _S + "*")
_ATEXT = r"[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~\u0080-\U0010ffff]"
_DOT_ATOM = re.compile(_ATEXT + r"+(?:\." + _ATEXT + r"+)*")
_PLAIN_ADDRESS = re.compile(
    r'[^' + re.escape(JS_SPACE) + r'"(),:;<>@\[\\\]]+@[^' + re.escape(JS_SPACE) + r'"(),:;<>@\[\\\]]+'
)
_CONTROLS_AND_ANGLES = re.compile(r"[\x00-\x1f\x7f<>]+")
_NON_ASCII = re.compile(r"[\u0080-\U0010ffff]")
_WORD_NAME = re.compile(r"[A-Za-z0-9_ ]*")
_PRINTABLE = re.compile(r"[\x20-\x7e]*")

MAX_NESTED_GROUP_DEPTH = 50


def js_trim(text: str) -> str:
    return text.strip(JS_SPACE)


def quote_string(value: str) -> str:
    """nodemailer ``quoteString``: ``"`` + value with ``"`` and ``\\`` escaped + ``"``."""
    return '"' + re.sub(r'(["\\])', r"\\\1", value) + '"'


# --- addressparser ---------------------------------------------------------------------------


@dataclass
class Token:
    type: str  # "operator" | "text"
    value: str
    no_break: bool = False


_OPERATORS = {'"': '"', "(": ")", "<": ">", ",": "", ":": ";", ";": ""}


def _tokenize(text: str) -> list[Token]:
    tokens: list[Token] = []
    node: Token | None = None
    expecting = ""
    escaped = False
    in_domain_literal = False
    for i, chr_ in enumerate(text):
        next_chr = text[i + 1] if i < len(text) - 1 else None
        if not escaped and not expecting:
            if not in_domain_literal and chr_ == "[":
                in_domain_literal = True
            elif in_domain_literal and chr_ in "],;":
                in_domain_literal = False
        if escaped:
            pass
        elif chr_ == expecting:
            op = Token("operator", chr_)
            if next_chr is not None and next_chr not in (" ", "\t", "\r", "\n", ",", ";"):
                op.no_break = True
            tokens.append(op)
            node = None
            expecting = ""
            escaped = False
            continue
        elif not expecting and not in_domain_literal and chr_ in _OPERATORS:
            tokens.append(Token("operator", chr_))
            node = None
            expecting = _OPERATORS[chr_]
            escaped = False
            continue
        elif expecting in ('"', "'") and chr_ == "\\":
            escaped = True
            continue
        if node is None:
            node = Token("text", "")
            tokens.append(node)
        if chr_ == "\n":
            chr_ = " "
        if ord(chr_) >= 0x21 or chr_ in (" ", "\t"):
            node.value += chr_
        escaped = False
    out = []
    for token in tokens:
        token.value = js_trim(token.value)
        if token.value:
            out.append(token)
    return out


def _is_space(ch: str) -> bool:
    return ch in JS_SPACE


def _is_word(ch: str | None) -> bool:
    return ch is not None and ("0" <= ch <= "9" or "A" <= ch <= "Z" or "a" <= ch <= "z" or ch == "_")


def _is_boundary(text: str, at: int) -> bool:
    before = text[at - 1] if 0 < at <= len(text) else None
    after = text[at] if 0 <= at < len(text) else None
    return _is_word(before) != _is_word(after)


def _index_of_at(text: str, start: int, end: int) -> int:
    i = text.find("@", start, end)
    return i


def _loose_address_start(text: str) -> int:
    """Where ``/\\s*\\b[^@\\s]+@[^\\s]+\\b\\s*/y`` can match in free text, or -1."""
    length = len(text)
    pos = 0
    while pos < length:
        while pos < length and _is_space(text[pos]):
            pos += 1
        if pos >= length:
            break
        run_start = pos
        run_end = pos
        while run_end < length and not _is_space(text[run_end]):
            run_end += 1
        at = _index_of_at(text, run_start, run_end)
        if at >= 0:
            last_boundary = -1
            for k in range(run_end, run_start, -1):
                if _is_boundary(text, k):
                    last_boundary = k
                    break
            atom_start = run_start
            while last_boundary >= 0 and at >= 0:
                if at > atom_start and run_end > at + 1 and last_boundary > at + 1:
                    for start in range(atom_start, at):
                        if _is_boundary(text, start):
                            if start > run_start:
                                return start
                            padded = run_start
                            while padded > 0 and _is_space(text[padded - 1]):
                                padded -= 1
                            return padded
                atom_start = at + 1
                at = _index_of_at(text, atom_start, run_end)
        pos = run_end
    return -1


def _loose_text_match(text: str, at: int) -> str | None:
    """``/\\s*\\b[^@\\s]+@[^\\s]+\\b\\s*/y`` at ``at`` (JavaScript backtracking, ASCII ``\\b``)."""
    p = at
    while p < len(text) and _is_space(text[p]):
        p += 1
    if not _is_boundary(text, p):
        return None
    q = p
    while q < len(text) and text[q] != "@" and not _is_space(text[q]):
        q += 1
    if q == p or q >= len(text) or text[q] != "@":
        return None
    end = q + 1
    while end < len(text) and not _is_space(text[end]):
        end += 1
    while end > q + 1 and not _is_boundary(text, end):
        end -= 1
    if end <= q + 1 or not _is_boundary(text, end):
        return None
    while end < len(text) and _is_space(text[end]):
        end += 1
    return text[at:end]


def _quote_local_part(address: str) -> str:
    last_at = address.rfind("@")
    if last_at < 0:
        return address
    user = address[:last_at]
    if _PLAIN_LOCAL.fullmatch(user) or _QUOTED_STRING.fullmatch(user):
        return address
    return quote_string(user) + "@" + address[last_at + 1 :]


def _recover_addr_spec(data: dict[str, Any]) -> None:
    if not _HAS_WHITESPACE.search(data["address"]):
        return
    quoted = _QUOTED_LOCAL_ADDR.fullmatch(data["address"])
    if quoted:
        if not quoted.group(2):
            return
        address, rest = quoted.group(1), [quoted.group(2)]
    else:
        if '"' in data["address"]:
            return
        parts = _SPLIT_SPACE.split(data["address"])
        index = next((i for i, part in enumerate(parts) if _ADDR_SPEC.fullmatch(part)), -1)
        if index < 0:
            index = next((i for i, part in enumerate(parts) if _LOOSE_ADDR_SPEC.fullmatch(part)), -1)
        if index < 0:
            return
        address = parts.pop(index)
        rest = parts
    data["address"] = address
    data["text"] = " ".join(part for part in [data["text"], *rest] if part)


def _handle_address(tokens: list[Token], depth: int) -> list[dict[str, Any]]:
    is_group = False
    state = "text"
    data: dict[str, Any] = {"address": [], "comment": [], "group": [], "text": []}
    text_was_quoted: list[bool] = []
    inside_quotes = False
    last_chars = {"address": "", "comment": "", "group": "", "text": ""}
    for i, token in enumerate(tokens):
        prev = tokens[i - 1] if i else None
        if token.type == "operator":
            if token.value == "<":
                state, inside_quotes = "address", False
            elif token.value == "(":
                state, inside_quotes = "comment", False
            elif token.value == ":":
                state, is_group, inside_quotes = "group", True, False
            elif token.value == '"':
                inside_quotes = not inside_quotes
                state = "text"
            else:
                state, inside_quotes = "text", False
        elif token.value:
            prev_prev = tokens[i - 2] if i > 1 else None
            opens_after_empty_quoted = (
                prev is not None
                and prev.type == "operator"
                and prev.value == '"'
                and prev.no_break
                and prev_prev is not None
                and prev_prev.type == "operator"
                and prev_prev.value == '"'
            )
            if state == "address":
                token.value = _ADDRESS_ANGLE.sub("", token.value, count=1)
            parts = data[state]
            joins = (
                prev is not None
                and prev.no_break
                and len(parts) > 0
                and (prev.value != ")" or last_chars[state] == "@" or token.value[:1] == "@")
            )
            if joins:
                parts[-1] += token.value
                if token.value:
                    last_chars[state] = token.value[-1]
                if state == "text" and inside_quotes:
                    text_was_quoted[-1] = True
            else:
                parts.append(token.value)
                last_chars[state] = token.value[-1:] if token.value else ""
                if state == "text":
                    text_was_quoted.append(inside_quotes or opens_after_empty_quoted)
    if not data["text"] and data["comment"]:
        data["text"], data["comment"] = data["comment"], []

    def quoted_at(i: int) -> bool:
        # The flags follow the text tokens; text taken over from a comment has none.
        return i < len(text_was_quoted) and text_was_quoted[i]

    if is_group:
        name = " ".join(data["text"])
        members: list[dict[str, Any]] = []
        if data["group"]:
            for member in parse_addresses(",".join(data["group"]), _depth=depth + 1):
                if "group" in member:
                    members.extend(member["group"])
                else:
                    members.append(member)
        return [{"name": name or "", "group": members}]
    if not data["address"] and data["text"]:
        for i in range(len(data["text"]) - 1, -1, -1):
            if not quoted_at(i) and _ADDR_SPEC.fullmatch(data["text"][i]):
                data["address"] = [data["text"].pop(i)]
                if i < len(text_was_quoted):
                    text_was_quoted.pop(i)
                break
        if not data["address"]:
            for i in range(len(data["text"]) - 1, -1, -1):
                if not quoted_at(i):
                    part = data["text"][i]
                    remainder = part
                    extracted = False
                    at = _loose_address_start(part)
                    if at >= 0:
                        match = _loose_text_match(part, at)
                        if match is not None:
                            data["address"] = [js_trim(match)]
                            extracted = True
                            remainder = part[:at] + " " + part[at + len(match) :]
                    data["text"][i] = js_trim(remainder)
                    if extracted:
                        break
    if not data["text"] and data["comment"]:
        data["text"], data["comment"] = data["comment"], []
    if len(data["address"]) > 1:
        data["text"] = data["text"] + data["address"][1:]
        data["address"] = data["address"][:1]
    address_from_quoted_text = not data["address"] and any(text_was_quoted)
    joined: dict[str, Any] = {"text": " ".join(data["text"]), "address": " ".join(data["address"])}
    if address_from_quoted_text and joined["text"]:
        joined["address"] = _quote_local_part(joined["text"])
        joined["text"] = ""
    _recover_addr_spec(joined)
    result = {"address": joined["address"] or joined["text"] or "", "name": joined["text"] or joined["address"] or ""}
    if result["address"] == result["name"]:
        if "@" in result["address"]:
            result["name"] = ""
        else:
            result["address"] = ""
    return [result]


def parse_addresses(text: str, *, _depth: int = 0) -> list[dict[str, Any]]:
    """nodemailer ``addressparser``: ``[{name, address}]`` or ``{name, group: [...]}`` entries."""
    if _depth > MAX_NESTED_GROUP_DEPTH:
        return []
    groups: list[list[Token]] = []
    current: list[Token] = []
    for token in _tokenize(text or ""):
        if token.type == "operator" and token.value in (",", ";"):
            if current:
                groups.append(current)
            current = []
        else:
            current.append(token)
    if current:
        groups.append(current)
    parsed: list[dict[str, Any]] = []
    for tokens in groups:
        parsed.extend(_handle_address(tokens, _depth))
    merged: list[dict[str, Any]] = []
    for current_entry in reversed(parsed):
        following = merged[-1] if merged else None
        if (
            following is not None
            and current_entry.get("address") == ""
            and current_entry.get("name")
            and "group" not in current_entry
            and following.get("address")
            and following.get("name")
        ):
            following["name"] = current_entry["name"] + ", " + following["name"]
        else:
            merged.append(current_entry)
    merged.reverse()
    return merged


# --- domains ---------------------------------------------------------------------------------

_BASE, _TMIN, _TMAX, _SKEW, _DAMP, _INITIAL_BIAS, _INITIAL_N = 36, 1, 26, 38, 700, 72, 128
_SEPARATORS = re.compile("[.。．｡]")
_URL_PARSER_UNSAFE = re.compile(r"[/\\?#%\x00-\x20\x7f]")
_FORBIDDEN_DOMAIN = re.compile(r"[\x00-\x20#%/:<>?@\[\\\]^|\x7f]")


class PunycodeError(ValueError):
    pass


def _adapt(delta: int, points: int, first: bool) -> int:
    delta = delta // _DAMP if first else delta // 2
    delta += delta // points
    k = 0
    while delta > ((_BASE - _TMIN) * _TMAX) // 2:
        delta //= _BASE - _TMIN
        k += _BASE
    return k + (_BASE - _TMIN + 1) * delta // (delta + _SKEW)


def _digit(d: int) -> str:
    return chr(d + 22 + 75 * (d < 26))


def punycode_encode(label: str) -> str:
    """RFC 3492 encoding of one label (without the ``xn--`` prefix)."""
    points = [ord(c) for c in label]
    output = [chr(c) for c in points if c < 0x80]
    basic = handled = len(output)
    if basic:
        output.append("-")
    n, delta, bias = _INITIAL_N, 0, _INITIAL_BIAS
    while handled < len(points):
        m = min(c for c in points if c >= n)
        if m - n > (0x7FFFFFFF - delta) // (handled + 1):
            raise PunycodeError("overflow")
        delta += (m - n) * (handled + 1)
        n = m
        for c in points:
            if c < n:
                delta += 1
            if c == n:
                q = delta
                k = _BASE
                while True:
                    t = _TMIN if k <= bias else _TMAX if k >= bias + _TMAX else k - bias
                    if q < t:
                        break
                    output.append(_digit(t + (q - t) % (_BASE - t)))
                    q = (q - t) // (_BASE - t)
                    k += _BASE
                output.append(_digit(q))
                bias = _adapt(delta, handled + 1, handled == basic)
                delta = 0
                handled += 1
        delta += 1
        n += 1
    return "".join(output)


def punycode_decode(text: str) -> str:
    """RFC 3492 decoding of one label (without the ``xn--`` prefix); PunycodeError when invalid."""
    output: list[int] = []
    basic = text.rfind("-")
    if basic < 0:
        basic = 0
    for ch in text[:basic]:
        if ord(ch) >= 0x80:
            raise PunycodeError("not-basic")
        output.append(ord(ch))
    n, i, bias = _INITIAL_N, 0, _INITIAL_BIAS
    index = basic + 1 if basic > 0 else 0
    while index < len(text):
        old_i, w, k = i, 1, _BASE
        while True:
            if index >= len(text):
                raise PunycodeError("invalid-input")
            c = ord(text[index])
            index += 1
            digit = c - 48 + 26 if 48 <= c < 58 else c - 65 if 65 <= c < 91 else c - 97 if 97 <= c < 123 else _BASE
            if digit >= _BASE or digit > (0x7FFFFFFF - i) // w:
                raise PunycodeError("invalid-input")
            i += digit * w
            t = _TMIN if k <= bias else _TMAX if k >= bias + _TMAX else k - bias
            if digit < t:
                break
            if w > 0x7FFFFFFF // (_BASE - t):
                raise PunycodeError("overflow")
            w *= _BASE - t
            k += _BASE
        out = len(output) + 1
        bias = _adapt(i - old_i, out, old_i == 0)
        if i // out > 0x7FFFFFFF - n:
            raise PunycodeError("overflow")
        n += i // out
        i %= out
        if n > 0x10FFFF or 0xD800 <= n <= 0xDFFF:
            raise PunycodeError("invalid-input")
        output.insert(i, n)
        i += 1
    return "".join(chr(c) for c in output)


def _map_labels(domain: str, fn: Any) -> str:
    return ".".join(fn(label) for label in _SEPARATORS.sub(".", domain).split("."))


def _bundled_to_ascii(domain: str) -> str:
    """nodemailer's bundled ``punycode.toASCII`` (no mapping, no validation)."""
    return _map_labels(domain, lambda label: "xn--" + punycode_encode(label) if _NON_ASCII.search(label) else label)


def _bundled_to_unicode(domain: str) -> str:
    return _map_labels(domain, lambda label: punycode_decode(label[4:].lower()) if label.startswith("xn--") else label)


def _ipv4_number(part: str) -> int | None:
    if not part:
        return None
    base = 10
    if len(part) >= 2 and part[:2] in ("0x", "0X"):
        part, base = part[2:], 16
    elif len(part) >= 2 and part[0] == "0":
        part, base = part[1:], 8
    if part == "":
        return 0
    digits = {10: "0123456789", 16: "0123456789abcdefABCDEF", 8: "01234567"}[base]
    if not all(c in digits for c in part):
        return None
    return int(part, base)


def _ends_in_number(domain: str) -> bool:
    parts = domain.split(".")
    if parts[-1] == "":
        if len(parts) == 1:
            return False
        parts.pop()
    last = parts[-1]
    if last and all("0" <= c <= "9" for c in last):
        return True
    return _ipv4_number(last) is not None


def _ipv4(domain: str) -> str | None:
    """WHATWG IPv4 parser: ``0x7f.1`` → ``127.0.0.1``; None when it is not an address."""
    parts = domain.split(".")
    if parts[-1] == "" and len(parts) > 1:
        parts.pop()
    if len(parts) > 4:
        return None
    numbers = [_ipv4_number(part) for part in parts]
    if any(n is None for n in numbers):
        return None
    values = [n for n in numbers if n is not None]
    if any(n > 255 for n in values[:-1]) or values[-1] >= 256 ** (5 - len(values)):
        return None
    ipv4 = values[-1]
    for i, n in enumerate(values[:-1]):
        ipv4 += n * 256 ** (3 - i)
    return ".".join(str((ipv4 >> shift) & 255) for shift in (24, 16, 8, 0))


def _domain_to_ascii(domain: str) -> str:
    """Node ``url.domainToASCII`` for a lower-cased domain; "" when it is not a valid host.

    Labels with non-ASCII characters become punycode; UTS #46 mappings other than lower-casing
    (width, compatibility forms, ignored characters) are not applied.
    """
    labels = _SEPARATORS.sub(".", domain).split(".")
    out = []
    for label in labels:
        if _NON_ASCII.search(label):
            if label.startswith("xn--"):
                return ""
            try:
                out.append("xn--" + punycode_encode(label))
            except PunycodeError:
                return ""
        elif label.startswith("xn--"):
            try:
                decoded = punycode_decode(label[4:])
            except PunycodeError:
                return ""
            if not _NON_ASCII.search(decoded) or punycode_encode(decoded) != label[4:]:
                return ""
            out.append(label)
        else:
            out.append(label)
    result = ".".join(out)
    if _FORBIDDEN_DOMAIN.search(result):
        return ""
    if _ends_in_number(result):
        return _ipv4(result) or ""
    return result


def _domain_to_unicode(domain: str) -> str:
    """Node ``url.domainToUnicode`` for a lower-cased domain; "" when it is not a valid host."""
    ascii_form = _domain_to_ascii(domain)
    if not ascii_form:
        return ""
    return _map_labels(ascii_form, lambda label: punycode_decode(label[4:]) if label.startswith("xn--") else label)


def _normalize_domain(domain: str, to_unicode: bool) -> str:
    if not _URL_PARSER_UNSAFE.search(domain):
        mapped = _domain_to_unicode(domain) if to_unicode else _domain_to_ascii(domain)
        if mapped:
            return mapped
    return _bundled_to_unicode(domain) if to_unicode else _bundled_to_ascii(domain)


def js_lower(text: str) -> str:
    """JavaScript ``toLowerCase``: full Unicode lower-casing (``İ`` → ``i̇``, final sigma)."""
    return text.lower()


def _normalize_local_part(user: str) -> str:
    if _DOT_ATOM.fullmatch(user) or _QUOTED_STRING.fullmatch(user):
        return user
    return quote_string(user)


def normalize_address(address: str) -> str:
    """nodemailer ``_normalizeAddress``: controls and ``<>`` become spaces, the domain is IDNA."""
    address = js_trim(_CONTROLS_AND_ANGLES.sub(" ", address or ""))
    if not address:
        return address
    last_at = address.rfind("@")
    if last_at < 0:
        return _normalize_local_part(address)
    user, domain = address[:last_at], address[last_at + 1 :]
    smtputf8 = bool(_NON_ASCII.search(user))
    try:
        encoded = _normalize_domain(js_lower(domain), smtputf8)
    except PunycodeError:
        encoded = domain
    return _normalize_local_part(user) + "@" + encoded


# --- headers and the envelope ----------------------------------------------------------------


@dataclass
class AddressList:
    """What an address field becomes: the header value and the envelope recipients (unique)."""

    header: str
    recipients: list[str] = field(default_factory=list)


def encode_address_name(name: str, encode_word: Any) -> str:
    """nodemailer ``_encodeAddressName``: word characters as is, printable ASCII quoted, else MIME."""
    if _WORD_NAME.fullmatch(name):
        return name
    if _PRINTABLE.fullmatch(name):
        return quote_string(name)
    return encode_word(name)


def convert_addresses(entries: list[dict[str, Any]], encode_word: Any, recipients: list[str] | None = None, seen: set[str] | None = None) -> str:
    """nodemailer ``_convertAddresses``: the header text; unique addresses are added to ``recipients``."""
    recipients = [] if recipients is None else recipients
    seen = set(recipients) if seen is None else seen
    values = []
    for entry in entries:
        if entry.get("address"):
            address = normalize_address(entry["address"])
            entry["address"] = address
            if not entry.get("name"):
                values.append(address if _PLAIN_ADDRESS.fullmatch(address) else f"<{address}>")
            else:
                values.append(f"{encode_address_name(entry['name'], encode_word)} <{address}>")
            if address not in seen:
                seen.add(address)
                recipients.append(address)
        elif "group" in entry:
            members = convert_addresses(entry["group"], encode_word, recipients, seen).strip() if entry["group"] else ""
            values.append(f"{encode_address_name(entry['name'], encode_word)}:{members};")
    return ", ".join(values)


def _normalize_parsed(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """nodemailer ``_normalizeParsedAddresses``: normalize every address, group members included."""
    for entry in entries:
        if entry.get("address"):
            entry["address"] = normalize_address(entry["address"])
        elif "group" in entry:
            _normalize_parsed(entry["group"])
    return entries


def address_list(text: str, encode_word: Any) -> AddressList:
    """Parse an address field: its header value and its envelope recipients."""
    entries = _normalize_parsed(parse_addresses(text))
    recipients: list[str] = []
    header = convert_addresses(entries, encode_word, recipients)
    return AddressList(header, recipients)


def needs_smtputf8(addresses: list[str]) -> bool:
    return any(_NON_ASCII.search(address) for address in addresses)
