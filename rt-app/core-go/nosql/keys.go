package nosql

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"

	"rt.local/core-go/apperr"
)

// ErrDuplicateKey is returned when a transaction writes the same key twice. Every store
// checks it before touching the database, so the answer is the same on every engine.
var ErrDuplicateKey = errors.New("Duplicate transaction key")

// CheckKeys returns ErrDuplicateKey when two writes target the same (pk, sk).
func CheckKeys(writes []Write) error {
	seen := make(map[key]bool, len(writes))
	for _, w := range writes {
		k := key{w.Row.PK, w.Row.SK}
		if seen[k] {
			return ErrDuplicateKey
		}
		seen[k] = true
	}
	return nil
}

// cursorKey keeps the field order of the TypeScript cursor: {"pk":…,"sk":…}.
type cursorKey struct {
	PK string `json:"pk"`
	SK string `json:"sk"`
}

// EncodeCursor returns the list cursor after sort key sk of partition pk: base64url (no
// padding) of compact JSON, like JavaScript's
// Buffer.from(JSON.stringify({pk, sk})).toString("base64url"). All stores share this format.
func EncodeCursor(pk, sk string) (string, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(cursorKey{pk, sk}); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(bytes.TrimSuffix(buf.Bytes(), []byte("\n"))), nil
}

// DecodeCursor returns the sort key a cursor continues after. An undecodable cursor, or one
// from another partition, returns 400 "Invalid cursor".
func DecodeCursor(pk, cursor string) (string, error) {
	invalid := apperr.BadRequest("Invalid cursor")
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(cursor, "="))
	if err != nil {
		return "", invalid
	}
	var fields map[string]any
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return "", invalid
	}
	cursorPK, okPK := fields["pk"].(string)
	sk, okSK := fields["sk"].(string)
	if !okPK || !okSK || cursorPK != pk {
		return "", invalid
	}
	return sk, nil
}
