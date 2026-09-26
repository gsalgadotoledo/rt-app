// Package nosqltest is a behavior suite every nosql.Store implementation must pass (the Go
// side of spec/contracts/nosql.contract.yaml, plus concurrency). Use it from a store's tests:
//
//	nosqltest.Run(t, func(t *testing.T) nosql.Store { return newIsolatedStore(t) })
package nosqltest

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"sync"
	"testing"

	"rt.local/core-go/apperr"
	"rt.local/core-go/nosql"
)

// Run runs every case against a fresh, empty store from open.
func Run(t *testing.T, open func(t *testing.T) nosql.Store) {
	cases := []struct {
		name string
		run  func(t *testing.T, ctx context.Context, s nosql.Store)
	}{
		{"missing rows read as nil", missing},
		{"create then read", createRead},
		{"version guards", guards},
		{"transactions are all or nothing", atomic},
		{"a repeated key is rejected", duplicate},
		{"delete needs the current version", deleteGuard},
		{"list orders by code point", order},
		{"pages hold 50 rows", pages},
		{"cursors are bound to their partition", cursors},
		{"concurrent creates: exactly one wins", concurrent},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			c.run(t, t.Context(), open(t))
		})
	}
}

func create(t *testing.T, ctx context.Context, s nosql.Store, rows ...nosql.Row) {
	t.Helper()
	writes := make([]nosql.Write, len(rows))
	for i, row := range rows {
		if row.Data == nil {
			row.Data = map[string]any{}
		}
		writes[i] = nosql.Write{Row: row}
	}
	if err := s.Transact(ctx, writes); err != nil {
		t.Fatal(err)
	}
}

func isConflict(t *testing.T, err error) {
	t.Helper()
	if e, ok := apperr.As(err); !ok || e.Status != 409 || e.Message != apperr.ConflictMessage {
		t.Fatalf("want a 409 conflict, got %v", err)
	}
}

func missing(t *testing.T, ctx context.Context, s nosql.Store) {
	if row, err := s.Get(ctx, "USERS", "alice"); row != nil || err != nil {
		t.Fatalf("got %v, %v", row, err)
	}
	if err := s.Transact(ctx, nil); err != nil {
		t.Fatalf("an empty transaction is a no-op: %v", err)
	}
}

func createRead(t *testing.T, ctx context.Context, s nosql.Store) {
	ttl := int64(1893456000)
	data := map[string]any{"name": "Alice", "tags": []any{"a", "b"}, "nested": map[string]any{"n": 1.5}, "empty": "", "none": nil, "ok": true}
	create(t, ctx, s, nosql.Row{PK: "USERS", SK: "alice", Version: 1, Data: data, TTL: &ttl})
	row, err := s.Get(ctx, "USERS", "alice")
	if err != nil {
		t.Fatal(err)
	}
	want := nosql.Row{PK: "USERS", SK: "alice", Version: 1, Data: data, TTL: &ttl}
	if !reflect.DeepEqual(*row, want) {
		t.Fatalf("got %#v\nwant %#v", *row, want)
	}
}

func guards(t *testing.T, ctx context.Context, s nosql.Store) {
	create(t, ctx, s, nosql.Row{PK: "A", SK: "x", Version: 1})
	isConflict(t, s.Transact(ctx, []nosql.Write{{Row: nosql.Row{PK: "A", SK: "x", Version: 1, Data: map[string]any{}}}}))
	isConflict(t, s.Transact(ctx, []nosql.Write{{Row: nosql.Row{PK: "A", SK: "x", Version: 3, Data: map[string]any{}}, Expected: nosql.Expect(2)}}))
	isConflict(t, s.Transact(ctx, []nosql.Write{{Row: nosql.Row{PK: "A", SK: "y", Version: 2, Data: map[string]any{}}, Expected: nosql.Expect(1)}}))
	if err := s.Transact(ctx, []nosql.Write{{Row: nosql.Row{PK: "A", SK: "x", Version: 2, Data: map[string]any{"n": 2.0}}, Expected: nosql.Expect(1)}}); err != nil {
		t.Fatal(err)
	}
	if row, _ := s.Get(ctx, "A", "x"); row == nil || row.Version != 2 || row.Data["n"] != 2.0 {
		t.Fatalf("got %v", row)
	}
}

func atomic(t *testing.T, ctx context.Context, s nosql.Store) {
	create(t, ctx, s, nosql.Row{PK: "A", SK: "taken", Version: 1})
	isConflict(t, s.Transact(ctx, []nosql.Write{
		{Row: nosql.Row{PK: "A", SK: "new", Version: 1, Data: map[string]any{}}},
		{Row: nosql.Row{PK: "A", SK: "taken", Version: 1, Data: map[string]any{}}},
	}))
	if row, err := s.Get(ctx, "A", "new"); row != nil || err != nil {
		t.Fatalf("the first write committed: %v %v", row, err)
	}
}

