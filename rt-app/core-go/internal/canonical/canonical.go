// Package canonical writes the canonical JSON the cache and idempotency modules hash and store
// (TypeScript is the reference): JSON.stringify output with object keys sorted by UTF-16 code
// units, JavaScript numbers (float64: 1e+21, 1e-7, -0 as 0) and JSON.stringify strings, which
// escape only '"', '\\' and U+0000–U+001F, never U+2028, DEL or "<>&" (unlike encoding/json).
package canonical

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"reflect"
	"slices"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"rt.local/core-go/internal/js"
)

// Kind tells why a value is not canonical JSON.
type Kind int

const (
	// NotFinite: a non-finite number or a cycle (TypeScript: "finite, acyclic JSON values").
	NotFinite Kind = iota
	// NotPlain: a type JSON cannot hold (TypeScript: "plain objects only").
	NotPlain
)

// Fail builds the error returned for a value that is not JSON.
type Fail func(Kind) error

// Marshal returns the canonical JSON text of v. v holds decoded JSON (nil, bool, float64,
// string, []any, map[string]any); other Go values (ints, structs, typed maps and slices) are
// first converted through encoding/json.
func Marshal(v any, fail Fail) (string, error) {
	w := writer{fail: fail, ancestors: map[uintptr]bool{}}
	if err := w.value(v); err != nil {
		return "", err
	}
	return w.buf.String(), nil
}

// Parse is JSON.parse of canonical text: numbers become float64.
func Parse(text string) (any, error) {
	var v any
	if err := json.Unmarshal([]byte(text), &v); err != nil {
		return nil, err
	}
	return v, nil
}

// Clone is JSON.parse(canonical(v)): the normalized deep copy both modules store and return.
func Clone(v any, fail Fail) (any, error) {
	text, err := Marshal(v, fail)
	if err != nil {
		return nil, err
	}
	return Parse(text)
}

// UTF8 is the UTF-8 encoding JavaScript uses for hashing; invalid bytes become U+FFFD.
func UTF8(s string) []byte {
	return []byte(strings.ToValidUTF8(s, "�"))
}

// SHA256Hex is the hex SHA-256 of the UTF-8 text.
func SHA256Hex(s string) string {
	sum := sha256.Sum256(UTF8(s))
	return hex.EncodeToString(sum[:])
}

// Quote is JSON.stringify of a string.
func Quote(s string) string {
	var b bytes.Buffer
	quote(&b, s)
	return b.String()
}

// Less orders strings by UTF-16 code units, the order of JavaScript's default sort.
func Less(a, b string) int {
	return slices.Compare(utf16.Encode([]rune(a)), utf16.Encode([]rune(b)))
}

type writer struct {
	buf       bytes.Buffer
	fail      Fail
	ancestors map[uintptr]bool
}

func (w *writer) value(v any) error {
	switch x := v.(type) {
	case nil:
		w.buf.WriteString("null")
	case bool:
		if x {
			w.buf.WriteString("true")
		} else {
			w.buf.WriteString("false")
		}
	case string:
		quote(&w.buf, x)
	case float64:
		return w.number(x)
	case float32:
		return w.number(float64(x))
	case int:
		return w.number(float64(x))
	case int64:
		return w.number(float64(x))
	case int32:
		return w.number(float64(x))
	case json.Number:
		f, err := x.Float64()
		if err != nil {
			return w.fail(NotFinite)
		}
		return w.number(f)
	case []any:
		return w.nested(x, func() error {
			w.buf.WriteByte('[')
			for i, item := range x {
				if i > 0 {
					w.buf.WriteByte(',')
				}
				if err := w.value(item); err != nil {
					return err
				}
			}
			w.buf.WriteByte(']')
			return nil
		})
	case map[string]any:
		return w.nested(x, func() error {
			keys := make([]string, 0, len(x))
			for k := range x {
				keys = append(keys, k)
			}
			slices.SortFunc(keys, Less)
			w.buf.WriteByte('{')
			for i, k := range keys {
				if i > 0 {
					w.buf.WriteByte(',')
				}
				quote(&w.buf, k)
				w.buf.WriteByte(':')
				if err := w.value(x[k]); err != nil {
					return err
				}
			}
			w.buf.WriteByte('}')
			return nil
		})
	default:
		return w.converted(v)
	}
	return nil
}

func (w *writer) number(f float64) error {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return w.fail(NotFinite)
	}
	w.buf.WriteString(js.FormatNumber(f))
	return nil
}

// nested guards maps and slices against cycles (JavaScript throws on them).
func (w *writer) nested(v any, write func() error) error {
	rv := reflect.ValueOf(v)
	var id uintptr
	if rv.Kind() == reflect.Map || rv.Len() > 0 {
		id = rv.Pointer()
	}
	if id != 0 {
		if w.ancestors[id] {
			return w.fail(NotFinite)
		}
		w.ancestors[id] = true
		defer delete(w.ancestors, id)
	}
	return write()
}

// converted handles other Go values through encoding/json (structs, typed maps, integers…).
func (w *writer) converted(v any) error {
	raw, err := json.Marshal(v)
	if err != nil {
		var unsupported *json.UnsupportedValueError
		if errors.As(err, &unsupported) {
			return w.fail(NotFinite)
		}
		return w.fail(NotPlain)
	}
	decoded, err := Parse(string(raw))
	if err != nil {
		return w.fail(NotPlain)
	}
	return w.value(decoded)
}

func quote(b *bytes.Buffer, s string) {
	const hexDigits = "0123456789abcdef"
	b.WriteByte('"')
	for i := 0; i < len(s); {
		r, size := utf8.DecodeRuneInString(s[i:])
		i += size
		switch {
		case r == '"':
			b.WriteString(`\"`)
		case r == '\\':
			b.WriteString(`\\`)
		case r == '\b':
			b.WriteString(`\b`)
		case r == '\f':
			b.WriteString(`\f`)
		case r == '\n':
			b.WriteString(`\n`)
		case r == '\r':
			b.WriteString(`\r`)
		case r == '\t':
			b.WriteString(`\t`)
		case r < 0x20:
			b.WriteString(`\u00`)
			b.WriteByte(hexDigits[r>>4])
			b.WriteByte(hexDigits[r&15])
		default:
			b.WriteRune(r) // invalid bytes decode as U+FFFD
		}
	}
	b.WriteByte('"')
}
