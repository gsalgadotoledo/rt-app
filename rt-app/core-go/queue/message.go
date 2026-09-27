package queue

import (
	"encoding/json"
	"errors"
	"maps"
	"math"
	"regexp"
	"strconv"
	"strings"

	"rt.local/core-go/internal/canonical"
	"rt.local/core-go/internal/js"
)

// Message limits shared with TypeScript (UTF-16 units for strings, UTF-8 bytes for the message).
const (
	MaxIDLength      = 200
	MaxTypeLength    = 120
	MaxTraceIDLength = 200
	MaxMessageBytes  = 240000
)

// Validation errors with the TypeScript messages (contracts compare them exactly).
var (
	ErrInvalidMessage = errors.New("Invalid queue message")
	ErrTooLarge       = errors.New("Queue message exceeds 240 KB")
	ErrNotJSON        = errors.New("Cache requires finite, acyclic JSON values")
	ErrNotPlain       = errors.New("Cache accepts plain objects only")
)

// Message is the JSON envelope every transport carries. Payload holds decoded JSON (float64
// numbers); Extra keeps unknown envelope fields, as the TypeScript validation does.
type Message struct {
	ID        string
	Type      string
	Payload   any
	CreatedAt string
	TraceID   *string // nil: absent; the empty string is a valid trace id
	Extra     map[string]any

	noPayload bool // parsed from an envelope without a payload field
}

// object is the message as a JSON object; known fields win over Extra.
func (m Message) object() map[string]any {
	out := maps.Clone(m.Extra)
	if out == nil {
		out = map[string]any{}
	}
	out["id"], out["type"], out["createdAt"] = m.ID, m.Type, m.CreatedAt
	if m.noPayload {
		delete(out, "payload")
	} else {
		out["payload"] = m.Payload
	}
	if m.TraceID != nil {
		out["traceId"] = *m.TraceID
	} else {
		delete(out, "traceId")
	}
	return out
}

// MarshalJSON writes the envelope with its extra fields.
func (m Message) MarshalJSON() ([]byte, error) { return json.Marshal(m.object()) }

// UnmarshalJSON reads an envelope with MessageFrom's rules (validation included).
func (m *Message) UnmarshalJSON(data []byte) error {
	var v any
	if err := json.Unmarshal(data, &v); err != nil {
		return err
	}
	parsed, err := MessageFrom(v)
	if err != nil {
		return err
	}
	*m = parsed
	return nil
}

func fail(kind canonical.Kind) error {
	if kind == canonical.NotPlain {
		return ErrNotPlain
	}
	return ErrNotJSON
}

func text(v any, limit int) bool {
	s, ok := v.(string)
	return ok && js.Trim(s) != "" && js.Len(s) <= limit
}

// MessageFrom validates a decoded JSON envelope with the TypeScript rules and returns the
// normalized message: an object; id and type non-blank strings of at most 200 and 120 UTF-16
// units; createdAt a string ParseDate accepts; traceId absent or a string of at most 200 units
// (null is invalid). Then the canonical JSON must fit MaxMessageBytes.
func MessageFrom(v any) (Message, error) {
	object, ok := v.(map[string]any)
	if !ok || !text(object["id"], MaxIDLength) || !text(object["type"], MaxTypeLength) {
		return Message{}, ErrInvalidMessage
	}
	created, ok := object["createdAt"].(string)
	if !ok {
		return Message{}, ErrInvalidMessage
	}
	if _, ok := ParseDate(created); !ok {
		return Message{}, ErrInvalidMessage
	}
	if trace, present := object["traceId"]; present {
		if s, ok := trace.(string); !ok || js.Len(s) > MaxTraceIDLength {
			return Message{}, ErrInvalidMessage
		}
	}
	return normalize(object)
}

// Validate checks a typed message with the same rules and returns its normalized copy.
func (m Message) Validate() (Message, error) {
	if !text(m.ID, MaxIDLength) || !text(m.Type, MaxTypeLength) || (m.TraceID != nil && js.Len(*m.TraceID) > MaxTraceIDLength) {
		return Message{}, ErrInvalidMessage
	}
	if _, ok := ParseDate(m.CreatedAt); !ok {
		return Message{}, ErrInvalidMessage
	}
	return normalize(m.object())
}

