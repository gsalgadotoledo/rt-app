package nosql

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"sync"
	"testing"

	"rt.local/core-go/apperr"
)

var ctx = context.Background()

func create(t *testing.T, s *MemoryStore, rows ...Row) {
	t.Helper()
	writes := make([]Write, len(rows))
	for i, row := range rows {
		writes[i] = Write{Row: row}
	}
	if err := s.Transact(ctx, writes); err != nil {
		t.Fatal(err)
	}
}

func TestGetMissingAndDeepCopies(t *testing.T) {
	s := NewMemoryStore()
	if row, err := s.Get(ctx, "USERS", "alice"); row != nil || err != nil {
		t.Fatalf("missing row = %v, %v", row, err)
	}
	data := map[string]any{"name": "Alice", "tags": []any{"a"}}
	create(t, s, Row{PK: "USERS", SK: "alice", Version: 1, Data: data})
	data["name"] = "changed after write"
	row, err := s.Get(ctx, "USERS", "alice")
	if err != nil || row.Data["name"] != "Alice" {
		t.Fatalf("stored row changed with the caller's map: %v %v", row, err)
	}
	row.Data["tags"].([]any)[0] = "changed after read"
	again, _ := s.Get(ctx, "USERS", "alice")
	if again.Data["tags"].([]any)[0] != "a" {
		t.Fatal("stored row changed with a returned row")
	}
}

func TestVersionGuards(t *testing.T) {
	s := NewMemoryStore()
	create(t, s, Row{PK: "A", SK: "x", Version: 1, Data: map[string]any{}})
	for name, w := range map[string]Write{
		"create existing": {Row: Row{PK: "A", SK: "x", Version: 1}},
		"stale version":   {Row: Row{PK: "A", SK: "x", Version: 3}, Expected: Expect(2)},
		"update missing":  {Row: Row{PK: "A", SK: "y", Version: 2}, Expected: Expect(1)},
	} {
		err := s.Transact(ctx, []Write{w})
		if e, ok := apperr.As(err); !ok || e.Status != 409 || e.Message != "Conflict: refresh and try again" {
			t.Errorf("%s: got %v", name, err)
		}
	}
	if err := s.Transact(ctx, []Write{{Row: Row{PK: "A", SK: "x", Version: 2}, Expected: Expect(1)}}); err != nil {
		t.Fatal(err)
	}
	if err := s.Transact(ctx, []Write{{Row: Row{PK: "A", SK: "x"}, Expected: Expect(2), Delete: true}}); err != nil {
		t.Fatal(err)
	}
	if row, _ := s.Get(ctx, "A", "x"); row != nil {
		t.Fatal("delete did not remove the row")
	}
}

func TestTransactionsAreAtomic(t *testing.T) {
	s := NewMemoryStore()
	create(t, s, Row{PK: "A", SK: "taken", Version: 1})
	err := s.Transact(ctx, []Write{{Row: Row{PK: "A", SK: "new", Version: 1}}, {Row: Row{PK: "A", SK: "taken", Version: 1}}})
	if !apperr.IsConflict(err) {
		t.Fatalf("want conflict, got %v", err)
	}
	if row, _ := s.Get(ctx, "A", "new"); row != nil {
		t.Fatal("first write was committed")
	}
	err = s.Transact(ctx, []Write{{Row: Row{PK: "A", SK: "x", Version: 1}}, {Row: Row{PK: "A", SK: "x", Version: 1}}})
	if !errors.Is(err, ErrDuplicateKey) || err.Error() != "Duplicate transaction key" {
		t.Fatalf("want duplicate key, got %v", err)
	}
	if _, ok := apperr.As(err); ok {
		t.Fatal("a duplicate key is a programming error, not an HTTP error")
	}
}

func TestListOrderAndPartition(t *testing.T) {
	s := NewMemoryStore()
	for _, sk := range []string{"b", "a", "B", "aa", "😀", "�", "é", "z"} {
		create(t, s, Row{PK: "P", SK: sk, Version: 1})
	}
	create(t, s, Row{PK: "Q", SK: "a", Version: 1})
	page, err := s.List(ctx, "P", "")
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, row := range page.Items {
		got = append(got, row.SK)
	}
	// Code point order: JavaScript's UTF-16 comparison would put 😀 before U+FFFD.
	want := fmt.Sprint([]string{"B", "a", "aa", "b", "z", "é", "�", "😀"})
	if fmt.Sprint(got) != want || page.Cursor != "" {
		t.Fatalf("got %v cursor %q, want %v", got, page.Cursor, want)
	}
	empty, err := s.List(ctx, "NOTHING", "")
	if err != nil || empty.Items == nil || len(empty.Items) != 0 || empty.Cursor != "" {
		t.Fatalf("empty partition = %#v, %v", empty, err)
	}
}

func TestPagination(t *testing.T) {
	s := NewMemoryStore()
	for i := range 60 {
		create(t, s, Row{PK: "P", SK: fmt.Sprintf("row-%03d", i), Version: 1})
	}
	first, err := s.List(ctx, "P", "")
	if err != nil || len(first.Items) != 50 || first.Cursor == "" {
		t.Fatalf("first page: %d items, cursor %q, %v", len(first.Items), first.Cursor, err)
	}
	raw, err := base64.RawURLEncoding.DecodeString(first.Cursor)
	if err != nil || string(raw) != `{"pk":"P","sk":"row-049"}` {
		t.Fatalf("cursor %q decodes to %q (%v)", first.Cursor, raw, err)
	}
	second, err := s.List(ctx, "P", first.Cursor)
	if err != nil || len(second.Items) != 10 || second.Items[0].SK != "row-050" || second.Cursor != "" {
		t.Fatalf("second page: %v, %v", second, err)
	}
	for _, cursor := range []string{"not-a-cursor", "bnVsbA", base64.RawURLEncoding.EncodeToString([]byte(`{"pk":"P","sk":1}`))} {
		if _, err := s.List(ctx, "P", cursor); !isInvalidCursor(err) {
			t.Errorf("cursor %q: got %v", cursor, err)
		}
	}
	if _, err := s.List(ctx, "OTHER", first.Cursor); !isInvalidCursor(err) {
		t.Errorf("cursor reused on another partition: got %v", err)
	}
}

func isInvalidCursor(err error) bool {
	e, ok := apperr.As(err)
	return ok && e.Status == 400 && e.Message == "Invalid cursor"
}

func TestConcurrentCreatesHaveOneWinner(t *testing.T) {
	s := NewMemoryStore()
	var wg sync.WaitGroup
	var mu sync.Mutex
	wins := 0
	for range 32 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if s.Transact(ctx, []Write{{Row: Row{PK: "A", SK: "x", Version: 1}}}) == nil {
				mu.Lock()
				wins++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if wins != 1 {
		t.Fatalf("%d concurrent creates succeeded", wins)
	}
}
