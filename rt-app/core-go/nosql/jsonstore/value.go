package jsonstore

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"slices"
	"strconv"
	"strings"

	"rt.local/core-go/internal/canonical"
	"rt.local/core-go/internal/js"
)

// value is a parsed JSON value that keeps what JSON.parse keeps: object keys in insertion order
// (a repeated key keeps its first position and its last value) and numbers as float64.
type value struct {
	kind   kind
	str    string
	num    float64
	truth  bool
	array  []*value
	keys   []string
	fields map[string]*value
}

type kind int

const (
	kindNull kind = iota
	kindBool
	kindNumber
	kindString
	kindArray
	kindObject
)

var errSyntax = errors.New("invalid JSON")

// parse is JSON.parse of a whole document.
func parse(raw []byte) (*value, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	v, err := parseValue(dec)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errSyntax // trailing data
	}
	return v, nil
}

func parseValue(dec *json.Decoder) (*value, error) {
	token, err := dec.Token()
	if err != nil {
		return nil, errSyntax
	}
	switch t := token.(type) {
	case nil:
		return &value{kind: kindNull}, nil
	case bool:
		return &value{kind: kindBool, truth: t}, nil
	case string:
		return &value{kind: kindString, str: t}, nil
	case json.Number:
		// JSON.parse: "1e400" is Infinity, which JSON.stringify writes as null.
		f, err := strconv.ParseFloat(string(t), 64)
		if err != nil && !errors.Is(err, strconv.ErrRange) {
			return nil, errSyntax
		}
		return &value{kind: kindNumber, num: f}, nil
	case json.Delim:
		switch t {
		case '[':
			out := &value{kind: kindArray, array: []*value{}}
			for dec.More() {
				item, err := parseValue(dec)
				if err != nil {
					return nil, err
				}
				out.array = append(out.array, item)
			}
			if _, err := dec.Token(); err != nil {
				return nil, errSyntax
			}
			return out, nil
		case '{':
			out := newObject()
			for dec.More() {
				key, err := dec.Token()
				if err != nil {
					return nil, errSyntax
				}
				name, ok := key.(string)
				if !ok {
					return nil, errSyntax
				}
				item, err := parseValue(dec)
				if err != nil {
					return nil, err
				}
				out.set(name, item)
			}
			if _, err := dec.Token(); err != nil {
				return nil, errSyntax
			}
			return out, nil
		}
	}
	return nil, errSyntax
}

func newObject() *value { return &value{kind: kindObject, fields: map[string]*value{}} }

// set adds or replaces a field; a replaced field keeps its position.
func (v *value) set(key string, item *value) {
	if _, ok := v.fields[key]; !ok {
		v.keys = append(v.keys, key)
	}
	v.fields[key] = item
}

func (v *value) get(key string) (*value, bool) {
	if v == nil || v.kind != kindObject {
		return nil, false
	}
	item, ok := v.fields[key]
	return item, ok
}

// isArrayIndex tells whether JavaScript orders the key as an array index ("0".."4294967294").
func isArrayIndex(key string) bool {
	if key == "" || len(key) > 10 || (len(key) > 1 && key[0] == '0') {
		return false
	}
	n, err := strconv.ParseUint(key, 10, 64)
	return err == nil && n < 4294967295
}

// jsOrder is JavaScript own-property order: array-index keys ascending, then insertion order.
func jsOrder(keys []string) []string {
	var indices, others []string
	for _, key := range keys {
		if isArrayIndex(key) {
			indices = append(indices, key)
		} else {
			others = append(others, key)
		}
	}
	slices.SortFunc(indices, func(a, b string) int {
		x, _ := strconv.ParseUint(a, 10, 64)
		y, _ := strconv.ParseUint(b, 10, 64)
		return int(x) - int(y)
	})
	return append(indices, others...)
}

// write appends JSON.stringify of v.
func (v *value) write(b *bytes.Buffer) {
	switch v.kind {
	case kindNull:
		b.WriteString("null")
	case kindBool:
		b.WriteString(strconv.FormatBool(v.truth))
	case kindNumber:
		if math.IsInf(v.num, 0) || math.IsNaN(v.num) {
			b.WriteString("null")
		} else {
			b.WriteString(js.FormatNumber(v.num))
		}
	case kindString:
		b.WriteString(canonical.Quote(v.str))
	case kindArray:
		b.WriteByte('[')
		for i, item := range v.array {
			if i > 0 {
				b.WriteByte(',')
			}
			item.write(b)
		}
		b.WriteByte(']')
	case kindObject:
		b.WriteByte('{')
		for i, key := range jsOrder(v.keys) {
			if i > 0 {
				b.WriteByte(',')
			}
			b.WriteString(canonical.Quote(key))
			b.WriteByte(':')
			v.fields[key].write(b)
		}
		b.WriteByte('}')
	}
}

