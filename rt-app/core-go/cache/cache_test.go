package cache

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"rt.local/core-go/apperr"
	"rt.local/core-go/nosql"
	"rt.local/core-go/nosql/jsonstore"
)

const base = 4102444800000

type testClock struct{ ms atomic.Int64 }

func newTestClock() *testClock      { c := &testClock{}; c.ms.Store(base); return c }
func (c *testClock) now() time.Time { return time.UnixMilli(c.ms.Load()) }

func TestCanonicalMatchesJSONStringify(t *testing.T) {
	cases := []struct {
		in   any
		want string
	}{
		{[]any{nil, false, 12.0, map[string]any{"z": 1.0, "a": "x"}}, `[null,false,12,{"a":"x","z":1}]`},
		{map[string]any{"！": 1.0, "😀": 2.0, "a": 3.0}, `{"a":3,"😀":2,"！":1}`},
		{"\u2028\u007f\n\u0001<>&", "\"\u2028\u007f\\n\\u0001<>&\""},
		{[]any{1e21, 1e-7, math.Copysign(0, -1), 12345678901234567890.0, 9007199254740993.0}, `[1e+21,1e-7,0,12345678901234567000,9007199254740992]`},
		{struct {
			B int    `json:"b"`
			A string `json:"a"`
		}{1, "x"}, `{"a":"x","b":1}`},
	}
	for _, c := range cases {
		got, err := Canonical(c.in)
		if err != nil || got != c.want {
			t.Errorf("Canonical(%#v) = %q, %v; want %q", c.in, got, err, c.want)
		}
	}
	cyclic := map[string]any{}
	cyclic["self"] = cyclic
	for _, bad := range []any{math.NaN(), math.Inf(1), cyclic} {
		if _, err := Canonical(bad); !errors.Is(err, ErrNotJSON) {
			t.Errorf("Canonical(%v) error = %v", bad, err)
		}
	}
	if _, err := Canonical(make(chan int)); !errors.Is(err, ErrNotPlain) {
		t.Errorf("channel error = %v", err)
	}
}

func TestContentKeyAndValidation(t *testing.T) {
	key, err := ContentKey("tenant-1:products", map[string]any{"page": 1.0})
	if err != nil || key != "tenant-1:products:70fb0185588d2e765454a7927f2792ae2b6faa2516781deb69864246e0803d05" {
		t.Fatal(key, err)
	}
	for _, ns := range []string{"", "a b", "a\n", "é"} {
		if _, err := ContentKey(ns, 1.0); !errors.Is(err, ErrNamespace) {
			t.Errorf("namespace %q: %v", ns, err)
		}
	}
	for _, ms := range []any{0.0, -1.0, 1.5, 2592000001.0, "100", true, nil} {
		if _, err := TTLFromMillis(ms); !errors.Is(err, ErrInvalidEntry) {
			t.Errorf("ttl %v: %v", ms, err)
		}
	}
	if err := ValidateEntry(string(make([]rune, 121)), time.Second); err != nil {
		t.Error(err) // 121 NUL runes are 121 UTF-16 units
	}
	emoji := ""
	for range 121 {
		emoji += "😀"
	}
	if err := ValidateEntry(emoji, time.Second); !errors.Is(err, ErrInvalidEntry) {
		t.Error("242 UTF-16 units must be rejected")
	}
}

func TestMemoryLRUAndExpiry(t *testing.T) {
	ctx := context.Background()
	clock := newTestClock()
	m, err := NewMemory(2, WithClock(clock.now))
	if err != nil {
		t.Fatal(err)
	}
	must(t, m.Set(ctx, "a", map[string]any{"v": 1.0}, 10*time.Millisecond))
	must(t, m.Set(ctx, "b", nil, 10*time.Millisecond))
	if v, ok, _ := m.Get(ctx, "b"); !ok || v != nil {
		t.Fatal("a cached null is a hit")
	}
	copyOf, _, _ := m.Get(ctx, "a")
	copyOf.(map[string]any)["v"] = 5.0
	must(t, m.Set(ctx, "c", false, 10*time.Millisecond))
	if _, ok, _ := m.Get(ctx, "b"); ok {
		t.Fatal("b should be evicted")
	}
	if v, _, _ := m.Get(ctx, "a"); v.(map[string]any)["v"] != 1.0 {
		t.Fatal("values are copied")
	}
	clock.ms.Add(10)
	if _, ok, _ := m.Get(ctx, "a"); ok {
		t.Fatal("expired")
	}
	if _, err := NewMemory(0); !errors.Is(err, ErrCapacity) {
		t.Fatal(err)
	}
	if _, err := CapacityFrom("2"); !errors.Is(err, ErrCapacity) {
		t.Fatal(err)
	}
	if err := m.Set(ctx, "big", string(make([]byte, 64000)), time.Second); !errors.Is(err, ErrTooLarge) {
		t.Fatal("NUL bytes are escaped as six bytes each", err)
	}
}

