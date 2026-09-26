// Package conformance runs a contract host (protocol v1) so the language-neutral contracts in
// rt-app/spec/contracts test the Go implementations. See rt-app/docs/polyglot.md.
package conformance

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math/big"
	"time"
)

// Wire values are JSON plus tagged objects for types JSON cannot carry:
//
//	{"$date": "2026-01-02T03:04:05.678Z"}  time.Time
//	{"$bytes": "<base64>"}                 []byte
//	{"$bigint": "<digits>"}                *big.Int
//
// nil stands for undefined/None/nil; in objects a null field equals a missing one.

// Encode converts time.Time, []byte and *big.Int (also inside map[string]any and []any) to
// tagged wire values. Other values, structs included, are left to encoding/json.
func Encode(value any) any {
	switch v := value.(type) {
	case time.Time:
		return map[string]string{"$date": v.UTC().Format("2006-01-02T15:04:05.000Z")}
	case *time.Time:
		if v == nil {
			return nil
		}
		return Encode(*v)
	case []byte:
		if v == nil {
			return nil
		}
		return map[string]string{"$bytes": base64.StdEncoding.EncodeToString(v)}
	case *big.Int:
		if v == nil {
			return nil
		}
		return map[string]string{"$bigint": v.String()}
	case map[string]any:
		out := make(map[string]any, len(v))
		for k, item := range v {
			out[k] = Encode(item)
		}
		return out
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = Encode(item)
		}
		return out
	default:
		return value
	}
}

// Decode parses a wire value: objects, arrays, strings, booleans, nil, float64 numbers
// (JavaScript semantics) and the tagged time.Time, []byte and *big.Int.
func Decode(raw json.RawMessage) (any, error) {
	var value any
	dec := json.NewDecoder(bytes.NewReader(raw))
	if err := dec.Decode(&value); err != nil {
		return nil, err
	}
	return untag(value)
}

func untag(value any) (any, error) {
	switch v := value.(type) {
	case map[string]any:
		if len(v) == 1 {
			for tag, item := range v {
				s, ok := item.(string)
				if !ok {
					break
				}
				switch tag {
				case "$date":
					t, err := time.Parse(time.RFC3339Nano, s)
					if err != nil {
						return nil, err
					}
					return t, nil
				case "$bytes":
					return base64.StdEncoding.DecodeString(s)
				case "$bigint":
					n, ok := new(big.Int).SetString(s, 10)
					if !ok {
						return nil, errors.New("conformance: invalid $bigint " + s)
					}
					return n, nil
				}
			}
		}
		out := make(map[string]any, len(v))
		for k, item := range v {
			decoded, err := untag(item)
			if err != nil {
				return nil, err
			}
			out[k] = decoded
		}
		return out, nil
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			decoded, err := untag(item)
			if err != nil {
				return nil, err
			}
			out[i] = decoded
		}
		return out, nil
	default:
		return value, nil
	}
}
