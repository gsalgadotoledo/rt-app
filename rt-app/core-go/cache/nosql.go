package cache

import (
	"context"
	"math"
	"time"

	"rt.local/core-go/apperr"
	"rt.local/core-go/internal/canonical"
	"rt.local/core-go/nosql"
)

// attempts is how many times Set and Delete try a version-guarded write before a Conflict is
// returned (TypeScript: four attempts in total).
const attempts = 4

// NoSQL is a cache in a NoSQL store (NoSQLCache): rows {pk: "CACHE#" + namespace,
// sk: sha256hex(utf8(key)), version, data: {value, expires}, ttl: ceil(expires / 1000)}.
// Expiry is enforced on reads even when the provider's TTL cleanup is late; reads never delete.
type NoSQL struct {
	store     nosql.Store
	namespace string
	now       func() time.Time
}

// NewNoSQL returns a cache over store; an empty namespace means "default".
func NewNoSQL(store nosql.Store, namespace string, opts ...Option) *NoSQL {
	if namespace == "" {
		namespace = "default"
	}
	return &NoSQL{store: store, namespace: namespace, now: configure(opts).now}
}

// Store returns the underlying store.
func (n *NoSQL) Store() nosql.Store { return n.store }

func (n *NoSQL) address(key string) (string, string) {
	return "CACHE#" + n.namespace, canonical.SHA256Hex(key)
}

// Get returns the stored value while data.expires > now; a row without a value is a miss.
func (n *NoSQL) Get(ctx context.Context, key string) (any, bool, error) {
	pk, sk := n.address(key)
	row, err := n.store.Get(ctx, pk, sk)
	if err != nil || row == nil {
		return nil, false, err
	}
	expires, ok := row.Data["expires"].(float64)
	if !ok || !(expires > float64(n.now().UnixMilli())) {
		return nil, false, nil
	}
	value, ok := row.Data["value"]
	return value, ok, nil
}

// Set stores validated JSON with a version guard, retrying conflicts up to four attempts.
func (n *NoSQL) Set(ctx context.Context, key string, value any, ttl time.Duration) error {
	if err := ValidateEntry(key, ttl); err != nil {
		return err
	}
	text, err := checkedJSON(value)
	if err != nil {
		return err
	}
	expires := n.now().UnixMilli() + ttl.Milliseconds()
	pk, sk := n.address(key)
	ttlSeconds := int64(math.Ceil(float64(expires) / 1000))
	return n.mutate(ctx, pk, sk, func(row *nosql.Row) (*nosql.Write, error) {
		stored, err := canonical.Parse(text)
		if err != nil {
			return nil, err
		}
		write := &nosql.Write{Row: nosql.Row{
			PK:      pk,
			SK:      sk,
			Version: 1,
			Data:    map[string]any{"value": stored, "expires": float64(expires)},
			TTL:     &ttlSeconds,
		}}
		if row != nil {
			write.Row.Version = row.Version + 1
			write.Expected = nosql.Expect(row.Version)
		}
		return write, nil
	})
}

// Delete removes the row with a version check; nothing is written when it is absent.
func (n *NoSQL) Delete(ctx context.Context, key string) error {
	pk, sk := n.address(key)
	return n.mutate(ctx, pk, sk, func(row *nosql.Row) (*nosql.Write, error) {
		if row == nil {
			return nil, nil
		}
		return &nosql.Write{Row: *row, Expected: nosql.Expect(row.Version), Delete: true}, nil
	})
}

// mutate re-reads on conflict; other store errors are returned without retrying.
func (n *NoSQL) mutate(ctx context.Context, pk, sk string, operation func(*nosql.Row) (*nosql.Write, error)) error {
	for attempt := 1; ; attempt++ {
		row, err := n.store.Get(ctx, pk, sk)
		if err != nil {
			return err
		}
		write, err := operation(row)
		if err != nil || write == nil {
			return err
		}
		err = n.store.Transact(ctx, []nosql.Write{*write})
		if err == nil || !apperr.IsConflict(err) || attempt == attempts {
			return err
		}
	}
}
