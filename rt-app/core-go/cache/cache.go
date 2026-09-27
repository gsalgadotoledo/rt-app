// Package cache is TTL cache-aside with stable content keys (port of @gsalgadotoledo/rt-app-cache).
//
// Compose it in main.go like any component:
//
//	c := rtcore.New(func() (*cache.Cache, error) { return cache.New(cache.NewNoSQL(store.Get(), "default")), nil })
//	products, err := c.Get().Remember(ctx, "tenant-1:products", map[string]any{"page": 1}, time.Minute, loadProducts)
//
// Rules shared with TypeScript (see rt-app/docs/polyglot/cache.md):
//   - Values are JSON (decoded JSON or anything encoding/json can marshal), at most 64000 UTF-8
//     bytes of canonical JSON, and are returned as decoded JSON (float64 numbers).
//   - Keys are non-empty and at most 240 UTF-16 units; TTLs are whole milliseconds from 1 ms to
//     30 days. Errors carry the TypeScript messages.
//   - An entry expires when expires <= now (epoch milliseconds from an injectable clock).
//   - Remember loads once per key at a time in this process and never caches a failed load.
package cache

import (
	"context"
	"errors"
	"math"
	"regexp"
	"sync"
	"time"

	"rt.local/core-go/internal/canonical"
	"rt.local/core-go/internal/js"
)

// Limits shared with TypeScript.
const (
	MaxValueBytes = 64000
	MaxKeyLength  = 240
	MaxTTL        = 30 * 24 * time.Hour
)

// Errors with the TypeScript messages (contracts compare them exactly).
var (
	ErrNotJSON      = errors.New("Cache requires finite, acyclic JSON values")
	ErrNotPlain     = errors.New("Cache accepts plain objects only")
	ErrNamespace    = errors.New("Invalid cache namespace")
	ErrInvalidEntry = errors.New("Cache needs a key and TTL between 1 ms and 30 days")
	ErrTooLarge     = errors.New("Cache values are limited to 64 KB")
	ErrCapacity     = errors.New("Invalid cache capacity")
)

// Adapter stores entries. Get reports ok=false on a miss; a cached nil (JSON null) is a hit.
type Adapter interface {
	Get(ctx context.Context, key string) (value any, ok bool, err error)
	Set(ctx context.Context, key string, value any, ttl time.Duration) error
	Delete(ctx context.Context, key string) error
}

// Option configures an adapter.
type Option func(*options)

type options struct{ now func() time.Time }

// WithClock sets the clock used for expiry (default time.Now).
func WithClock(now func() time.Time) Option { return func(o *options) { o.now = now } }

func configure(opts []Option) options {
	o := options{now: time.Now}
	for _, opt := range opts {
		opt(&o)
	}
	return o
}

func fail(kind canonical.Kind) error {
	if kind == canonical.NotPlain {
		return ErrNotPlain
	}
	return ErrNotJSON
}

// Canonical is the canonical JSON of v: keys sorted by UTF-16 code units, JavaScript numbers.
func Canonical(v any) (string, error) { return canonical.Marshal(v, fail) }

var namespacePattern = regexp.MustCompile(`^[a-zA-Z0-9:._-]{1,100}$`)

// ContentKey is namespace + ":" + sha256hex(canonical(input)), e.g. "tenant-1:products:<sha256>".
func ContentKey(namespace string, input any) (string, error) {
	if !namespacePattern.MatchString(namespace) {
		return "", ErrNamespace
	}
	text, err := Canonical(input)
	if err != nil {
		return "", err
	}
	return namespace + ":" + canonical.SHA256Hex(text), nil
}

// ValidateEntry rejects empty or oversized keys (UTF-16 units) and TTLs that are not whole
// milliseconds between 1 ms and 30 days.
func ValidateEntry(key string, ttl time.Duration) error {
	if key == "" || js.Len(key) > MaxKeyLength || ttl < time.Millisecond || ttl > MaxTTL || ttl%time.Millisecond != 0 {
		return ErrInvalidEntry
	}
	return nil
}

