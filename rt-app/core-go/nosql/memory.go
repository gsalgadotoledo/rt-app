package nosql

import (
	"context"
	"slices"
	"strings"
	"sync"

	"rt.local/core-go/apperr"
)

// PageSize is the number of rows MemoryStore.List returns per page.
const PageSize = 50

type key struct{ pk, sk string }

// MemoryStore is a Store kept in process memory. It is for tests and local development
// only: it is not durable and not shared between processes. It is safe for concurrent use.
type MemoryStore struct {
	mu   sync.RWMutex
	rows map[key]Row
}

// NewMemoryStore returns an empty store.
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{rows: map[key]Row{}}
}

// Get returns a copy of the row, or (nil, nil) when it does not exist.
func (m *MemoryStore) Get(_ context.Context, pk, sk string) (*Row, error) {
	m.mu.RLock()
	row, ok := m.rows[key{pk, sk}]
	m.mu.RUnlock()
	if !ok {
		return nil, nil
	}
	out, err := clone(row)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// Transact applies all writes or none. Writes are checked in order: a repeated key returns
// ErrDuplicateKey and a failed version guard returns apperr.Conflict().
func (m *MemoryStore) Transact(_ context.Context, writes []Write) error {
	copies := make([]Row, len(writes))
	for i, w := range writes {
		if w.Delete {
			continue
		}
		row, err := clone(w.Row)
		if err != nil {
			return err
		}
		copies[i] = row
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := CheckKeys(writes); err != nil {
		return err
	}
	for _, w := range writes {
		k := key{w.Row.PK, w.Row.SK}
		old, exists := m.rows[k]
		if w.Expected == nil && exists || w.Expected != nil && (!exists || old.Version != *w.Expected) {
			return apperr.Conflict()
		}
	}
	for i, w := range writes {
		k := key{w.Row.PK, w.Row.SK}
		if w.Delete {
			delete(m.rows, k)
		} else {
			m.rows[k] = copies[i]
		}
	}
	return nil
}

// List returns up to PageSize rows of partition pk after the cursor, ordered by SK in
// Unicode code point order (Go compares UTF-8 bytes, which is the same order).
// An undecodable cursor, or one from another partition, returns 400 "Invalid cursor".
func (m *MemoryStore) List(_ context.Context, pk, cursor string) (Page, error) {
	after := ""
	if cursor != "" {
		sk, err := DecodeCursor(pk, cursor)
		if err != nil {
			return Page{}, err
		}
		after = sk
	}
	m.mu.RLock()
	var all []Row
	for k, row := range m.rows {
		if k.pk == pk && k.sk > after {
			all = append(all, row)
		}
	}
	m.mu.RUnlock()
	slices.SortFunc(all, func(a, b Row) int { return strings.Compare(a.SK, b.SK) })
	page := Page{Items: make([]Row, 0, min(len(all), PageSize))}
	for _, row := range all[:min(len(all), PageSize)] {
		out, err := clone(row)
		if err != nil {
			return Page{}, err
		}
		page.Items = append(page.Items, out)
	}
	if len(all) > PageSize {
		next, err := EncodeCursor(pk, page.Items[PageSize-1].SK)
		if err != nil {
			return Page{}, err
		}
		page.Cursor = next
	}
	return page, nil
}