func TestRememberDeduplicatesAndForgetsFailures(t *testing.T) {
	ctx := context.Background()
	c := New(nil)
	var calls atomic.Int32
	slow := func(context.Context) (any, error) {
		calls.Add(1)
		time.Sleep(50 * time.Millisecond)
		return map[string]any{"a": 1.0}, nil
	}
	var wg sync.WaitGroup
	for range 5 {
		wg.Go(func() {
			if v, err := c.Remember(ctx, "ns", 1.0, time.Second, slow); err != nil || v.(map[string]any)["a"] != 1.0 {
				t.Error(v, err)
			}
		})
	}
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatalf("calls = %d", calls.Load())
	}
	boom := errors.New("load failed")
	if _, err := c.Remember(ctx, "ns", 2.0, time.Second, func(context.Context) (any, error) { return nil, boom }); !errors.Is(err, boom) {
		t.Fatal(err)
	}
	v, err := c.Remember(ctx, "ns", 2.0, time.Second, func(context.Context) (any, error) { return nil, nil })
	if err != nil || v != nil {
		t.Fatal(v, err)
	}
	v, _ = c.Remember(ctx, "ns", 2.0, time.Second, func(context.Context) (any, error) { return "reloaded", nil })
	if v != nil {
		t.Fatal("a cached null is a hit")
	}
}

type flakyStore struct {
	*nosql.MemoryStore
	conflicts, attempts int
}

func (f *flakyStore) Transact(ctx context.Context, writes []nosql.Write) error {
	f.attempts++
	if f.conflicts > 0 {
		f.conflicts--
		return apperr.Conflict()
	}
	return f.MemoryStore.Transact(ctx, writes)
}

func TestNoSQLRowsAndRetries(t *testing.T) {
	ctx := context.Background()
	clock := newTestClock()
	store := nosql.NewMemoryStore()
	c := NewNoSQL(store, "t", WithClock(clock.now))
	must(t, c.Set(ctx, "k", map[string]any{"b": 1.0}, 1500*time.Millisecond))
	row, _ := store.Get(ctx, "CACHE#t", "8254c329a92850f6d539dd376f4816ee2764517da5e0235514af433164480d7a")
	if row == nil || row.Version != 1 || *row.TTL != 4102444802 || row.Data["expires"] != float64(base+1500) {
		t.Fatalf("row = %+v", row)
	}
	clock.ms.Add(1500)
	if _, ok, _ := c.Get(ctx, "k"); ok {
		t.Fatal("expired")
	}
	clock.ms.Add(-1)
	if _, ok, _ := c.Get(ctx, "k"); !ok {
		t.Fatal("reads never delete")
	}
	flaky := &flakyStore{MemoryStore: nosql.NewMemoryStore(), conflicts: 3}
	must(t, NewNoSQL(flaky, "").Set(ctx, "k", 1.0, time.Second))
	flaky.conflicts, flaky.attempts = 4, 0
	if err := NewNoSQL(flaky, "").Set(ctx, "k", 2.0, time.Second); !apperr.IsConflict(err) || flaky.attempts != 4 {
		t.Fatal(err, flaky.attempts)
	}
}

func TestFileSharedAndPurged(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "nested", "cache.json")
	clock := newTestClock()
	must(t, NewFile(path, "", WithClock(clock.now)).Set(ctx, "k", false, time.Minute))
	if v, ok, err := NewFile(path, "", WithClock(clock.now)).Get(ctx, "k"); !ok || v != false || err != nil {
		t.Fatal(v, ok, err)
	}
	clock.ms.Store(1000)
	must(t, NewFile(path, "", WithClock(clock.now)).Set(ctx, "old", 1.0, time.Second))
	var document struct {
		Format int               `json:"format"`
		Rows   []json.RawMessage `json:"rows"`
	}
	raw, _ := os.ReadFile(path)
	if err := json.Unmarshal(raw, &document); err != nil || document.Format != 1 || len(document.Rows) != 1 {
		t.Fatalf("file = %s", raw)
	}
	if err := os.WriteFile(path, []byte(`{"format":2,"rows":[]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewFileStore(path).Get(ctx, "a", "b"); err == nil || err.Error() != "Invalid JSON database" {
		t.Fatal(err)
	}
	store := jsonstore.New(path, jsonstore.WithLockTimeout(50*time.Millisecond))
	if err := os.WriteFile(path+".lock", nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Get(ctx, "a", "b"); err == nil {
		t.Fatal("a held lock must time out")
	}
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
