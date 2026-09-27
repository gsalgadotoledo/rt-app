package observer

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"rt.local/core-go/internal/canonical"
	"rt.local/core-go/observer/internal/whatwg"
)

// JavaScript's \s (WhiteSpace and LineTerminator); Go's \s is ASCII only.
const jsSpace = `\t\n\x{0B}\f\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}`

// ci matches word case-insensitively on ASCII letters only: JavaScript /i without /u never folds
// U+017F (\u017f) or U+212A (Kelvin) to ASCII letters, unlike Go's (?i).
func ci(word string) string {
	var b strings.Builder
	for _, r := range word {
		if 'a' <= r && r <= 'z' {
			fmt.Fprintf(&b, "[%c%c]", r-'a'+'A', r)
		} else {
			b.WriteString(regexp.QuoteMeta(string(r)))
		}
	}
	return b.String()
}

func alternatives(words ...string) string {
	parts := make([]string, len(words))
	for i, word := range words {
		parts[i] = ci(word)
	}
	return strings.Join(parts, "|")
}

var (
	bearerPattern   = regexp.MustCompile(ci("bearer") + `[` + jsSpace + `]+[^` + jsSpace + `]+`)
	emailPattern    = regexp.MustCompile(`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`)
	keyValuePattern = regexp.MustCompile(`((?:` + alternatives("password", "token", "secret") + `|` + ci("api") + `[_-]?` + ci("key") + `)[` + jsSpace + `]*[=:][` + jsSpace + `]*)[^` + jsSpace + `,;]+`)
	secretKey       = regexp.MustCompile(alternatives("password", "secret", "token", "authorization", "cookie", "credential", "email", "phone", "body", "headers", "ip", "code"))
)

// cut is text.slice(0, n) in UTF-16 code units. A surrogate pair the cut would split is dropped
// (JavaScript keeps its high half, which Go strings cannot hold).
func cut(text string, n int) string {
	units := 0
	for i, r := range text {
		size := 1
		if r > 0xFFFF {
			size = 2
		}
		if units+size > n {
			return text[:i]
		}
		units += size
	}
	return text
}

// sanitizeString cuts to 1000 UTF-16 units, then redacts bearer tokens, e-mail addresses and
// password/token/secret/api-key assignments.
func sanitizeString(text string) string {
	text = cut(strings.ToValidUTF8(text, "\ufffd"), 1000)
	text = bearerPattern.ReplaceAllLiteralString(text, "Bearer [redacted]")
	text = emailPattern.ReplaceAllLiteralString(text, "[email]")
	return keyValuePattern.ReplaceAllString(text, "${1}[redacted]")
}

// Sanitize redacts secret keys and strings and bounds sizes: strings 1000 UTF-16 units, arrays 20
// items, objects 30 keys, depth 4 ("[truncated]" below). Object keys follow JavaScript property
// order for the cut: array-index keys first (ascending), then the others in UTF-16 order (Go maps
// have no insertion order). Errors become {name}; other values go through encoding/json.
func Sanitize(value any) any { return sanitize(value, 0) }

func sanitize(value any, depth int) any {
	if depth > 4 {
		return "[truncated]"
	}
	switch v := value.(type) {
	case nil, bool, float64, float32, int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64, json.Number:
		return v
	case string:
		return sanitizeString(v)
	case error:
		return map[string]any{"name": errorName(v)}
	case []any:
		out := make([]any, 0, min(len(v), 20))
		for _, item := range v[:min(len(v), 20)] {
			out = append(out, sanitize(item, depth+1))
		}
		return out
	case map[string]any:
		keys := OrderedKeys(v)
		out := make(map[string]any, min(len(keys), 30))
		for _, key := range keys[:min(len(keys), 30)] {
			if secretKey.MatchString(key) {
				out[key] = "[redacted]"
			} else {
				out[key] = sanitize(v[key], depth+1)
			}
		}
		return out
	case map[string]string:
		converted := make(map[string]any, len(v))
		for k, item := range v {
			converted[k] = item
		}
		return sanitize(converted, depth)
	case []string:
		converted := make([]any, len(v))
		for i, item := range v {
			converted[i] = item
		}
		return sanitize(converted, depth)
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return fmt.Sprint(value)
	}
	var decoded any
	if json.Unmarshal(raw, &decoded) != nil {
		return fmt.Sprint(value)
	}
	return sanitize(decoded, depth)
}

func errorName(err error) string {
	var named interface{ Name() string }
	if errors.As(err, &named) {
		return named.Name()
	}
	return "Error"
}

// OrderedKeys returns the keys in JavaScript property order: array-index keys ("0" …
// "4294967294") ascending, then the other keys by UTF-16 code units.
func OrderedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	slices.SortFunc(keys, func(a, b string) int {
		ia, ib := arrayIndex(a), arrayIndex(b)
		switch {
		case ia >= 0 && ib >= 0:
			return int(ia - ib)
		case ia >= 0:
			return -1
		case ib >= 0:
			return 1
		}
		return canonical.Less(a, b)
	})
	return keys
}

// arrayIndex is the numeric value of an array-index key, or -1.
func arrayIndex(key string) int64 {
	if key == "" || len(key) > 10 || key[0] == '0' && len(key) > 1 {
		return -1
	}
	n, err := strconv.ParseInt(key, 10, 64)
	if err != nil || n < 0 || n > 4294967294 || strings.TrimLeft(key, "0123456789") != "" {
		return -1
	}
	return n
}

var base, _ = whatwg.Parse("http://observer.local", nil)

// ErrNotHTTP is returned by SafePath for URLs with another protocol.
var ErrNotHTTP = errors.New("Observer expects an HTTP URL or path")

// ErrInvalidURL is returned when a URL does not parse (JavaScript: TypeError "Invalid URL").
var ErrInvalidURL = whatwg.ErrInvalid

// SafePath returns the path of an HTTP URL or path, resolved like new URL(value,
// "http://observer.local") and cut to 160 units: credentials, host, query and fragment are
// dropped.
func SafePath(value string) (string, error) {
	u, err := whatwg.Parse(value, base)
	if err != nil {
		return "", err
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", ErrNotHTTP
	}
	return cut(u.Pathname(), 160), nil
}