// TTLFromMillis converts a loosely typed millisecond count (decoded JSON) to a TTL; anything
// that is not a safe integer number of milliseconds within the limits is ErrInvalidEntry.
func TTLFromMillis(v any) (time.Duration, error) {
	ms, ok := v.(float64)
	if !ok || ms < 1 || ms > float64(MaxTTL/time.Millisecond) || ms != math.Trunc(ms) {
		return 0, ErrInvalidEntry
	}
	return time.Duration(ms) * time.Millisecond, nil
}

// checkedJSON returns the canonical JSON of a value within the 64000-byte limit.
func checkedJSON(value any) (string, error) {
	text, err := Canonical(value)
	if err != nil {
		return "", err
	}
	if len(canonical.UTF8(text)) > MaxValueBytes {
		return "", ErrTooLarge
	}
	return text, nil
}

// Cache is cache-aside over an adapter, with concurrent loader deduplication in this process.
type Cache struct {
	adapter Adapter

	mu      sync.Mutex
	pending map[string]*flight
}

type flight struct {
	done  chan struct{}
	value any
	err   error
}

// New returns a cache over adapter; nil means a MemoryCache of 1000 entries.
func New(adapter Adapter) *Cache {
	if adapter == nil {
		adapter, _ = NewMemory(1000)
	}
	return &Cache{adapter: adapter, pending: map[string]*flight{}}
}

// Adapter returns the storage the cache uses.
func (c *Cache) Adapter() Adapter { return c.adapter }

// Get reads through the adapter; ok=false is a miss, a nil value with ok=true is a cached null.
func (c *Cache) Get(ctx context.Context, key string) (any, bool, error) {
	return c.adapter.Get(ctx, key)
}

// Set writes a JSON value with an explicit TTL.
func (c *Cache) Set(ctx context.Context, key string, value any, ttl time.Duration) error {
	return c.adapter.Set(ctx, key, value, ttl)
}

// Delete invalidates a key; deleting an absent key succeeds.
func (c *Cache) Delete(ctx context.Context, key string) error {
	return c.adapter.Delete(ctx, key)
}

// Remember loads only on a miss, shares in-flight work between goroutines and never keeps a
// failed load. The result is a normalized copy (decoded JSON).
func (c *Cache) Remember(ctx context.Context, namespace string, input any, ttl time.Duration, load func(context.Context) (any, error)) (any, error) {
	key, err := ContentKey(namespace, input)
	if err != nil {
		return nil, err
	}
	if err := ValidateEntry(key, ttl); err != nil {
		return nil, err
	}
	if hit, ok, err := c.adapter.Get(ctx, key); err != nil {
		return nil, err
	} else if ok {
		return hit, nil
	}
	c.mu.Lock()
	f, joined := c.pending[key]
	if !joined {
		f = &flight{done: make(chan struct{})}
		c.pending[key] = f
	}
	c.mu.Unlock()
	if !joined {
		f.value, f.err = c.load(ctx, key, ttl, load)
		c.mu.Lock()
		if c.pending[key] == f {
			delete(c.pending, key)
		}
		c.mu.Unlock()
		close(f.done)
	} else {
		select {
		case <-f.done:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	if f.err != nil {
		return nil, f.err
	}
	return canonical.Clone(f.value, fail)
}

func (c *Cache) load(ctx context.Context, key string, ttl time.Duration, load func(context.Context) (any, error)) (value any, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = errors.Join(errors.New("cache loader panicked"), toError(r))
		}
	}()
	if value, err = load(ctx); err != nil {
		return nil, err
	}
	if err = c.adapter.Set(ctx, key, value, ttl); err != nil {
		return nil, err
	}
	return value, nil
}

func toError(r any) error {
	if err, ok := r.(error); ok {
		return err
	}
	return errors.New("panic")
}
