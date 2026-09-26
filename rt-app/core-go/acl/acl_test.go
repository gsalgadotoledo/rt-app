package acl

import (
	"context"
	"testing"
	"time"

	"rt.local/core-go/apperr"
	"rt.local/core-go/nosql"
	"rt.local/core-go/web"
)

var resources = []Endpoint{
	{Resource: "items.read", Method: "GET", Path: "/items", Access: web.Permission},
	{Resource: "items.write", Method: "POST", Path: "/items", Access: web.Permission},
	{Resource: "secret", Method: "POST", Path: "/secret", Access: web.Owner},
	{Resource: "home", Method: "GET", Path: "/", Access: web.Guest},
}

var (
	root  = &web.Actor{ID: "root", Role: "owner"}
	alice = &web.Actor{ID: "alice", Role: "user", Grants: []string{"items.read"}}
	adm   = &web.Actor{ID: "adm", Role: "admin"}
)

func newACL(t *testing.T) (*ACL, *nosql.MemoryStore) {
	t.Helper()
	store := nosql.NewMemoryStore()
	err := store.Transact(context.Background(), []nosql.Write{
		{Row: nosql.Row{PK: "USERS", SK: "alice", Version: 1, Data: map[string]any{"id": "alice", "email": "a@x.y", "name": "Alice", "role": "user", "grants": []any{"items.read"}, "active": true, "tokenVersion": 1}}},
		{Row: nosql.Row{PK: "USERS", SK: "root", Version: 1, Data: map[string]any{"id": "root", "role": "owner", "grants": []any{}, "tokenVersion": 1}}},
		{Row: nosql.Row{PK: "USERS", SK: "gone", Version: 1, Data: map[string]any{"id": "gone", "role": "user", "deletedAt": "2026-01-01T00:00:00.000Z"}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	at := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	return New(store, func() []Endpoint { return resources }, WithClock(func() time.Time { return at })), store
}

func statusOf(err error) int {
	if e, ok := apperr.As(err); ok {
		return e.Status
	}
	return 0
}

func TestCheck(t *testing.T) {
	a, _ := newACL(t)
	cases := []struct {
		endpoint Endpoint
		actor    *web.Actor
		status   int
	}{
		{Endpoint{Resource: "home", Access: web.Guest}, nil, 0},
		{Endpoint{Resource: "x", Access: "admin"}, root, 403}, // unknown access fails closed
		{Endpoint{Resource: "x", Access: "Guest"}, nil, 403},
		{Endpoint{Resource: "me", Access: web.Authenticated}, nil, 401},
		{Endpoint{Resource: "me", Access: web.Authenticated}, alice, 0},
		{Endpoint{Resource: "secret", Access: web.Owner}, &web.Actor{Role: "admin", Grants: []string{"secret"}}, 403},
		{Endpoint{Resource: "secret", Access: web.Owner}, root, 0},
		{Endpoint{Resource: "items.read", Access: web.Permission}, alice, 0},
		{Endpoint{Resource: "items.write", Access: web.Permission}, alice, 403},
		{Endpoint{Resource: "items.write", Access: web.Permission}, adm, 403},
		{Endpoint{Resource: "items.write", Access: web.Permission}, root, 0},
		{Endpoint{Resource: "items.read", Access: web.Permission, ExplicitGrant: true}, root, 403},
		{Endpoint{Resource: "items.read", Access: web.Permission, ExplicitGrant: true}, alice, 0},
	}
	for _, c := range cases {
		if got := statusOf(a.Check(c.endpoint, c.actor)); got != c.status {
			t.Errorf("Check(%+v, %+v) = %d, want %d", c.endpoint, c.actor, got, c.status)
		}
	}
	if a.Allows(&web.Actor{Role: "user", Grants: []string{"items.*"}}, "items.read") || a.Allows(nil, "items.read") {
		t.Error("wildcards or anonymous allowed")
	}
}

func TestResources(t *testing.T) {
	a, _ := newACL(t)
	items, err := a.Resources(map[string]string{"method": "po", "access": "own", "cursor": "x"})
	if err != nil || len(items) != 1 || items[0]["resource"] != "secret" {
		t.Fatalf("filtered: %v %v", items, err)
	}
	if _, err := a.Resources(map[string]string{"role": "owner"}); err == nil || err.Error() != "Unsupported filter: role" {
		t.Fatalf("unsupported filter: %v", err)
	}
}

func TestAssign(t *testing.T) {
	ctx := context.Background()
	a, store := newACL(t)
	view, err := a.Assign(ctx, "alice", map[string]any{"role": "admin", "grants": []any{"items.write", "items.read", "items.write"}}, root)
	if err != nil || view["role"] != "admin" || view["updatedAt"] != "2026-01-02T03:04:05.000Z" || len(view["grants"].([]any)) != 2 {
		t.Fatalf("assign: %v %v", view, err)
	}
	row, _ := store.Get(ctx, "USERS", "alice")
	if row.Version != 2 || row.Data["tokenVersion"] != 2.0 || row.Data["grants"].([]any)[0] != "items.write" {
		t.Fatalf("stored: %+v", row)
	}
	for _, c := range []struct {
		id     string
		body   map[string]any
		actor  *web.Actor
		status int
	}{
		{"alice", map[string]any{"role": "admin", "grants": []any{}}, adm, 403},
		{"missing", map[string]any{"role": "user", "grants": []any{}}, root, 404},
		{"gone", map[string]any{"role": "user", "grants": []any{}}, root, 404},
		{"root", map[string]any{"role": "bogus"}, root, 403},
		{"alice", map[string]any{"role": "owner", "grants": []any{}}, root, 400},
		{"alice", map[string]any{"role": "user", "grants": []any{"secret"}}, root, 400},
		{"alice", map[string]any{"role": "user", "grants": "items.read"}, root, 400},
	} {
		if _, err := a.Assign(ctx, c.id, c.body, c.actor); statusOf(err) != c.status {
			t.Errorf("Assign(%s, %v): %v, want %d", c.id, c.body, err, c.status)
		}
	}
}
