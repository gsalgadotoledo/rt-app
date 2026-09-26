// Package nosql defines the partitioned key-value store used by RT-App modules and an
// in-memory implementation for tests and local development.
//
// Rows live in partitions (PK) ordered by sort key (SK). Writes are version-guarded and
// applied atomically in transactions, the capabilities DynamoDB and Postgres both provide.
package nosql

import (
	"context"
	"encoding/json"
)

// Row is one stored item. Data holds JSON values (numbers decode as float64, like JavaScript).
type Row struct {
	PK      string         `json:"pk"`
	SK      string         `json:"sk"`
	Version int            `json:"version"`
	Data    map[string]any `json:"data"`
	TTL     *int64         `json:"ttl,omitempty"`
}

// Write is one element of a transaction. Expected nil means "the row must not exist";
// otherwise the stored row must have exactly that version. Delete removes the row.
type Write struct {
	Row      Row  `json:"row"`
	Expected *int `json:"expected"`
	Delete   bool `json:"delete,omitempty"`
}

// Page is one page of a partition. Cursor is empty on the last page.
type Page struct {
	Items  []Row  `json:"items"`
	Cursor string `json:"cursor,omitempty"`
}

// Store is the storage contract modules depend on.
//
// Get returns (nil, nil) for missing rows. Transact returns apperr.Conflict() when a guard
// fails and commits nothing in that case. List returns rows of one partition in Unicode
// code point order of SK; cursors are opaque and bound to their partition.
type Store interface {
	Get(ctx context.Context, pk, sk string) (*Row, error)
	Transact(ctx context.Context, writes []Write) error
	List(ctx context.Context, pk, cursor string) (Page, error)
}

// Expect returns a pointer to version, for Write.Expected.
func Expect(version int) *int { return &version }

// clone deep-copies a row through JSON, the same normalization every store applies.
func clone(row Row) (Row, error) {
	raw, err := json.Marshal(row)
	if err != nil {
		return Row{}, err
	}
	var out Row
	if err := json.Unmarshal(raw, &out); err != nil {
		return Row{}, err
	}
	return out, nil
}
