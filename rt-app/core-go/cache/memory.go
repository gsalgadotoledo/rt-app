package cache

import (
	"container/list"
	"context"
	"sync"
	"time"

	"rt.local/core-go/internal/canonical"
	"rt.local/core-go/internal/js"
)

// Memory is a bounded process-local LRU (MemoryCache). Values are stored as normalized copies.
// It is safe for concurrent use.
type Memory struct {
	max int
	now func() time.Time

	mu      sync.Mutex
	order   *list.List // front = least recently used
	entries map[string]*list.Element
}

type memoryEntry struct {
	key     string
	value   any
	expires int64 // epoch milliseconds
}

// NewMemory returns an LRU of at most maxEntries entries (a positive safe integer).
func NewMemory(maxEntries int, opts ...Option) (*Memory, error) {
	if maxEntries < 1 || maxEntries > 1<<53-1 {
		return nil, ErrCapacity
	}
	return &Memory{max: maxEntries, now: configure(opts).now, order: list.New(), entries: map[string]*list.Element{}}, nil
}

// CapacityFrom checks a loosely typed capacity (decoded JSON; nil means the default 1000).
func CapacityFrom(v any) (int, error) {
	if v == nil {
		return 1000, nil
	}
	f, ok := js.Integer(v)
	if !ok || f < 1 || f > 1<<53-1 {
		return 0, ErrCapacity
	}
	return int(f), nil
}

func (m *Memory) millis() int64 { return m.now().UnixMilli() }

// Get returns a copy of a live entry and makes it the most recent; expired entries are dropped.
func (m *Memory) Get(_ context.Context, key string) (any, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	element, ok := m.entries[key]
	if !ok {
		return nil, false, nil
	}
	entry := element.Value.(*memoryEntry)
	if entry.expires <= m.millis() {
		m.order.Remove(element)
		delete(m.entries, key)
		return nil, false, nil
	}
	m.order.MoveToBack(element)
	value, err := canonical.Clone(entry.value, fail)
	return value, err == nil, err
}

// Set stores a copy, drops expired entries, then evicts the least recently used beyond capacity.
func (m *Memory) Set(_ context.Context, key string, value any, ttl time.Duration) error {
	if err := ValidateEntry(key, ttl); err != nil {
		return err
	}
	text, err := checkedJSON(value)
	if err != nil {
		return err
	}
	stored, err := canonical.Parse(text)
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	now := m.millis()
	for element := m.order.Front(); element != nil; {
		next := element.Next()
		if entry := element.Value.(*memoryEntry); entry.expires <= now {
			m.order.Remove(element)
			delete(m.entries, entry.key)
		}
		element = next
	}
	if element, ok := m.entries[key]; ok {
		m.order.Remove(element)
	}
	m.entries[key] = m.order.PushBack(&memoryEntry{key: key, value: stored, expires: m.millis() + ttl.Milliseconds()})
	for m.order.Len() > m.max {
		oldest := m.order.Front()
		m.order.Remove(oldest)
		delete(m.entries, oldest.Value.(*memoryEntry).key)
	}
	return nil
}

// Delete removes a key; deleting an absent key succeeds.
func (m *Memory) Delete(_ context.Context, key string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if element, ok := m.entries[key]; ok {
		m.order.Remove(element)
		delete(m.entries, key)
	}
	return nil
}
