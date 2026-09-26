// Package js reproduces the JavaScript semantics the TypeScript reference relies on, so the
// identity ports behave identically on loosely typed JSON: String.prototype.trim,
// toLowerCase and length (UTF-16 code units), the regular-expression \s class, truthiness,
// relational comparison with numbers and String(value).
package js

import (
	"math"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// IsSpace reports whether r is JavaScript whitespace: WhiteSpace plus LineTerminator, the set
// of both trim() and the regular-expression \s. It includes U+00A0, U+FEFF, U+2028, U+3000 and
// every Zs character; it excludes U+0085, U+180E, U+200B and U+001C–U+001F.
func IsSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0x00A0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return 0x2000 <= r && r <= 0x200A
}

// Trim is String.prototype.trim.
func Trim(s string) string { return strings.TrimFunc(s, IsSpace) }

// Len is String.prototype.length: UTF-16 code units (runes above U+FFFF count twice).
func Len(s string) int {
	n := 0
	for _, r := range s {
		if r > 0xFFFF {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// ToLower is String.prototype.toLowerCase: full Unicode lowercasing with the unconditional
// special casing (U+0130 → "i\u0307") and the Final_Sigma rule (Σ → ς at the end of a word).
func ToLower(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for i, r := range s {
		switch {
		case r < utf8.RuneSelf:
			if 'A' <= r && r <= 'Z' {
				r += 'a' - 'A'
			}
			b.WriteByte(byte(r))
		case r == 0x0130:
			b.WriteString("i\u0307")
		case r == 0x03A3:
			if finalSigma(s, i) {
				b.WriteRune(0x03C2)
			} else {
				b.WriteRune(0x03C3)
			}
		default:
			b.WriteRune(unicode.ToLower(r))
		}
	}
	return b.String()
}

// finalSigma: a cased letter precedes (skipping case-ignorables) and none follows.
func finalSigma(s string, at int) bool {
	before := false
	for i := at; i > 0; {
		r, size := utf8.DecodeLastRuneInString(s[:i])
		i -= size
		if caseIgnorable(r) {
			continue
		}
		before = cased(r)
		break
	}
	if !before {
		return false
	}
	for _, r := range s[at+utf8.RuneLen(0x03A3):] {
		if caseIgnorable(r) {
			continue
		}
		return !cased(r)
	}
	return true
}

func cased(r rune) bool {
	return unicode.IsUpper(r) || unicode.IsLower(r) || unicode.IsTitle(r) ||
		unicode.Is(unicode.Other_Lowercase, r) || unicode.Is(unicode.Other_Uppercase, r)
}

func caseIgnorable(r rune) bool {
	switch r {
	case '\'', '.', ':', '^', '`', 0x00A8, 0x00AD, 0x00AF, 0x00B4, 0x00B7, 0x00B8, 0x2018, 0x2019, 0x2024, 0x2027:
		return true
	}
	return unicode.In(r, unicode.Mn, unicode.Me, unicode.Cf, unicode.Lm, unicode.Sk)
}

// Truthy is JavaScript truthiness of a JSON value (nil is null/undefined).
func Truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case float64:
		return x != 0 && !math.IsNaN(x)
	case int:
		return x != 0
	case string:
		return x != ""
	default:
		return true
	}
}

// Number is JavaScript's Number(value) for JSON values: null → 0, booleans → 0/1, strings
// parsed after trimming ("" → 0), anything else NaN. Missing fields (undefined) are NaN;
// callers pass present=false for them.
func Number(v any, present bool) float64 {
	if !present {
		return math.NaN()
	}
	switch x := v.(type) {
	case nil:
		return 0
	case bool:
		if x {
			return 1
		}
		return 0
	case float64:
		return x
	case int:
		return float64(x)
	case string:
		t := Trim(x)
		if t == "" {
			return 0
		}
		switch strings.TrimLeft(t, "+-") {
		case "Infinity":
			if strings.HasPrefix(t, "-") {
				return math.Inf(-1)
			}
			return math.Inf(1)
		}
		if strings.Trim(t, "0123456789.eE+-") != "" { // ParseFloat also reads inf, nan, 0x…, 1_0
			return math.NaN()
		}
		if f, err := strconv.ParseFloat(t, 64); err == nil {
			return f
		}
		return math.NaN()
	default:
		return math.NaN()
	}
}

// Field returns Number(data[key]) with undefined for a missing key.
func Field(data map[string]any, key string) float64 {
	v, present := data[key]
	return Number(v, present)
}

// Integer is Number.isInteger: a finite float64 without a fraction (booleans are not numbers).
func Integer(v any) (float64, bool) {
	f, ok := v.(float64)
	if !ok || math.IsInf(f, 0) || f != math.Trunc(f) {
		return 0, false
	}
	return f, true
}

// String is String(value) for JSON values; nil is written "undefined" (the missing fields
// the reference interpolates are undefined, not null).
func String(v any) string {
	switch x := v.(type) {
	case nil:
		return "undefined"
	case string:
		return x
	case bool:
		return strconv.FormatBool(x)
	case float64:
		return FormatNumber(x)
	case int:
		return strconv.Itoa(x)
	case []any:
		parts := make([]string, len(x))
		for i, item := range x {
			if item != nil {
				parts[i] = String(item)
			}
		}
		return strings.Join(parts, ",")
	default:
		return "[object Object]"
	}
}

// FormatNumber is JavaScript's Number to String: integers as plain digits below 1e21,
// exponent form otherwise ("1e+21", "1e-7").
func FormatNumber(f float64) string {
	switch {
	case math.IsNaN(f):
		return "NaN"
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	case f == 0:
		return "0"
	}
	abs := math.Abs(f)
	if abs >= 1e-6 && abs < 1e21 {
		return strconv.FormatFloat(f, 'f', -1, 64)
	}
	s := strconv.FormatFloat(f, 'e', -1, 64) // e.g. 1e+21, 1.5e-07
	mantissa, exp, _ := strings.Cut(s, "e")
	sign := exp[0]
	exp = strings.TrimLeft(exp[1:], "0")
	return mantissa + "e" + string(sign) + exp
}

// Add returns v + n for a stored counter: numbers add, anything else becomes nil (the NaN of
// the reference, which JSON.stringify writes as null).
func Add(v any, n float64) any {
	if f, ok := v.(float64); ok {
		return f + n
	}
	return nil
}

// Equal is strict equality (===) of JSON scalars; nil stands for both null and undefined.
func Equal(a, b any) bool {
	switch x := a.(type) {
	case nil:
		return b == nil
	case float64:
		y, ok := b.(float64)
		return ok && x == y
	case string:
		y, ok := b.(string)
		return ok && x == y
	case bool:
		y, ok := b.(bool)
		return ok && x == y
	default:
		return false // objects and arrays are compared by identity in JavaScript
	}
}

// EncodeURIComponent is JavaScript's encodeURIComponent (UTF-8, uppercase hex).
func EncodeURIComponent(s string) string {
	const unreserved = "-_.!~*'()"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if 'a' <= c && c <= 'z' || 'A' <= c && c <= 'Z' || '0' <= c && c <= '9' || strings.IndexByte(unreserved, c) >= 0 {
			b.WriteByte(c)
			continue
		}
		b.WriteByte('%')
		b.WriteByte("0123456789ABCDEF"[c>>4])
		b.WriteByte("0123456789ABCDEF"[c&15])
	}
	return b.String()
}
