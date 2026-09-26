package subscriptions

// JavaScript value semantics the TypeScript reference relies on (see rt-app/docs/polyglot.md,
// "Numeric and time conventions"). Numbers are float64 everywhere, like JavaScript Number.

import (
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"unicode/utf8"
)

// maxSafeInteger is Number.MAX_SAFE_INTEGER (2^53 - 1).
const maxSafeInteger = 1<<53 - 1

// jsRound is JavaScript Math.round: halves round towards +Infinity (0.5 → 1, -2.5 → -2),
// computed like V8 (ceil, then step back when the ceiling is more than half away), so values
// such as 0.49999999999999994 round to 0 where floor(x + 0.5) would give 1.
func jsRound(x float64) float64 {
	if math.IsNaN(x) || math.IsInf(x, 0) {
		return x
	}
	r := math.Ceil(x)
	if r-0.5 > x {
		r--
	}
	return r
}

// safeInteger reports Number.isSafeInteger(v): a JSON number (never a boolean or string)
// with no fraction and |v| <= 2^53 - 1.
func safeInteger(v any) (float64, bool) {
	n, ok := v.(float64)
	return n, ok && safeFloat(n)
}

func safeFloat(n float64) bool {
	return !math.IsNaN(n) && !math.IsInf(n, 0) && math.Trunc(n) == n && math.Abs(n) <= maxSafeInteger
}

// NumberString is JavaScript Number → String (String(x), template literals): 1 → "1", 1.5 → "1.5", -1 → "-1",
// 1e21 → "1e+21", 1e-7 → "1e-7", 0.000001 → "0.000001".
func NumberString(x float64) string {
	switch {
	case math.IsNaN(x):
		return "NaN"
	case x == 0:
		return "0" // -0 too
	case math.IsInf(x, 1):
		return "Infinity"
	case math.IsInf(x, -1):
		return "-Infinity"
	}
	sign := ""
	if x < 0 {
		sign, x = "-", -x
	}
	// Shortest round-trip digits, the same choice ECMAScript Number::toString makes.
	mantissa, exponent, _ := strings.Cut(strconv.FormatFloat(x, 'e', -1, 64), "e")
	digits := strings.Replace(mantissa, ".", "", 1)
	e, _ := strconv.Atoi(exponent)
	k, n := len(digits), e+1 // value = 0.digits × 10^n
	switch {
	case k <= n && n <= 21:
		return sign + digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		return sign + digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		return sign + "0." + strings.Repeat("0", -n) + digits
	}
	exp := "e+" + strconv.Itoa(n-1)
	if n-1 < 0 {
		exp = "e-" + strconv.Itoa(1-n)
	}
	if k == 1 {
		return sign + digits + exp
	}
	return sign + digits[:1] + "." + digits[1:] + exp
}

// jsString is JavaScript String(v) for a decoded JSON value.
func jsString(v any) string {
	switch v := v.(type) {
	case nil:
		return "null"
	case string:
		return v
	case bool:
		return strconv.FormatBool(v)
	case float64:
		return NumberString(v)
	case []any:
		parts := make([]string, len(v))
		for i, item := range v {
			if item != nil { // null and undefined elements join as ""
				parts[i] = jsString(item)
			}
		}
		return strings.Join(parts, ",")
	default:
		return "[object Object]"
	}
}

// jsSpace reports the characters JavaScript String.prototype.trim removes: WhiteSpace
// (tab, VT, FF, space, NBSP, BOM and category Zs) and LineTerminator (LF, CR, LS, PS).
func jsSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}

// Strings may carry a lone UTF-16 surrogate (JavaScript allows them), for instance after a
// cut through a surrogate pair. Such a surrogate is kept as its generalized UTF-8 (WTF-8)
// 3-byte sequence ED A0..BF 80..BF, which marshalString writes back as a \uXXXX escape.

// surrogateAt reports whether s[i:] starts with an encoded lone surrogate.
func surrogateAt(s string, i int) bool {
	return i+2 < len(s) && s[i] == 0xED && s[i+1] >= 0xA0 && s[i+1] <= 0xBF && s[i+2] >= 0x80 && s[i+2] <= 0xBF
}

// cutUTF16 is JavaScript s.slice(0, n): the first n UTF-16 code units. A cut through a
// surrogate pair keeps the lone high surrogate.
func cutUTF16(s string, n int) string {
	var out strings.Builder
	units := 0
	for i := 0; i < len(s) && units < n; {
		if surrogateAt(s, i) {
			out.WriteString(s[i : i+3])
			units, i = units+1, i+3
			continue
		}
		r, size := utf8.DecodeRuneInString(s[i:])
		if r > 0xFFFF {
			if units+2 > n {
				high := 0xD800 + (r-0x10000)>>10
				out.Write([]byte{0xE0 | byte(high>>12), 0x80 | byte(high>>6&0x3F), 0x80 | byte(high&0x3F)})
				break
			}
			units++
		}
		out.WriteString(s[i : i+size])
		units, i = units+1, i+size
	}
	return out.String()
}

// wellFormed is what Node's Buffer.from(s) (UTF-8) encodes: every lone surrogate and every
// invalid byte becomes U+FFFD.
func wellFormed(s string) string {
	if utf8.ValidString(s) {
		return s
	}
	var out strings.Builder
	for i := 0; i < len(s); {
		if surrogateAt(s, i) {
			out.WriteRune(utf8.RuneError)
			i += 3
			continue
		}
		r, size := utf8.DecodeRuneInString(s[i:])
		out.WriteRune(r) // RuneError for an invalid byte
		i += size
	}
	return out.String()
}

// marshalString encodes s as a JSON string, writing lone surrogates as \uXXXX escapes
// (encoding/json would replace them with U+FFFD).
func marshalString(s string) ([]byte, error) {
	if utf8.ValidString(s) {
		return json.Marshal(s)
	}
	out := []byte{'"'}
	start := 0
	flush := func(end int) error {
		if start == end {
			return nil
		}
		chunk, err := json.Marshal(s[start:end])
		if err != nil {
			return err
		}
		out = append(out, chunk[1:len(chunk)-1]...)
		return nil
	}
	for i := 0; i < len(s); {
		if !surrogateAt(s, i) {
			i++
			continue
		}
		if err := flush(i); err != nil {
			return nil, err
		}
		unit := rune(s[i]&0x0F)<<12 | rune(s[i+1]&0x3F)<<6 | rune(s[i+2]&0x3F)
		out = append(out, `\u`+strconv.FormatInt(int64(unit), 16)...)
		i += 3
		start = i
	}
	if err := flush(len(s)); err != nil {
		return nil, err
	}
	return append(out, '"'), nil
}

// cloneJSON deep-copies a decoded JSON value (maps and slices), like structuredClone.
func cloneJSON(v any) any {
	switch v := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(v))
		for k, item := range v {
			out[k] = cloneJSON(item)
		}
		return out
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = cloneJSON(item)
		}
		return out
	default:
		return v
	}
}