// normalize is JSON.parse(canonical(object)) with the size limit.
func normalize(object map[string]any) (Message, error) {
	serialized, err := canonical.Marshal(object, fail)
	if err != nil {
		return Message{}, err
	}
	if len(canonical.UTF8(serialized)) > MaxMessageBytes {
		return Message{}, ErrTooLarge
	}
	parsed, err := canonical.Parse(serialized)
	if err != nil {
		return Message{}, err
	}
	return fromObject(parsed.(map[string]any)), nil
}

// fromObject splits a validated object into the typed fields and Extra.
func fromObject(object map[string]any) Message {
	m := Message{Extra: map[string]any{}}
	for k, v := range object {
		switch k {
		case "id":
			m.ID, _ = v.(string)
		case "type":
			m.Type, _ = v.(string)
		case "createdAt":
			m.CreatedAt, _ = v.(string)
		case "payload":
			m.Payload = v
		case "traceId":
			s, _ := v.(string)
			m.TraceID = &s
		default:
			m.Extra[k] = v
		}
	}
	_, hasPayload := object["payload"]
	m.noPayload = !hasPayload
	if len(m.Extra) == 0 {
		m.Extra = nil
	}
	return m
}

// clone deep-copies a normalized message (structuredClone).
func (m Message) clone() Message {
	copied, err := canonical.Clone(m.object(), fail)
	if err != nil { // a normalized message is always canonical JSON
		panic(err)
	}
	return fromObject(copied.(map[string]any))
}

var datePattern = regexp.MustCompile(`^([+-]\d{6}|\d{4})(?:-(\d{2})(?:-(\d{2}))?)?(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?([Zz]|[+-]\d{2}:?\d{2})?$`)

// maxTime is the largest Date value in milliseconds (±8.64e15).
const maxTime = 8_640_000_000_000_000

// ParseDate is Date.parse for the ECMAScript date-time format, in epoch milliseconds; ok is
// false where Date.parse returns NaN. It accepts YYYY[-MM[-DD]] or ±YYYYYY (not -000000), an
// optional [Tt ]HH:mm[:ss[.fraction]] (24:00:00 only as midnight) and an optional Z or ±HH[:]mm
// offset, with V8's day rollover (2026-02-30 is March 2). Times without an offset are read as
// UTC (V8 reads local time; only the ±8.64e15 ms range check can tell). V8's legacy formats
// ("Jan 2 2026", "2026/01/02"…) are not accepted.
func ParseDate(s string) (int64, bool) {
	m := datePattern.FindStringSubmatch(s)
	if m == nil || m[1] == "-000000" {
		return 0, false
	}
	num := func(s string, fallback int64) int64 {
		if s == "" {
			return fallback
		}
		n, _ := strconv.ParseInt(s, 10, 64)
		return n
	}
	year, month, day := num(m[1], 0), num(m[2], 1), num(m[3], 1)
	hour, minute, second := num(m[4], 0), num(m[5], 0), num(m[6], 0)
	frac := m[7]
	if len(frac) > 3 {
		frac = frac[:3]
	}
	ms := num(frac+strings.Repeat("0", 3-len(frac)), 0)
	if month < 1 || month > 12 || day < 1 || day > 31 || minute > 59 || second > 59 || hour > 24 {
		return 0, false
	}
	if hour == 24 && (minute != 0 || second != 0 || ms != 0) {
		return 0, false
	}
	var offset int64
	if zone := m[8]; zone != "" && zone != "Z" && zone != "z" {
		digits := strings.ReplaceAll(zone[1:], ":", "")
		zh, zm := num(digits[:2], 0), num(digits[2:], 0)
		if zh > 23 || zm > 59 {
			return 0, false
		}
		offset = zh*60 + zm
		if zone[0] == '-' {
			offset = -offset
		}
	}
	days := daysFromCivil(year, month) + day - 1
	value := ((days*24+hour)*60+minute-offset)*60000 + second*1000 + ms
	if value > maxTime || value < -maxTime {
		return 0, false
	}
	return value, true
}

// daysFromCivil counts days from 1970-01-01 to the first day of the month (proleptic Gregorian).
func daysFromCivil(year, month int64) int64 {
	y := year
	if month <= 2 {
		y--
	}
	era := int64(math.Floor(float64(y) / 400))
	yoe := y - era*400
	mp := (month + 9) % 12
	doy := (153*mp + 2) / 5
	doe := yoe*365 + yoe/4 - yoe/100 + doy
	return era*146097 + doe - 719468
}