// native converts to the decoded-JSON Go values the store API uses (float64 numbers).
func (v *value) native() any {
	switch v.kind {
	case kindBool:
		return v.truth
	case kindNumber:
		return v.num
	case kindString:
		return v.str
	case kindArray:
		out := make([]any, len(v.array))
		for i, item := range v.array {
			out[i] = item.native()
		}
		return out
	case kindObject:
		out := make(map[string]any, len(v.keys))
		for _, key := range v.keys {
			out[key] = v.fields[key].native()
		}
		return out
	}
	return nil
}

// fromNative converts a Go value; maps get keys in UTF-16 order (Go maps keep no order).
func fromNative(x any) (*value, error) {
	switch t := x.(type) {
	case nil:
		return &value{kind: kindNull}, nil
	case bool:
		return &value{kind: kindBool, truth: t}, nil
	case string:
		return &value{kind: kindString, str: t}, nil
	case float64:
		return &value{kind: kindNumber, num: t}, nil
	case float32:
		return &value{kind: kindNumber, num: float64(t)}, nil
	case int:
		return &value{kind: kindNumber, num: float64(t)}, nil
	case int64:
		return &value{kind: kindNumber, num: float64(t)}, nil
	case json.Number:
		f, err := t.Float64()
		if err != nil && !errors.Is(err, strconv.ErrRange) {
			return nil, err
		}
		return &value{kind: kindNumber, num: f}, nil
	case []any:
		out := &value{kind: kindArray, array: make([]*value, 0, len(t))}
		for _, item := range t {
			converted, err := fromNative(item)
			if err != nil {
				return nil, err
			}
			out.array = append(out.array, converted)
		}
		return out, nil
	case map[string]any:
		out := newObject()
		keys := make([]string, 0, len(t))
		for key := range t {
			keys = append(keys, key)
		}
		slices.SortFunc(keys, canonical.Less)
		for _, key := range keys {
			converted, err := fromNative(t[key])
			if err != nil {
				return nil, err
			}
			out.set(key, converted)
		}
		return out, nil
	}
	// Other Go values (structs, typed maps and slices) go through encoding/json first.
	raw, err := json.Marshal(x)
	if err != nil {
		return nil, fmt.Errorf("jsonstore: %w", err)
	}
	return parse(raw)
}

// truthy is JavaScript truthiness.
func (v *value) truthy() bool {
	switch v.kind {
	case kindNull:
		return false
	case kindBool:
		return v.truth
	case kindNumber:
		return v.num != 0 && !math.IsNaN(v.num)
	case kindString:
		return v.str != ""
	}
	return true
}

// number is JavaScript Number(v).
func (v *value) number() float64 {
	switch v.kind {
	case kindNull:
		return 0
	case kindBool:
		if v.truth {
			return 1
		}
		return 0
	case kindNumber:
		return v.num
	case kindString:
		return stringNumber(v.str)
	case kindArray:
		switch len(v.array) {
		case 0:
			return 0
		case 1:
			if item := v.array[0]; item.kind != kindArray && item.kind != kindObject {
				if item.kind == kindNull {
					return 0
				}
				return item.number()
			}
		}
	}
	return math.NaN()
}

// stringNumber is JavaScript Number(text): trimmed decimal, Infinity or 0x/0o/0b integers.
func stringNumber(text string) float64 {
	t := js.Trim(text)
	switch t {
	case "":
		return 0
	case "Infinity", "+Infinity":
		return math.Inf(1)
	case "-Infinity":
		return math.Inf(-1)
	}
	if len(t) > 2 && t[0] == '0' {
		base := map[byte]int{'x': 16, 'X': 16, 'o': 8, 'O': 8, 'b': 2, 'B': 2}[t[1]]
		if base != 0 {
			n, err := strconv.ParseUint(t[2:], base, 64)
			if err != nil && !errors.Is(err, strconv.ErrRange) {
				return math.NaN()
			}
			if err != nil { // larger than 64 bits: accumulate as a float
				f := 0.0
				for _, c := range strings.ToLower(t[2:]) {
					d, _ := strconv.ParseUint(string(c), base, 8)
					f = f*float64(base) + float64(d)
				}
				return f
			}
			return float64(n)
		}
	}
	if !decimal(t) {
		return math.NaN()
	}
	f, err := strconv.ParseFloat(t, 64)
	if err != nil && !errors.Is(err, strconv.ErrRange) {
		return math.NaN()
	}
	return f
}

// decimal matches [+-]?(digits[.digits?]|.digits)([eE][+-]?digits)?
func decimal(t string) bool {
	i := 0
	if i < len(t) && (t[i] == '+' || t[i] == '-') {
		i++
	}
	digits := func() int {
		start := i
		for i < len(t) && t[i] >= '0' && t[i] <= '9' {
			i++
		}
		return i - start
	}
	whole := digits()
	fraction := 0
	if i < len(t) && t[i] == '.' {
		i++
		fraction = digits()
	}
	if whole == 0 && fraction == 0 {
		return false
	}
	if i < len(t) && (t[i] == 'e' || t[i] == 'E') {
		i++
		if i < len(t) && (t[i] == '+' || t[i] == '-') {
			i++
		}
		if digits() == 0 {
			return false
		}
	}
	return i == len(t)
}
