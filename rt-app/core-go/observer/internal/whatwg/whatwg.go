// Package whatwg is the part of the WHATWG URL parser (JavaScript's new URL) the Observer relies
// on: trimming, tab and newline removal, relative resolution against a base, backslashes as
// slashes, credentials, IPv4 (decimal, octal and hex parts) and IPv6 hosts, ports, dot segments and
// the path, query and fragment percent-encode sets (the path set includes '^' like Node 24).
//
// Special schemes (http, https, ws, wss, ftp) follow the URL Standard. Other schemes are only
// checked roughly (file: is accepted as is; other schemes need a valid opaque host when they have
// one) because the Observer rejects them anyway. Non-ASCII domains are lowercased and
// Punycode-encoded label by label, without the full UTS #46 mapping.
package whatwg

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// ErrInvalid is returned when the input is not a URL (JavaScript: TypeError "Invalid URL").
var ErrInvalid = errors.New("Invalid URL")

var special = map[string]int{"http": 80, "https": 443, "ws": 80, "wss": 443, "ftp": 21, "file": -1}

// URL is a parsed URL. Host is serialized (lowercase domain, dotted IPv4 or bracketed IPv6);
// Port is -1 when absent or the scheme's default.
type URL struct {
	Scheme   string
	Username string
	Password string
	Host     string
	HasHost  bool
	Port     int
	Path     []string
	Opaque   *string
	Query    *string
	Fragment *string
}

// Protocol is url.protocol ("https:").
func (u *URL) Protocol() string { return u.Scheme + ":" }

// Pathname is url.pathname.
func (u *URL) Pathname() string {
	if u.Opaque != nil {
		return *u.Opaque
	}
	if len(u.Path) == 0 && special[u.Scheme] == 0 {
		return ""
	}
	return "/" + strings.Join(u.Path, "/")
}

// Href is the serialized URL (url.href).
func (u *URL) Href() string {
	var b strings.Builder
	b.WriteString(u.Scheme + ":")
	if u.HasHost {
		b.WriteString("//")
		if u.Username != "" || u.Password != "" {
			b.WriteString(u.Username)
			if u.Password != "" {
				b.WriteString(":" + u.Password)
			}
			b.WriteString("@")
		}
		b.WriteString(u.Host)
		if u.Port >= 0 {
			b.WriteString(":" + strconv.Itoa(u.Port))
		}
	}
	b.WriteString(u.Pathname())
	if u.Query != nil {
		b.WriteString("?" + *u.Query)
	}
	if u.Fragment != nil {
		b.WriteString("#" + *u.Fragment)
	}
	return b.String()
}

// Percent-encode sets (the characters encoded besides C0 controls and everything above U+007E).
const (
	fragmentSet     = " \"<>`"
	querySet        = " \"#<>"
	specialQuerySet = querySet + "'"
	pathSet         = querySet + "?^`{}"
	userinfoSet     = pathSet + "/:;=@[\\]|"
)