func duplicate(t *testing.T, ctx context.Context, s nosql.Store) {
	w := nosql.Write{Row: nosql.Row{PK: "A", SK: "x", Version: 1, Data: map[string]any{}}}
	if err := s.Transact(ctx, []nosql.Write{w, w}); !errors.Is(err, nosql.ErrDuplicateKey) || err.Error() != "Duplicate transaction key" {
		t.Fatalf("got %v", err)
	}
	if row, _ := s.Get(ctx, "A", "x"); row != nil {
		t.Fatal("a rejected transaction wrote")
	}
}

func deleteGuard(t *testing.T, ctx context.Context, s nosql.Store) {
	create(t, ctx, s, nosql.Row{PK: "A", SK: "x", Version: 4})
	isConflict(t, s.Transact(ctx, []nosql.Write{{Row: nosql.Row{PK: "A", SK: "x"}, Expected: nosql.Expect(3), Delete: true}}))
	if err := s.Transact(ctx, []nosql.Write{{Row: nosql.Row{PK: "A", SK: "x"}, Expected: nosql.Expect(4), Delete: true}}); err != nil {
		t.Fatal(err)
	}
	if row, _ := s.Get(ctx, "A", "x"); row != nil {
		t.Fatal("not deleted")
	}
}

func order(t *testing.T, ctx context.Context, s nosql.Store) {
	create(t, ctx, s,
		nosql.Row{PK: "P", SK: "😀", Version: 1}, nosql.Row{PK: "P", SK: "�", Version: 1},
		nosql.Row{PK: "P", SK: "é", Version: 1}, nosql.Row{PK: "P", SK: "z", Version: 1},
		nosql.Row{PK: "P", SK: "B", Version: 1}, nosql.Row{PK: "P", SK: "aa", Version: 1},
		nosql.Row{PK: "P", SK: "a", Version: 1}, nosql.Row{PK: "Q", SK: "a", Version: 1})
	page, err := s.List(ctx, "P", "")
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, row := range page.Items {
		got = append(got, row.SK)
	}
	if want := []string{"B", "a", "aa", "z", "é", "�", "😀"}; !reflect.DeepEqual(got, want) || page.Cursor != "" {
		t.Fatalf("got %q (cursor %q), want %q", got, page.Cursor, want)
	}
	if empty, err := s.List(ctx, "NOTHING", ""); err != nil || empty.Items == nil || len(empty.Items) != 0 || empty.Cursor != "" {
		t.Fatalf("empty partition = %#v, %v", empty, err)
	}
}

func rows(pk string, n int) []nosql.Row {
	out := make([]nosql.Row, n)
	for i := range out {
		out[i] = nosql.Row{PK: pk, SK: fmt.Sprintf("row-%03d", i), Version: 1, Data: map[string]any{"i": float64(i)}}
	}
	return out
}

func pages(t *testing.T, ctx context.Context, s nosql.Store) {
	create(t, ctx, s, rows("P", 60)...)
	create(t, ctx, s, rows("F", 50)...)
	first, err := s.List(ctx, "P", "")
	if err != nil || len(first.Items) != 50 || first.Cursor == "" {
		t.Fatalf("first page: %d items, cursor %q, %v", len(first.Items), first.Cursor, err)
	}
	second, err := s.List(ctx, "P", first.Cursor)
	if err != nil || len(second.Items) != 10 || second.Items[0].SK != "row-050" || second.Cursor != "" {
		t.Fatalf("second page: %d items, cursor %q, %v", len(second.Items), second.Cursor, err)
	}
	full, err := s.List(ctx, "F", "")
	if err != nil || len(full.Items) != 50 || full.Cursor != "" {
		t.Fatalf("exactly 50 rows: %d items, cursor %q, %v", len(full.Items), full.Cursor, err)
	}
}

func cursors(t *testing.T, ctx context.Context, s nosql.Store) {
	create(t, ctx, s, rows("P", 51)...)
	page, err := s.List(ctx, "P", "")
	if err != nil {
		t.Fatal(err)
	}
	want, _ := nosql.EncodeCursor("P", "row-049")
	if page.Cursor != want {
		t.Fatalf("cursor %q, want the shared format %q", page.Cursor, want)
	}
	for _, c := range []struct{ pk, cursor string }{{"OTHER", page.Cursor}, {"P", "not-a-cursor"}} {
		_, err := s.List(ctx, c.pk, c.cursor)
		if e, ok := apperr.As(err); !ok || e.Status != 400 || e.Message != "Invalid cursor" {
			t.Errorf("List(%s, %s): %v", c.pk, c.cursor, err)
		}
	}
}

func concurrent(t *testing.T, ctx context.Context, s nosql.Store) {
	const writers = 8
	var wg sync.WaitGroup
	errs := make([]error, writers)
	for i := range writers {
		wg.Go(func() {
			errs[i] = s.Transact(ctx, []nosql.Write{{Row: nosql.Row{PK: "C", SK: "one", Version: 1, Data: map[string]any{"writer": float64(i)}}}})
		})
	}
	wg.Wait()
	won := 0
	for _, err := range errs {
		switch {
		case err == nil:
			won++
		case apperr.IsConflict(err):
		default:
			t.Errorf("unexpected error: %v", err)
		}
	}
	if won != 1 {
		t.Fatalf("%d writers won", won)
	}
}
