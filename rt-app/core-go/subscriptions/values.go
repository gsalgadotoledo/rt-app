package subscriptions

// Helpers for the service: account, plan and settings data are decoded JSON values
// (map[string]any, []any, float64, string, bool, nil), handled with JavaScript semantics.
// nil stands for both null and undefined: stores and contracts treat them alike.

import (
	"encoding/json"
	"errors"
	"math"
	"slices"
	"strings"

	"rt.local/core-go/apperr"
	"rt.local/core-go/internal/canonical"
	"rt.local/core-go/internal/js"
	"rt.local/core-go/nosql"
)

// day is one day in milliseconds.
const day = 86400000.0

// obj returns v as an object (nil when it is not one).
func obj(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

// list returns v as an array (nil when it is not one).
func list(v any) []any {
	a, _ := v.([]any)
	return a
}

// num returns a JSON number, or NaN (which fails every comparison) for anything else.
func num(v any) float64 {
	if n, ok := v.(float64); ok {
		return n
	}
	if n, ok := v.(int); ok {
		return float64(n)
	}
	return math.NaN()
}

// numOr is JavaScript `v ?? fallback` for a number.
func numOr(v any, fallback float64) float64 {
	if v == nil {
		return fallback
	}
	return num(v)
}

// str returns v when it is a string, else "".
func str(v any) string {
	s, _ := v.(string)
	return s
}

// truthy is JavaScript truthiness.
func truthy(v any) bool { return js.Truthy(v) }

// strOf is String(v ?? fallback).
func strOf(v any, fallback string) string {
	if v == nil {
		return fallback
	}
	return jsString(v)
}

// spread is JavaScript {...a, ...b, ...}: a shallow merge into a new object.
func spread(objects ...map[string]any) map[string]any {
	out := map[string]any{}
	for _, o := range objects {
		for k, v := range o {
			out[k] = v
		}
	}
	return out
}

// cloneMap deep-copies an object (nil stays nil).
func cloneMap(m map[string]any) map[string]any {
	if m == nil {
		return nil
	}
	return cloneJSON(m).(map[string]any)
}

// toJSON converts a Go value (structs included) to decoded JSON values.
func toJSON(v any) any {
	raw, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	var out any
	if err := json.Unmarshal(raw, &out); err != nil {
		panic(err)
	}
	return out
}

// fromJSON decodes JSON values into a Go value.
func fromJSON(v any, into any) error {
	raw, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, into)
}

// write is a version-guarded write: a create when old is nil, else the next version of old.
func write(old *nosql.Row, pk, sk string, data map[string]any) nosql.Write {
	if old == nil {
		return nosql.Write{Row: nosql.Row{PK: pk, SK: sk, Version: 1, Data: data}}
	}
	return nosql.Write{Row: nosql.Row{PK: pk, SK: sk, Version: old.Version + 1, Data: data}, Expected: nosql.Expect(old.Version)}
}

// rowData is row?.data (nil for a missing row).
func rowData(row *nosql.Row) map[string]any {
	if row == nil {
		return nil
	}
	return row.Data
}

// isConflict reports the optimistic-concurrency Conflict (other 409 errors are not retried).
func isConflict(err error) bool {
	e, ok := apperr.As(err)
	return ok && e.Status == 409 && e.Message == apperr.ConflictMessage
}

// retry runs fn again after a Conflict, 8 attempts at most.
func retry[T any](fn func() (T, error)) (T, error) {
	var zero T
	for i := 0; i < 8; i++ {
		v, err := fn()
		if err == nil {
			return v, nil
		}
		if !isConflict(err) || i == 7 {
			return zero, err
		}
	}
	return zero, apperr.New(409, "Refresh and try again")
}

// id checks an identifier ^[a-zA-Z0-9_-]{1,100}$ (400 "Invalid identifier").
func id(v any) (string, error) {
	s, ok := v.(string)
	if !ok || !identifier.MatchString(s) {
		return "", apperr.BadRequest(msgID)
	}
	return s, nil
}

// field is one property of an ordered JSON object.
type pair struct {
	key   string
	value any
}

// stringify is JSON.stringify of an object with the given key order; nil values are omitted
// (undefined). Nested objects are written with sorted keys.
func stringify(pairs []pair) string {
	var b strings.Builder
	b.WriteByte('{')
	first := true
	for _, p := range pairs {
		if p.value == nil {
			continue
		}
		if !first {
			b.WriteByte(',')
		}
		first = false
		b.WriteString(canonical.Quote(p.key))
		b.WriteByte(':')
		b.WriteString(jsonText(p.value))
	}
	b.WriteByte('}')
	return b.String()
}

// jsonText is JSON.stringify of a decoded JSON value (object keys sorted).
func jsonText(v any) string {
	text, err := canonical.Marshal(v, func(canonical.Kind) error { return errors.New("not JSON") })
	if err != nil {
		return "null"
	}
	return text
}

// sameContent compares two JSON values by canonical text.
func sameContent(a, b any) bool { return jsonText(a) == jsonText(b) }

// arrayIndex reports whether key is a JavaScript array index.
func isIndex(key string) (uint64, bool) { return arrayIndex(key) }

// jsKeys orders object keys like JavaScript would: array-index keys ascending, then the keys
// in insertion order. Go maps have no insertion order, so `preferred` (e.g. the plan's product
// order) stands for it, followed by the remaining keys sorted by code point.
func jsKeys(keys []string, preferred []string) []string {
	rank := map[string]int{}
	for i, k := range preferred {
		if _, seen := rank[k]; !seen {
			rank[k] = i
		}
	}
	out := slices.Clone(keys)
	slices.SortStableFunc(out, func(a, b string) int {
		ai, aIdx := isIndex(a)
		bi, bIdx := isIndex(b)
		switch {
		case aIdx && bIdx:
			if ai < bi {
				return -1
			} else if ai > bi {
				return 1
			}
			return 0
		case aIdx:
			return -1
		case bIdx:
			return 1
		}
		ar, aok := rank[a]
		br, bok := rank[b]
		switch {
		case aok && bok:
			return ar - br
		case aok:
			return -1
		case bok:
			return 1
		}
		return strings.Compare(a, b)
	})
	return out
}

// mapKeys returns the keys of m ordered by jsKeys.
func mapKeys(m map[string]any, preferred []string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	return jsKeys(keys, preferred)
}

// productIDs lists the ids of a plan's products.
func productIDs(plan map[string]any) []string {
	var ids []string
	for _, p := range list(plan["products"]) {
		ids = append(ids, jsString(obj(p)["id"]))
	}
	return ids
}

// OrderedKeys returns the top-level keys of a JSON object in document order (nil when raw
// is not an object), e.g. the caller key order RecordCredits and LinkStripePrices follow.
func OrderedKeys(raw []byte) []string {
	props, err := orderedObject(raw)
	if err != nil {
		return nil
	}
	keys := make([]string, 0, len(props))
	for _, p := range props {
		if !slices.Contains(keys, p.key) {
			keys = append(keys, p.key)
		}
	}
	return keys
}

func notFound(message string) error { return apperr.NotFound(message) }
