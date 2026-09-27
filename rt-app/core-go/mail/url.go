package mail

import (
	"errors"
	"fmt"
	"net/netip"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"rt.local/core-go/internal/js"
)

// The part of the WHATWG URL parser (JavaScript new URL) that SMTP_URL values need. smtp: and
// smtps: are not special schemes, so their host is an opaque host: its case is kept, non-ASCII
// characters are percent-encoded and IPv4 numbers are not rewritten. Other schemes are only
// checked for validity (the caller refuses them).

var errInvalidURL = errors.New("Invalid URL")

var (
	schemePattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9+\-.]*$`)
	special       = map[string]bool{"ftp": true, "file": true, "http": true, "https": true, "ws": true, "wss": true}
)

const (
	forbiddenHost   = "\x00\t\n\r #/:<>?@[\\]^|"
	userinfoEncoded = " \"#<>?`{}/:;=@[\\]^|"
)

type parsedURL struct {
	scheme, username, password, hostname, port string
}

func percentEncode(text, extra string) string {
	var b strings.Builder
	for _, r := range text {
		if r < 0x20 || r > 0x7e || strings.ContainsRune(extra, r) {
			for _, c := range []byte(string(r)) {
				fmt.Fprintf(&b, "%%%02X", c)
			}
		} else {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// serializeIPv6 is the WHATWG IPv6 serializer: lower-case hex, the first longest run of two or
// more zero pieces as "::".
func serializeIPv6(addr [16]byte) string {
	var pieces [8]int
	for i := range pieces {
		pieces[i] = int(addr[2*i])<<8 | int(addr[2*i+1])
	}
	bestStart, bestLen := -1, 1
	for i := 0; i < 8; {
		if pieces[i] != 0 {
			i++
			continue
		}
		j := i
		for j < 8 && pieces[j] == 0 {
			j++
		}
		if j-i > bestLen {
			bestStart, bestLen = i, j-i
		}
		i = j
	}
	var b strings.Builder
	ignore := false
	for i, piece := range pieces {
		if ignore && piece == 0 {
			continue
		}
		ignore = false
		if i == bestStart {
			if i == 0 {
				b.WriteString("::")
			} else {
				b.WriteString(":")
			}
			ignore = true
			continue
		}
		b.WriteString(strconv.FormatInt(int64(piece), 16))
		if i != 7 {
			b.WriteString(":")
		}
	}
	return b.String()
}

func parseIPv6(text string) (string, error) {
	if text == "" || strings.Trim(text, "0123456789abcdefABCDEF:.") != "" {
		return "", errInvalidURL
	}
	addr, err := netip.ParseAddr(text)
	if err != nil || !addr.Is6() || addr.Zone() != "" {
		return "", errInvalidURL
	}
	return serializeIPv6(addr.As16()), nil
}

func parsePort(text string) (string, error) {
	if text == "" {
		return "", nil
	}
	if strings.Trim(text, "0123456789") != "" {
		return "", errInvalidURL
	}
	trimmed := strings.TrimLeft(text, "0")
	if trimmed == "" {
		return "0", nil
	}
	n, err := strconv.Atoi(trimmed)
	if err != nil || len(trimmed) > 5 || n > 65535 {
		return "", errInvalidURL
	}
	return strconv.Itoa(n), nil
}

func hostAndPort(text string, isSpecial bool) (string, string, error) {
	if strings.HasPrefix(text, "[") {
		end := strings.IndexByte(text, ']')
		if end < 0 {
			return "", "", errInvalidURL
		}
		host, err := parseIPv6(text[1:end])
		if err != nil {
			return "", "", err
		}
		rest := text[end+1:]
		if rest != "" && !strings.HasPrefix(rest, ":") {
			return "", "", errInvalidURL
		}
		port, err := parsePort(strings.TrimPrefix(rest, ":"))
		return "[" + host + "]", port, err
	}
	host, port, hasPort := strings.Cut(text, ":")
	if hasPort && host == "" {
		return "", "", errInvalidURL // a port needs a host
	}
	if isSpecial {
		// Special hosts are percent-decoded, then go through "domain to ASCII" (IDNA, forbidden
		// code points, IPv4 numbers); only their validity matters here.
		decoded := strings.ToValidUTF8(percentDecode(host), "\uFFFD")
		if host == "" || strings.ContainsRune(decoded, utf8.RuneError) || domainToASCII(js.ToLower(decoded)) == "" {
			return "", "", errInvalidURL
		}
		port, err := parsePort(port)
		return strings.ToLower(host), port, err
	}
	if strings.ContainsAny(host, forbiddenHost) {
		return "", "", errInvalidURL
	}
	port, err := parsePort(port)
	return percentEncode(host, ""), port, err
}

// parseURL is new URL(text) for the fields SMTP_URL needs; errInvalidURL when JavaScript throws.
func parseURL(text string) (parsedURL, error) {
	text = strings.TrimFunc(text, func(r rune) bool { return r <= 0x20 })
	text = strings.NewReplacer("\t", "", "\n", "", "\r", "").Replace(text)
	colon := strings.IndexByte(text, ':')
	if colon <= 0 || !schemePattern.MatchString(text[:colon]) {
		return parsedURL{}, errInvalidURL
	}
	u := parsedURL{scheme: strings.ToLower(text[:colon])}
	rest := text[colon+1:]
	var authority string
	switch {
	case u.scheme == "file":
		return u, nil
	case special[u.scheme]:
		rest = strings.TrimLeft(rest, `/\`)
		authority = rest[:indexAny(rest, `/\?#`)]
	case strings.HasPrefix(rest, "//"):
		authority = rest[2:][:indexAny(rest[2:], "/?#")]
	default:
		return u, nil
	}
	if at := strings.LastIndexByte(authority, '@'); at >= 0 {
		user, password, _ := strings.Cut(authority[:at], ":")
		u.username, u.password = percentEncode(user, userinfoEncoded), percentEncode(password, userinfoEncoded)
		authority = authority[at+1:]
		if authority == "" {
			return parsedURL{}, errInvalidURL
		}
	}
	var err error
	u.hostname, u.port, err = hostAndPort(authority, special[u.scheme])
	if err != nil {
		return parsedURL{}, err
	}
	return u, nil
}

// percentDecode decodes %XX escapes to bytes and keeps everything else.
func percentDecode(text string) string {
	var out []byte
	for i := 0; i < len(text); i++ {
		if text[i] == '%' && i+2 < len(text) {
			if n, err := strconv.ParseUint(text[i+1:i+3], 16, 8); err == nil {
				out = append(out, byte(n))
				i += 2
				continue
			}
		}
		out = append(out, text[i])
	}
	return string(out)
}

func indexAny(s, chars string) int {
	if i := strings.IndexAny(s, chars); i >= 0 {
		return i
	}
	return len(s)
}

// ErrURIMalformed is JavaScript's URIError "URI malformed".
var ErrURIMalformed = errors.New("URI malformed")

// decodeURIComponent is JavaScript decodeURIComponent.
func decodeURIComponent(text string) (string, error) {
	var out []byte
	for i := 0; i < len(text); i++ {
		if text[i] != '%' {
			out = append(out, text[i])
			continue
		}
		if i+2 >= len(text) {
			return "", ErrURIMalformed
		}
		n, err := strconv.ParseUint(text[i+1:i+3], 16, 8)
		if err != nil {
			return "", ErrURIMalformed
		}
		out = append(out, byte(n))
		i += 2
	}
	if !utf8.Valid(out) {
		return "", ErrURIMalformed
	}
	return string(out), nil
}
