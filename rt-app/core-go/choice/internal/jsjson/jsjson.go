// Package jsjson writes JSON text exactly like JavaScript's JSON.stringify, for the choice
// modules (the TypeScript reference hashes, measures and sends that text):
//
//   - numbers use JavaScript Number to String (1e+21, 1e-7, 100, -0 → 0);
//   - only '"', '\' and control characters are escaped; U+2028, DEL, '<', '>' and '&' stay raw;
//   - object keys follow JavaScript property order: array-index keys ("0" … "4294967294") first
//     in numeric order, then the other keys. Go maps have no insertion order, so the others are
//     sorted by UTF-16 code units: the order of JSON.parse(canonical(value)).
//
// Values are decoded JSON: nil, bool, float64, string, []any and map[string]any (plus
// json.RawMessage, written as is, and Pairs for an explicit insertion order).
package jsjson

import (
	"encoding/json"
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"rt.local/core-go/internal/js"
)

// Pair is one object member; Pairs keep their insertion order for non-index keys.
type Pair struct {
	Key   string
	Value any
}

// Pairs is an object written with JavaScript property order over this insertion order.
type Pairs []Pair

// Stringify returns JSON.stringify(value) with JavaScript property order.
func Stringify(value any) (string, error) {
	var b strings.Builder
	if err := write(&b, value, false); err != nil {
		return "", err
	}
	return b.String(), nil
}

// Canonical returns the canonical JSON of @gsalgadotoledo/rt-app-cache: every object's keys
// sorted by UTF-16 code units (JavaScript's default sort, array-index keys included).
func Canonical(value any) (string, error) {
	var b strings.Builder
	if err := write(&b, value, true); err != nil {
		return "", err
	}
	return b.String(), nil
}

// Quote returns JSON.stringify(s).
func Quote(s string) string {
	var b strings.Builder
	quote(&b, s)
	return b.String()
}

// IsArrayIndex reports whether JavaScript treats key as an array index.
func IsArrayIndex(key string) bool {
	if key == "" || len(key) > 10 || (key[0] == '0' && len(key) > 1) {
		return false
	}
	for i := 0; i < len(key); i++ {
		if key[i] < '0' || key[i] > '9' {
			return false
		}
	}
	n, err := strconv.ParseUint(key, 10, 64)
	return err == nil && n <= math.MaxUint32-1
}

// CompareUTF16 compares strings by UTF-16 code units, like JavaScript's default sort.
func CompareUTF16(a, b string) int {
	return slices.Compare(utf16.Encode([]rune(a)), utf16.Encode([]rune(b)))
}

// Order returns keys in JavaScript property order: array indexes ascending, then the rest in
// the given order.
func Order(keys []string) []string {
	var indexes, others []string
	for _, k := range keys {
		if IsArrayIndex(k) {
			indexes = append(indexes, k)
		} else {
			others = append(others, k)
		}
	}
	slices.SortStableFunc(indexes, func(a, b string) int {
		x, _ := strconv.ParseUint(a, 10, 64)
		y, _ := strconv.ParseUint(b, 10, 64)
		return cmpUint(x, y)
	})
	return append(indexes, others...)
}

func cmpUint(a, b uint64) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}

func write(b *strings.Builder, value any, sorted bool) error {
	switch v := value.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		b.WriteString(strconv.FormatBool(v))
	case float64:
		if math.IsNaN(v) || math.IsInf(v, 0) {
			b.WriteString("null") // JSON.stringify(NaN)
		} else {
			b.WriteString(js.FormatNumber(v))
		}
	case int:
		b.WriteString(js.FormatNumber(float64(v)))
	case string:
		quote(b, v)
	case json.RawMessage:
		b.Write(v)
	case []any:
		b.WriteByte('[')
		for i, item := range v {
			if i > 0 {
				b.WriteByte(',')
			}
			if err := write(b, item, sorted); err != nil {
				return err
			}
		}
		b.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(v))
		for k := range v {
			keys = append(keys, k)
		}
		slices.SortFunc(keys, CompareUTF16)
		if !sorted {
			keys = Order(keys)
		}
		b.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				b.WriteByte(',')
			}
			quote(b, k)
			b.WriteByte(':')
			if err := write(b, v[k], sorted); err != nil {
				return err
			}
		}
		b.WriteByte('}')
	case Pairs:
		keys := make([]string, len(v))
		values := make(map[string]any, len(v))
		for i, p := range v {
			keys[i] = p.Key
			values[p.Key] = p.Value
		}
		if sorted {
			slices.SortFunc(keys, CompareUTF16)
		} else {
			keys = Order(keys)
		}
		b.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				b.WriteByte(',')
			}
			quote(b, k)
			b.WriteByte(':')
			if err := write(b, values[k], sorted); err != nil {
				return err
			}
		}
		b.WriteByte('}')
	default:
		return fmt.Errorf("jsjson: cannot write %T", value)
	}
	return nil
}

func quote(b *strings.Builder, s string) {
	b.WriteByte('"')
	for i := 0; i < len(s); {
		c := s[i]
		if c < utf8.RuneSelf {
			switch {
			case c == '"':
				b.WriteString(`\"`)
			case c == '\\':
				b.WriteString(`\\`)
			case c == '\b':
				b.WriteString(`\b`)
			case c == '\f':
				b.WriteString(`\f`)
			case c == '\n':
				b.WriteString(`\n`)
			case c == '\r':
				b.WriteString(`\r`)
			case c == '\t':
				b.WriteString(`\t`)
			case c < 0x20:
				fmt.Fprintf(b, `\u%04x`, c)
			default:
				b.WriteByte(c)
			}
			i++
			continue
		}
		r, size := utf8.DecodeRuneInString(s[i:])
		if r == utf8.RuneError && size == 1 {
			b.WriteString("\ufffd") // invalid UTF-8: JavaScript strings cannot hold it
		} else {
			b.WriteString(s[i : i+size])
		}
		i += size
	}
	b.WriteByte('"')
}
