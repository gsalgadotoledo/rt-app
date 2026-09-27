package observer

import (
	"encoding/json"
	"math"
	"strings"

	"rt.local/core-go/internal/canonical"
	"rt.local/core-go/internal/js"
)

// Member is one member of an Object.
type Member struct {
	Key   string
	Value any
}

// Object is a JSON object written in this member order (JavaScript insertion order), unlike maps.
type Object []Member

// eventKeys is the key order of events built by the Observer.
var eventKeys = []string{"category", "id", "at", "level", "kind", "source", "message", "data", "requestId", "sessionId"}

// Stringify is JSON.stringify(value, null, indent) (compact when indent is 0): JavaScript numbers
// (1e-7, 1e+21, integers without a fraction), only '"', '\' and control characters escaped (never
// "<>&" or U+2028 like encoding/json), "{}" and "[]" for empty containers. Event values keep the
// event key order; map keys follow JavaScript property order (array-index keys first, then UTF-16
// order, since Go maps have no insertion order).
func Stringify(value any, indent int) string {
	var b strings.Builder
	writeJSON(&b, value, indent, "")
	return b.String()
}

// stringifyEvent writes a stored event with the known event keys first, in event order.
func stringifyEvent(event map[string]any) string {
	var b strings.Builder
	var keys []string
	for _, key := range eventKeys {
		if _, ok := event[key]; ok {
			keys = append(keys, key)
		}
	}
	for _, key := range OrderedKeys(event) {
		if !isEventKey(key) {
			keys = append(keys, key)
		}
	}
	writeObject(&b, keys, func(k string) any { return event[k] }, 0, "")
	return b.String()
}

func isEventKey(key string) bool {
	for _, k := range eventKeys {
		if k == key {
			return true
		}
	}
	return false
}

func writeJSON(b *strings.Builder, value any, indent int, prefix string) {
	switch v := value.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		if v {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case string:
		b.WriteString(canonical.Quote(v))
	case float64:
		writeNumber(b, v)
	case int:
		writeNumber(b, float64(v))
	case int64:
		writeNumber(b, float64(v))
	case Event:
		m := v.Map()
		var keys []string
		for _, key := range eventKeys {
			if _, ok := m[key]; ok {
				keys = append(keys, key)
			}
		}
		writeObject(b, keys, func(k string) any { return m[k] }, indent, prefix)
	case map[string]any:
		writeObject(b, OrderedKeys(v), func(k string) any { return v[k] }, indent, prefix)
	case Object:
		keys := make([]string, len(v))
		values := make(map[string]any, len(v))
		for i, member := range v {
			keys[i] = member.Key
			values[member.Key] = member.Value
		}
		writeObject(b, keys, func(k string) any { return values[k] }, indent, prefix)
	case []any:
		if len(v) == 0 {
			b.WriteString("[]")
			return
		}
		inner := prefix + strings.Repeat(" ", indent)
		b.WriteByte('[')
		for i, item := range v {
			if i > 0 {
				b.WriteByte(',')
			}
			if indent > 0 {
				b.WriteString("\n" + inner)
			}
			writeJSON(b, item, indent, inner)
		}
		if indent > 0 {
			b.WriteString("\n" + prefix)
		}
		b.WriteByte(']')
	default:
		raw, err := json.Marshal(value)
		var decoded any
		if err != nil || json.Unmarshal(raw, &decoded) != nil {
			b.WriteString("null")
			return
		}
		writeJSON(b, decoded, indent, prefix)
	}
}

func writeNumber(b *strings.Builder, f float64) {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		b.WriteString("null")
		return
	}
	b.WriteString(js.FormatNumber(f))
}

func writeObject(b *strings.Builder, keys []string, get func(string) any, indent int, prefix string) {
	if len(keys) == 0 {
		b.WriteString("{}")
		return
	}
	inner := prefix + strings.Repeat(" ", indent)
	b.WriteByte('{')
	for i, key := range keys {
		if i > 0 {
			b.WriteByte(',')
		}
		if indent > 0 {
			b.WriteString("\n" + inner)
		}
		b.WriteString(canonical.Quote(key))
		if indent > 0 {
			b.WriteString(": ")
		} else {
			b.WriteByte(':')
		}
		writeJSON(b, get(key), indent, inner)
	}
	if indent > 0 {
		b.WriteString("\n" + prefix)
	}
	b.WriteByte('}')
}
