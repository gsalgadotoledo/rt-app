package mail

import (
	"errors"
	"math"
	"regexp"
	"strconv"
	"strings"

	"rt.local/core-go/internal/js"
)

// --- punycode (RFC 3492) ---------------------------------------------------------------------

const (
	pBase, pTMin, pTMax, pSkew, pDamp, pInitialBias, pInitialN = 36, 1, 26, 38, 700, 72, 128
)

var errPunycode = errors.New("punycode: invalid input")

func adapt(delta, points int, first bool) int {
	if first {
		delta /= pDamp
	} else {
		delta /= 2
	}
	delta += delta / points
	k := 0
	for delta > ((pBase-pTMin)*pTMax)/2 {
		delta /= pBase - pTMin
		k += pBase
	}
	return k + (pBase-pTMin+1)*delta/(delta+pSkew)
}

func digit(d int) byte {
	if d < 26 {
		return byte('a' + d)
	}
	return byte('0' + d - 26)
}

func threshold(k, bias int) int {
	switch {
	case k <= bias:
		return pTMin
	case k >= bias+pTMax:
		return pTMax
	}
	return k - bias
}

// punycodeEncode encodes one label (without the "xn--" prefix).
func punycodeEncode(label string) (string, error) {
	points := []rune(label)
	var out []byte
	for _, c := range points {
		if c < 0x80 {
			out = append(out, byte(c))
		}
	}
	basic := len(out)
	handled := basic
	if basic > 0 {
		out = append(out, '-')
	}
	n, delta, bias := pInitialN, 0, pInitialBias
	for handled < len(points) {
		m := math.MaxInt32
		for _, c := range points {
			if int(c) >= n && int(c) < m {
				m = int(c)
			}
		}
		if m-n > (math.MaxInt32-delta)/(handled+1) {
			return "", errPunycode
		}
		delta += (m - n) * (handled + 1)
		n = m
		for _, c := range points {
			if int(c) < n {
				delta++
			}
			if int(c) == n {
				q := delta
				for k := pBase; ; k += pBase {
					t := threshold(k, bias)
					if q < t {
						break
					}
					out = append(out, digit(t+(q-t)%(pBase-t)))
					q = (q - t) / (pBase - t)
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

// punycodeDecode decodes one label (without the "xn--" prefix).
func punycodeDecode(text string) (string, error) {
	var out []rune
	basic := strings.LastIndexByte(text, '-')
	if basic < 0 {
		basic = 0
	}
	for i := 0; i < basic; i++ {
		if text[i] >= 0x80 {
			return "", errPunycode
		}
		out = append(out, rune(text[i]))
	}
	n, i, bias := pInitialN, 0, pInitialBias
	index := 0
	if basic > 0 {
		index = basic + 1
	}
	for index < len(text) {
		oldI, w := i, 1
		for k := pBase; ; k += pBase {
			if index >= len(text) {
				return "", errPunycode
			}
			c := text[index]
			index++
			d := pBase
			switch {
			case c >= '0' && c <= '9':
				d = int(c-'0') + 26
			case c >= 'A' && c <= 'Z':
				d = int(c - 'A')
			case c >= 'a' && c <= 'z':
				d = int(c - 'a')
			}
			if d >= pBase || d > (math.MaxInt32-i)/w {
				return "", errPunycode
			}
			i += d * w
			t := threshold(k, bias)
			if d < t {
				break
			}
			if w > math.MaxInt32/(pBase-t) {
				return "", errPunycode
			}
			w *= pBase - t
		}
		count := len(out) + 1
		bias = adapt(i-oldI, count, oldI == 0)
		if i/count > math.MaxInt32-n {
			return "", errPunycode
		}
		n += i / count
		i %= count
		if n > 0x10FFFF || n >= 0xD800 && n <= 0xDFFF {
			return "", errPunycode
		}
		out = append(out[:i], append([]rune{rune(n)}, out[i:]...)...)
		i++
	}
	return string(out), nil
}

// --- domains ---------------------------------------------------------------------------------

var (
	separators      = regexp.MustCompile("[.\u3002\uff0e\uff61]")
	urlParserUnsafe = regexp.MustCompile(`[/\\?#%\x00-\x20\x7f]`)
	forbiddenDomain = regexp.MustCompile(`[\x00-\x20#%/:<>?@\[\\\]^|\x7f]`)
)

func mapLabels(domain string, fn func(string) (string, error)) (string, error) {
	labels := strings.Split(separators.ReplaceAllString(domain, "."), ".")
	for i, label := range labels {
		mapped, err := fn(label)
		if err != nil {
			return "", err
		}
		labels[i] = mapped
	}
	return strings.Join(labels, "."), nil
}

// bundledToASCII is nodemailer's bundled punycode.toASCII (no mapping, no validation).
func bundledToASCII(domain string) (string, error) {
	return mapLabels(domain, func(label string) (string, error) {
		if !nonASCII(label) {
			return label, nil
		}
		encoded, err := punycodeEncode(label)
		return "xn--" + encoded, err
	})
}

func bundledToUnicode(domain string) (string, error) {
	return mapLabels(domain, func(label string) (string, error) {
		if !strings.HasPrefix(label, "xn--") {
			return label, nil
		}
		return punycodeDecode(strings.ToLower(label[4:]))
	})
}

func ipv4Number(part string) (uint64, bool) {
	if part == "" {
		return 0, false
	}
	base := 10
	switch {
	case len(part) >= 2 && (part[:2] == "0x" || part[:2] == "0X"):
		part, base = part[2:], 16
	case len(part) >= 2 && part[0] == '0':
		part, base = part[1:], 8
	}
	if part == "" {
		return 0, true
	}
	digits := map[int]string{8: "01234567", 10: "0123456789", 16: "0123456789abcdefABCDEF"}[base]
	for _, c := range part {
		if !strings.ContainsRune(digits, c) {
			return 0, false
		}
	}
	n, err := strconv.ParseUint(part, base, 64)
	if err != nil {
		return math.MaxUint64, true // larger than any address: rejected by the caller
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
	_, ok := ipv4Number(last)
	return ok
}

// ipv4 is the WHATWG IPv4 parser ("0x7f.1" → "127.0.0.1").
func ipv4(domain string) (string, bool) {
	parts := strings.Split(domain, ".")
	if parts[len(parts)-1] == "" && len(parts) > 1 {
		parts = parts[:len(parts)-1]
	}
	if len(parts) > 4 {
		return "", false
	}
	numbers := make([]uint64, len(parts))
	for i, part := range parts {
		n, ok := ipv4Number(part)
		if !ok {
			return "", false
		}
		numbers[i] = n
	}
	last := numbers[len(numbers)-1]
	for _, n := range numbers[:len(numbers)-1] {
		if n > 255 {
			return "", false
		}
	}
	if last >= uint64(math.Pow(256, float64(5-len(numbers)))) {
		return "", false
	}
	address := last
	for i, n := range numbers[:len(numbers)-1] {
		address += n << (8 * (3 - i))
	}
	return strconv.Itoa(int(address>>24&255)) + "." + strconv.Itoa(int(address>>16&255)) + "." + strconv.Itoa(int(address>>8&255)) + "." + strconv.Itoa(int(address&255)), true
}

// domainToASCII approximates Node's url.domainToASCII for a lower-cased domain ("" when it is
// not a valid host). Labels with non-ASCII characters become punycode; UTS #46 mappings other
// than lower-casing (width, compatibility forms, ignored characters) are not applied.
func domainToASCII(domain string) string {
	labels := strings.Split(separators.ReplaceAllString(domain, "."), ".")
	for i, label := range labels {
		switch {
		case nonASCII(label):
			if strings.HasPrefix(label, "xn--") {
				return ""
			}
			encoded, err := punycodeEncode(label)
			if err != nil {
				return ""
			}
			labels[i] = "xn--" + encoded
		case strings.HasPrefix(label, "xn--"):
			decoded, err := punycodeDecode(label[4:])
			if err != nil || !nonASCII(decoded) {
				return ""
			}
			if again, err := punycodeEncode(decoded); err != nil || again != label[4:] {
				return ""
			}
		}
	}
	result := strings.Join(labels, ".")
	if forbiddenDomain.MatchString(result) {
		return ""
	}
	if endsInNumber(result) {
		address, _ := ipv4(result)
		return address
	}
	return result
}

func domainToUnicode(domain string) string {
	ascii := domainToASCII(domain)
	if ascii == "" {
		return ""
	}
	out, err := mapLabels(ascii, func(label string) (string, error) {
		if strings.HasPrefix(label, "xn--") {
			return punycodeDecode(label[4:])
		}
		return label, nil
	})
	if err != nil {
		return ""
	}
	return out
}

func normalizeDomain(domain string, toUnicode bool) (string, error) {
	if !urlParserUnsafe.MatchString(domain) {
		mapped := domainToASCII(domain)
		if toUnicode {
			mapped = domainToUnicode(domain)
		}
		if mapped != "" {
			return mapped, nil
		}
	}
	if toUnicode {
		return bundledToUnicode(domain)
	}
	return bundledToASCII(domain)
}

func normalizeLocalPart(user string) string {
	if dotAtom.MatchString(user) || quotedString.MatchString(user) {
		return user
	}
	return quoteString(user)
}

// normalizeAddress is nodemailer's _normalizeAddress: controls and <> become spaces, the domain
// is lower-cased and becomes punycode (or Unicode when the local part is not ASCII).
func normalizeAddress(addr string) string {
	addr = js.Trim(controlsAngles.ReplaceAllString(addr, " "))
	if addr == "" {
		return addr
	}
	lastAt := strings.LastIndex(addr, "@")
	if lastAt < 0 {
		return normalizeLocalPart(addr)
	}
	user, domain := addr[:lastAt], addr[lastAt+1:]
	encoded, err := normalizeDomain(js.ToLower(domain), nonASCII(user))
	if err != nil {
		encoded = domain
	}
	return normalizeLocalPart(user) + "@" + encoded
}

// --- headers and the envelope ----------------------------------------------------------------

// encodeAddressName is nodemailer's _encodeAddressName.
func encodeAddressName(name string) string {
	switch {
	case wordName.MatchString(name):
		return name
	case printable.MatchString(name):
		return quoteString(name)
	}
	return encodeWord(name, "")
}

func normalizeParsed(entries []*address) {
	for _, e := range entries {
		if e.IsGroup {
			normalizeParsed(e.Group)
		} else if e.Address != "" {
			e.Address = normalizeAddress(e.Address)
		}
	}
}

// convertAddresses is nodemailer's _convertAddresses: the header text; each address is added
// once to recipients.
func convertAddresses(entries []*address, recipients *[]string, seen map[string]bool) string {
	var values []string
	for _, e := range entries {
		switch {
		case !e.IsGroup && e.Address != "":
			e.Address = normalizeAddress(e.Address)
			if e.Name == "" {
				if plainAddress.MatchString(e.Address) {
					values = append(values, e.Address)
				} else {
					values = append(values, "<"+e.Address+">")
				}
			} else {
				values = append(values, encodeAddressName(e.Name)+" <"+e.Address+">")
			}
			if !seen[e.Address] {
				seen[e.Address] = true
				*recipients = append(*recipients, e.Address)
			}
		case e.IsGroup:
			members := ""
			if len(e.Group) > 0 {
				members = js.Trim(convertAddresses(e.Group, recipients, seen))
			}
			values = append(values, encodeAddressName(e.Name)+":"+members+";")
		}
	}
	return strings.Join(values, ", ")
}

// addressList parses an address field: its header value and its envelope recipients.
func addressList(text string) (header string, recipients []string) {
	entries := parseAddresses(text, 0)
	normalizeParsed(entries)
	recipients = []string{}
	header = convertAddresses(entries, &recipients, map[string]bool{})
	return header, recipients
}

func needsSMTPUTF8(addresses ...string) bool {
	for _, a := range addresses {
		if nonASCII(a) {
			return true
		}
	}
	return false
}