func encode(s, set string) string {
	var b strings.Builder
	for _, r := range s {
		if r < 0x20 || r > 0x7E || strings.ContainsRune(set, r) {
			var buf [utf8.UTFMax]byte
			n := utf8.EncodeRune(buf[:], r)
			for _, c := range buf[:n] {
				fmt.Fprintf(&b, "%%%02X", c)
			}
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

func str(s string) *string { return &s }

func isAlpha(r rune) bool { return 'a' <= r && r <= 'z' || 'A' <= r && r <= 'Z' }

func isDigit(r rune) bool { return '0' <= r && r <= '9' }

// Parse is new URL(input, base); base may be nil.
func Parse(input string, base *URL) (*URL, error) {
	input = strings.ToValidUTF8(input, "\uFFFD")
	input = strings.TrimFunc(input, func(r rune) bool { return r <= 0x20 })
	input = strings.NewReplacer("\t", "", "\n", "", "\r", "").Replace(input)
	if scheme, rest, ok := splitScheme(input); ok {
		if scheme == "file" {
			return &URL{Scheme: "file", HasHost: true, Port: -1, Path: []string{encode(rest, pathSet)}}, nil
		}
		if _, isSpecial := special[scheme]; !isSpecial {
			return nonSpecial(scheme, rest)
		}
		if base != nil && base.Scheme == scheme {
			if strings.HasPrefix(rest, "//") {
				return authority(scheme, strings.TrimLeft(rest[2:], "/\\"))
			}
			return relative(rest, base)
		}
		return authority(scheme, strings.TrimLeft(rest, "/\\"))
	}
	if base == nil {
		return nil, ErrInvalid
	}
	return relative(input, base)
}

func splitScheme(input string) (string, string, bool) {
	for i, r := range input {
		switch {
		case i == 0 && isAlpha(r):
		case i > 0 && (isAlpha(r) || isDigit(r) || r == '+' || r == '-' || r == '.'):
		case i > 0 && r == ':':
			return strings.ToLower(input[:i]), input[i+1:], true
		default:
			return "", "", false
		}
	}
	return "", "", false
}

func relative(rest string, base *URL) (*URL, error) {
	u := &URL{Scheme: base.Scheme, Username: base.Username, Password: base.Password, Host: base.Host, HasHost: base.HasHost, Port: base.Port}
	u.Path = append([]string(nil), base.Path...)
	if rest == "" {
		u.Query = base.Query
		return u, nil
	}
	switch rest[0] {
	case '/', '\\':
		if len(rest) > 1 && (rest[1] == '/' || rest[1] == '\\') {
			return authority(base.Scheme, strings.TrimLeft(rest[2:], "/\\"))
		}
		u.Path = nil
		return path(u, rest[1:], false), nil
	case '?':
		return path(u, rest, true), nil
	case '#':
		u.Query = base.Query
		u.Fragment = str(encode(rest[1:], fragmentSet))
		return u, nil
	}
	if len(u.Path) > 0 {
		u.Path = u.Path[:len(u.Path)-1]
	}
	return path(u, rest, false), nil
}

func authority(scheme, rest string) (*URL, error) {
	end := strings.IndexAny(rest, "/\\?#")
	if end < 0 {
		end = len(rest)
	}
	auth, rest := rest[:end], rest[end:]
	u := &URL{Scheme: scheme, HasHost: true, Port: -1}
	if at := strings.LastIndexByte(auth, '@'); at >= 0 {
		credentials := strings.ReplaceAll(auth[:at], "@", "%40")
		auth = auth[at+1:]
		username, password, _ := strings.Cut(credentials, ":")
		u.Username, u.Password = encode(username, userinfoSet), encode(password, userinfoSet)
		if auth == "" {
			return nil, ErrInvalid
		}
	}
	host, port := splitPort(auth)
	if host == "" {
		return nil, ErrInvalid
	}
	var err error
	if u.Host, err = parseHost(host); err != nil {
		return nil, err
	}
	if port != "" {
		n, ok := parsePort(port)
		if !ok {
			return nil, ErrInvalid
		}
		if n != special[scheme] {
			u.Port = n
		}
	}
	if strings.HasPrefix(rest, "/") || strings.HasPrefix(rest, "\\") {
		rest = rest[1:]
	}
	return path(u, rest, false), nil
}

func parsePort(port string) (int, bool) {
	for _, r := range port {
		if !isDigit(r) {
			return 0, false
		}
	}
	trimmed := strings.TrimLeft(port, "0")
	if len(trimmed) > 5 {
		return 0, false
	}
	n, _ := strconv.Atoi("0" + trimmed)
	return n, n <= 65535
}

func splitPort(auth string) (string, string) {
	inside := false
	for i, r := range auth {
		switch {
		case r == '[':
			inside = true
		case r == ']':
			inside = false
		case r == ':' && !inside:
			return auth[:i], auth[i+1:]
		}
	}
	return auth, ""
}

// path reads the path segments of rest (without its leading slash) unless keepPath, then the query
// and fragment.
func path(u *URL, rest string, keepPath bool) *URL {
	cut := strings.IndexAny(rest, "?#")
	if cut < 0 {
		cut = len(rest)
	}
	pathText, tail := rest[:cut], rest[cut:]
	if !keepPath {
		segments := splitSlashes(pathText)
		for i, segment := range segments {
			segment = encode(segment, pathSet)
			last := i == len(segments)-1
			switch strings.ToLower(segment) {
			case "..", ".%2e", "%2e.", "%2e%2e":
				if len(u.Path) > 0 {
					u.Path = u.Path[:len(u.Path)-1]
				}
				if last {
					u.Path = append(u.Path, "")
				}
			case ".", "%2e":
				if last {
					u.Path = append(u.Path, "")
				}
			default:
				u.Path = append(u.Path, segment)
			}
		}
	}
	switch {
	case strings.HasPrefix(tail, "?"):
		query, fragment, hashed := strings.Cut(tail[1:], "#")
		u.Query = str(encode(query, specialQuerySet))
		if hashed {
			u.Fragment = str(encode(fragment, fragmentSet))
		}
	case strings.HasPrefix(tail, "#"):
		u.Fragment = str(encode(tail[1:], fragmentSet))
	}
	return u
}

// splitSlashes splits on '/' and '\\' (both separate segments in special URLs), keeping empty parts.
func splitSlashes(s string) []string {
	var parts []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '/' || s[i] == '\\' {
			parts = append(parts, s[start:i])
			start = i + 1
		}
	}
	return append(parts, s[start:])
}

func nonSpecial(scheme, rest string) (*URL, error) {
	if !strings.HasPrefix(rest, "//") {
		return &URL{Scheme: scheme, Port: -1, Opaque: str(rest)}, nil
	}
	end := strings.IndexAny(rest[2:], "/?#")
	if end < 0 {
		end = len(rest) - 2
	}
	auth := rest[2 : 2+end]
	if at := strings.LastIndexByte(auth, '@'); at >= 0 {
		auth = auth[at+1:]
	}
	host, port := splitPort(auth)
	if strings.HasPrefix(host, "[") {
		if !strings.HasSuffix(host, "]") {
			return nil, ErrInvalid
		}
		ip, err := parseIPv6(host[1 : len(host)-1])
		if err != nil {
			return nil, err
		}
		host = "[" + ip + "]"
	} else if strings.ContainsAny(host, "\x00\t\n\r #/:<>?@[\\]^|") {
		return nil, ErrInvalid
	}
	if port != "" {
		if _, ok := parsePort(port); !ok {
			return nil, ErrInvalid
		}
	}
	return &URL{Scheme: scheme, Host: host, HasHost: true, Port: -1, Opaque: str(rest[2+end:])}, nil
}

// ---------------------------------------------------------------- hosts

func parseHost(text string) (string, error) {
	if strings.HasPrefix(text, "[") {
		if !strings.HasSuffix(text, "]") {
			return "", ErrInvalid
		}
		ip, err := parseIPv6(text[1 : len(text)-1])
		if err != nil {
			return "", err
		}
		return "[" + ip + "]", nil
	}
	domain := strings.ToValidUTF8(percentDecode(text), "\uFFFD")
	ascii, err := toASCII(domain)
	if err != nil {
		return "", err
	}
	if ascii == "" || strings.ContainsFunc(ascii, forbiddenDomain) {
		return "", ErrInvalid
	}
	if endsInNumber(ascii) {
		return parseIPv4(ascii)
	}
	return ascii, nil
}

func forbiddenDomain(r rune) bool {
	return r < 0x20 || r == 0x7F || strings.ContainsRune(" #%/:<>?@[\\]^|", r)
}

func percentDecode(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '%' && i+2 < len(s) && isHex(s[i+1]) && isHex(s[i+2]) {
			n, _ := strconv.ParseUint(s[i+1:i+3], 16, 8)
			b.WriteByte(byte(n))
			i += 2
			continue
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

func isHex(c byte) bool {
	return '0' <= c && c <= '9' || 'a' <= c && c <= 'f' || 'A' <= c && c <= 'F'
}

func toASCII(domain string) (string, error) {
	labels := strings.Split(strings.ToLower(domain), ".")
	for i, label := range labels {
		ascii := true
		for _, r := range label {
			if r > unicode.MaxASCII {
				ascii = false
				break
			}
		}
		if !ascii {
			encoded, err := punycode(label)
			if err != nil {
				return "", ErrInvalid
			}
			labels[i] = "xn--" + encoded
		}
	}
	return strings.Join(labels, "."), nil
}

func parseIPv4Number(s string) (uint64, bool) {
	if s == "" {
		return 0, false
	}
	base := 10
	switch {
	case len(s) >= 2 && (s[:2] == "0x" || s[:2] == "0X"):
		base, s = 16, s[2:]
	case len(s) > 1 && s[0] == '0':
		base, s = 8, s[1:]
	}
	if s == "" {
		return 0, true
	}
	n, err := strconv.ParseUint(s, base, 64)
	if err != nil {
		var numErr *strconv.NumError
		if errors.As(err, &numErr) && numErr.Err == strconv.ErrRange {
			return 1 << 40, true // too large for any IPv4 part
		}
		return 0, false
	}
	return n, true
}

func endsInNumber(domain string) bool {
	parts := strings.Split(domain, ".")
	if parts[len(parts)-1] == "" {
		if len(parts) == 1 {
			return false
		}
		parts = parts[:len(parts)-1]
	}
	last := parts[len(parts)-1]
	if last != "" && strings.Trim(last, "0123456789") == "" {
		return true
	}
	_, ok := parseIPv4Number(last)
	return ok
}

func parseIPv4(domain string) (string, error) {
	parts := strings.Split(domain, ".")
	if parts[len(parts)-1] == "" && len(parts) > 1 {
		parts = parts[:len(parts)-1]
	}
	if len(parts) > 4 {
		return "", ErrInvalid
	}
	numbers := make([]uint64, len(parts))
	for i, part := range parts {
		n, ok := parseIPv4Number(part)
		if !ok {
			return "", ErrInvalid
		}
		numbers[i] = n
	}
	for _, n := range numbers[:len(numbers)-1] {
		if n > 255 {
			return "", ErrInvalid
		}
	}
	last := numbers[len(numbers)-1]
	if last >= 1<<(8*(5-len(numbers))) {
		return "", ErrInvalid
	}
	address := last
	for i, n := range numbers[:len(numbers)-1] {
		address += n << (8 * (3 - i))
	}
	return fmt.Sprintf("%d.%d.%d.%d", address>>24&255, address>>16&255, address>>8&255, address&255), nil
}

// parseIPv6 is the URL Standard IPv6 parser; it returns the serialized address without brackets.
func parseIPv6(text string) (string, error) {
	var pieces [8]uint16
	in := []rune(text)
	n := len(in)
	index, compress, i := 0, -1, 0
	at := func(j int) rune {
		if j < n {
			return in[j]
		}
		return -1
	}
	hexValue := func(r rune) (uint16, bool) {
		switch {
		case '0' <= r && r <= '9':
			return uint16(r - '0'), true
		case 'a' <= r && r <= 'f':
			return uint16(r-'a') + 10, true
		case 'A' <= r && r <= 'F':
			return uint16(r-'A') + 10, true
		}
		return 0, false
	}
	if at(0) == ':' {
		if at(1) != ':' {
			return "", ErrInvalid
		}
		i, index, compress = 2, 1, 1
	}
	for i < n {
		if index == 8 {
			return "", ErrInvalid
		}
		if at(i) == ':' {
			if compress >= 0 {
				return "", ErrInvalid
			}
			i++
			index++
			compress = index
			continue
		}
		var value uint16
		length := 0
		for length < 4 {
			h, ok := hexValue(at(i))
			if !ok {
				break
			}
			value = value*16 + h
			i++
			length++
		}
		if at(i) == '.' {
			if length == 0 {
				return "", ErrInvalid
			}
			i -= length
			if index > 6 {
				return "", ErrInvalid
			}
			seen := 0
			for i < n {
				piece := -1
				if seen > 0 {
					if at(i) == '.' && seen < 4 {
						i++
					} else {
						return "", ErrInvalid
					}
				}
				if !isDigit(at(i)) {
					return "", ErrInvalid
				}
				for isDigit(at(i)) {
					number := int(at(i) - '0')
					switch piece {
					case -1:
						piece = number
					case 0:
						return "", ErrInvalid
					default:
						piece = piece*10 + number
					}
					if piece > 255 {
						return "", ErrInvalid
					}
					i++
				}
				pieces[index] = pieces[index]*256 + uint16(piece)
				seen++
				if seen == 2 || seen == 4 {
					index++
				}
			}
			if seen != 4 {
				return "", ErrInvalid
			}
			break
		}
		if at(i) == ':' {
			i++
			if i >= n {
				return "", ErrInvalid
			}
		} else if i < n {
			return "", ErrInvalid
		}
		pieces[index] = value
		index++
	}
	if compress >= 0 {
		swaps := index - compress
		index = 7
		for index != 0 && swaps > 0 {
			pieces[index], pieces[compress+swaps-1] = pieces[compress+swaps-1], pieces[index]
			index--
			swaps--
		}
	} else if index != 8 {
		return "", ErrInvalid
	}
	// Compress the first longest run of two or more zero pieces.
	best, bestLen, run, runLen := -1, 1, -1, 0
	for j, piece := range pieces {
		if piece != 0 {
			run = -1
			continue
		}
		if run < 0 {
			run, runLen = j, 0
		}
		runLen++
		if runLen > bestLen {
			best, bestLen = run, runLen
		}
	}
	var b strings.Builder
	for j := 0; j < 8; {
		if j == best {
			if j == 0 {
				b.WriteString("::")
			} else {
				b.WriteString(":")
			}
			j += bestLen
			continue
		}
		b.WriteString(strconv.FormatUint(uint64(pieces[j]), 16))
		if j < 7 {
			b.WriteString(":")
		}
		j++
	}
	return b.String(), nil
}

// punycode encodes one label (RFC 3492).
func punycode(label string) (string, error) {
	const (
		base, tmin, tmax, skew, damp = 36, 1, 26, 38, 700
		initialBias, initialN        = 72, 128
	)
	runes := []rune(label)
	var out []byte
	for _, r := range runes {
		if r < 0x80 {
			out = append(out, byte(r))
		}
	}
	basic := len(out)
	handled := basic
	if basic > 0 {
		out = append(out, '-')
	}
	digit := func(d int) byte {
		if d < 26 {
			return byte('a' + d)
		}
		return byte('0' + d - 26)
	}
	adapt := func(delta, points int, first bool) int {
		if first {
			delta /= damp
		} else {
			delta /= 2
		}
		delta += delta / points
		k := 0
		for delta > ((base-tmin)*tmax)/2 {
			delta /= base - tmin
			k += base
		}
		return k + (base-tmin+1)*delta/(delta+skew)
	}
	n, delta, bias := initialN, 0, initialBias
	for handled < len(runes) {
		m := int(unicode.MaxRune) + 1
		for _, r := range runes {
			if int(r) >= n && int(r) < m {
				m = int(r)
			}
		}
		delta += (m - n) * (handled + 1)
		n = m
		for _, r := range runes {
			if int(r) < n {
				delta++
			}
			if int(r) == n {
				q := delta
				for k := base; ; k += base {
					t := k - bias
					if t < tmin {
						t = tmin
					} else if t > tmax {
						t = tmax
					}
					if q < t {
						break
					}
					out = append(out, digit(t+(q-t)%(base-t)))
					q = (q - t) / (base - t)
				}
				out = append(out, digit(q))
				bias = adapt(delta, handled+1, handled == basic)
				delta = 0
				handled++
			}
		}
		delta++
		n++
	}
	return string(out), nil
}
