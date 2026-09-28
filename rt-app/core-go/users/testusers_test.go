package users

import (
	"context"
	"slices"
	"testing"
	"time"

	"rt.local/core-go/nosql"
	"rt.local/core-go/web"
)

func TestTestUserValidators(t *testing.T) {
	if IsTestUser(nil) || IsTestUser(map[string]any{"testUser": "true"}) || IsTestUser(map[string]any{"testUser": 1.0}) || !IsTestUser(map[string]any{"testUser": true}) {
		t.Fatal("IsTestUser must accept only the boolean true")
	}
	if _, set, err := TestUserInput(nil); set || err != nil {
		t.Fatal("nil is not given")
	}
	if v, set, err := TestUserInput(false); v || !set || err != nil {
		t.Fatal("false is a value")
	}
	for _, bad := range []any{"true", 1.0, 0.0, map[string]any{}, []any{}} {
		if _, _, err := TestUserInput(bad); err == nil || err.Error() != "Invalid field: testUser" {
			t.Errorf("%v: %v", bad, err)
		}
	}
	for _, ok := range []map[string]string{{}, {"testUser": ""}, {"testUser": "true"}, {"testUser": "false"}} {
		if TestUserFilter(ok) != nil {
			t.Errorf("%v rejected", ok)
		}
	}
	if err := TestUserFilter(map[string]string{"testUser": "TRUE"}); err == nil || err.Error() != "Invalid testUser filter" {
		t.Fatal(err)
	}
	if ViewAccount(map[string]any{"id": "u", "testUser": true}, 0)["testUser"] != true || ViewAccount(map[string]any{"id": "u"}, 0)["testUser"] != false {
		t.Fatal("view")
	}
}

func TestTestUserCreateUpdateAndList(t *testing.T) {
	ctx := context.Background()
	at := time.Date(2026, 3, 1, 10, 0, 0, 0, time.UTC)
	store := nosql.NewMemoryStore()
	accounts := New(store, WithClock(func() time.Time { return at }))
	owner, err := accounts.BootstrapOwner(ctx, map[string]any{"email": "owner@example.test", "name": "Owner", "password": "correct horse battery", "testUser": "ignored"})
	if err != nil || owner.Data["testUser"] != nil {
		t.Fatal("the first owner is never a test user", err, owner)
	}
	qa, err := accounts.Create(ctx, map[string]any{"email": "qa@example.test", "name": "QA", "password": "correct horse battery", "testUser": true}, "", "")
	if err != nil || qa.Data["testUser"] != true {
		t.Fatal(err, qa)
	}
	if real, err := accounts.Create(ctx, map[string]any{"email": "r@example.test", "name": "R", "password": "correct horse battery", "testUser": false}, "", ""); err != nil || real.Data["testUser"] != nil {
		t.Fatal("false is not stored", err)
	}
	if _, err := accounts.Create(ctx, map[string]any{"email": "b@example.test", "name": "B", "password": "x", "testUser": 1.0}, "", ""); err == nil || err.Error() != PasswordMessage {
		t.Fatal("password is validated first", err)
	}

	ban := map[string]any{"reason": "Spam", "category": nil, "until": nil, "at": "2026-03-01T09:00:00.000Z", "by": "rt-app-root"}
	if err := store.Transact(ctx, []nosql.Write{{Row: nosql.Row{PK: "USERS", SK: "u-1", Version: 1, Data: map[string]any{
		"id": "u-1", "email": "a@example.test", "name": "A", "role": "user", "grants": []any{}, "active": true, "tokenVersion": 3.0, "ban": ban}}}}); err != nil {
		t.Fatal(err)
	}
	view, err := accounts.Update(ctx, "u-1", map[string]any{"testUser": true}, "admin-1")
	if err != nil || view["testUser"] != true || view["banned"] != true || view["name"] != "A" || view["updatedBy"] != "admin-1" {
		t.Fatal(err, view)
	}
	row, _ := store.Get(ctx, "USERS", "u-1")
	if row.Version != 2 || row.Data["testUser"] != true || row.Data["tokenVersion"] != 3.0 {
		t.Fatal(row)
	}
	if view, err := accounts.Update(ctx, "u-1", map[string]any{"name": nil, "testUser": false}, "admin-1"); err != nil || view["testUser"] != false {
		t.Fatal(err, view)
	}
	for _, c := range []struct {
		input   map[string]any
		message string
	}{
		{map[string]any{}, "Invalid field: name"},
		{map[string]any{"testUser": nil}, "Invalid field: name"},
		{map[string]any{"testUser": "yes"}, "Invalid field: testUser"},
		{map[string]any{"name": "B", "testUser": 1.0}, "Invalid field: testUser"},
		{map[string]any{"email": "x"}, "Only name and testUser can be edited; email requires verification"},
	} {
		if _, err := accounts.Update(ctx, "u-1", c.input, "admin-1"); err == nil || err.Error() != c.message {
			t.Errorf("%v: %v", c.input, err)
		}
	}
	if _, err := accounts.Update(ctx, "missing", map[string]any{"email": "x"}, "admin-1"); err == nil || err.Error() != "User not found" {
		t.Fatal(err)
	}
	if _, err := accounts.Profile(ctx, "u-1", map[string]any{"testUser": true}, ""); err == nil {
		t.Fatal("users cannot set their own flag")
	}

	var list web.Endpoint
	for _, e := range accounts.Feature().Endpoints {
		if e.Method == "GET" && e.Path == "/users" {
			list = e
		}
	}
	ids := func(query map[string]string) []string {
		page, err := list.Handle(&web.Context{Ctx: ctx, Request: web.Request{Query: query}})
		if err != nil {
			t.Fatal(err)
		}
		out := []string{}
		for _, item := range page.(Page).Items {
			out = append(out, item["id"].(string))
		}
		return out
	}
	if got := ids(map[string]string{"testUser": "true"}); !slices.Equal(got, []string{qa.SK}) {
		t.Fatal(got)
	}
	if got := ids(map[string]string{"testUser": "false"}); len(got) != 3 {
		t.Fatal(got)
	}
	if _, err := list.Handle(&web.Context{Ctx: ctx, Request: web.Request{Query: map[string]string{"testUser": "yes"}}}); err == nil || err.Error() != "Invalid testUser filter" {
		t.Fatal(err)
	}
	if got, err := TestUserIDs(ctx, store); err != nil || !slices.Equal(got, []string{qa.SK}) {
		t.Fatal(got, err)
	}
}
