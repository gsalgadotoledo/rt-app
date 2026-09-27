package tasks_test

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"testing"
	"time"

	"rt.local/core-go/apperr"
	"rt.local/core-go/nosql"
	"rt.local/core-go/tasks"
	"rt.local/core-go/web"
)

var (
	alice   = &web.Actor{ID: "alice", Role: "user"}
	bob     = &web.Actor{ID: "bob", Role: "user"}
	owner   = &web.Actor{ID: "root", Role: "owner"}
	manager = &web.Actor{ID: "mgr", Role: "admin", Grants: []string{"tasks.manage"}}
)

func wantStatus(t *testing.T, err error, status int, message string) {
	t.Helper()
	var e *apperr.HTTPError
	if !errors.As(err, &e) || e.Status != status || e.Message != message {
		t.Fatalf("got %v, want %d %q", err, status, message)
	}
}

type fixture struct {
	store *nosql.MemoryStore
	tasks *tasks.Tasks
	now   time.Time
}

func newFixture() *fixture {
	f := &fixture{store: nosql.NewMemoryStore(), now: time.Date(2026, 1, 2, 3, 4, 5, 678e6, time.UTC)}
	n := 0
	f.tasks = tasks.New(f.store, tasks.WithClock(func() time.Time { return f.now }), tasks.WithIDs(func() string {
		n++
		return fmt.Sprintf("id-%d", n-1)
	}))
	return f
}

func ids(page []map[string]any) string {
	var out []string
	for _, item := range page {
		out = append(out, item["id"].(string))
	}
	return strings.Join(out, ",")
}

func TestCreateWithAudit(t *testing.T) {
	ctx, f := context.Background(), newFixture()
	task, err := f.tasks.Create(ctx, map[string]any{"title": " Milk ", "done": true, "ownerId": "bob"}, alice)
	if err != nil {
		t.Fatal(err)
	}
	const stamp = "2026-01-02T03:04:05.678Z"
	if task["id"] != "id-0" || task["title"] != "Milk" || task["done"] != false || task["ownerId"] != "alice" ||
		task["createdAt"] != stamp || task["updatedBy"] != "alice" || task["deletedAt"] != nil {
		t.Fatalf("task = %v", task)
	}
	_, err = f.tasks.Create(ctx, map[string]any{"title": strings.Repeat("🙂", 101)}, alice)
	wantStatus(t, err, 400, "Invalid field: title")
	generated, _ := tasks.New(nosql.NewMemoryStore()).Create(ctx, map[string]any{"title": "x"}, alice)
	if !regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).MatchString(generated["id"].(string)) {
		t.Fatalf("id = %v", generated["id"])
	}
}

func TestListsFiltersAndTrash(t *testing.T) {
	ctx, f := context.Background(), newFixture()
	_, _ = f.tasks.Create(ctx, map[string]any{"title": "Ärger"}, alice)
	_, _ = f.tasks.Create(ctx, map[string]any{"title": "Other"}, bob)
	check := func(query map[string]string, actor *web.Actor, all bool, want string) {
		t.Helper()
		page, err := f.tasks.List(ctx, query, actor, all)
		if err != nil || ids(page.Items) != want {
			t.Fatalf("List(%v) = %v, %v; want %s", query, page, err, want)
		}
	}
	check(map[string]string{}, alice, false, "id-0")
	check(map[string]string{}, owner, true, "id-0,id-1")
	check(map[string]string{"title": "äR"}, owner, true, "id-0")
	check(map[string]string{"done": "FAL"}, owner, true, "id-0,id-1")
	_, err := f.tasks.List(ctx, map[string]string{"trash": "yes", "status": "x"}, alice, false)
	wantStatus(t, err, 400, "Invalid trash filter")
	_, err = f.tasks.List(ctx, map[string]string{"status": "x"}, alice, false)
	wantStatus(t, err, 400, "Unsupported filter: status")
	if _, err := f.tasks.Remove(ctx, "id-0", alice); err != nil {
		t.Fatal(err)
	}
	check(map[string]string{}, alice, false, "")
	check(map[string]string{"trash": "true"}, alice, false, "id-0")
}

func TestEditRules(t *testing.T) {
	ctx, f := context.Background(), newFixture()
	_, _ = f.tasks.Create(ctx, map[string]any{"title": "Mine"}, alice)
	_, err := f.tasks.Update(ctx, "nope", nil, alice)
	wantStatus(t, err, 404, "Task not found")
	_, err = f.tasks.Update(ctx, "id-0", map[string]any{"done": "x"}, bob)
	wantStatus(t, err, 403, "This task belongs to another user")
	_, err = f.tasks.Update(ctx, "id-0", map[string]any{"title": nil, "done": 1.0}, alice)
	wantStatus(t, err, 400, "Invalid field: title")
	_, err = f.tasks.Update(ctx, "id-0", map[string]any{"done": 1.0}, alice)
	wantStatus(t, err, 400, "done must be a boolean")
	f.now = time.Date(2026, 3, 4, 0, 0, 0, 0, time.UTC)
	task, err := f.tasks.Update(ctx, "id-0", map[string]any{"title": "By manager", "done": true}, manager)
	if err != nil || task["title"] != "By manager" || task["updatedBy"] != "mgr" || task["updatedAt"] != "2026-03-04T00:00:00.000Z" || task["createdAt"] != "2026-01-02T03:04:05.678Z" {
		t.Fatalf("task = %v, %v", task, err)
	}
	if row, _ := f.store.Get(ctx, tasks.Partition, "id-0"); row.Version != 2 {
		t.Fatalf("version = %d", row.Version)
	}
}

func TestTrashAndRestore(t *testing.T) {
	ctx, f := context.Background(), newFixture()
	_, _ = f.tasks.Create(ctx, map[string]any{"title": "T"}, alice)
	_, err := f.tasks.Restore(ctx, "id-0", alice)
	wantStatus(t, err, 404, "Task not found")
	_, err = f.tasks.AdminRemove(ctx, "nope", alice)
	wantStatus(t, err, 403, "Requires tasks.manage")
	if ok, err := f.tasks.AdminRemove(ctx, "id-0", owner); err != nil || ok["ok"] != true {
		t.Fatalf("remove = %v, %v", ok, err)
	}
	_, err = f.tasks.Remove(ctx, "id-0", alice)
	wantStatus(t, err, 404, "Task not found")
	_, err = f.tasks.Restore(ctx, "id-0", &web.Actor{ID: "bob", Role: "admin", Grants: []string{"tasks.restore"}})
	wantStatus(t, err, 403, "This task belongs to another user")
	task, err := f.tasks.Restore(ctx, "id-0", alice)
	if err != nil || task["deletedAt"] != nil || task["restoredBy"] != "alice" {
		t.Fatalf("restore = %v, %v", task, err)
	}
}

func TestUnknownFieldsAndTTLSurvive(t *testing.T) {
	ctx, f := context.Background(), newFixture()
	ttl := int64(99)
	row := nosql.Row{PK: tasks.Partition, SK: "w", Version: 3, TTL: &ttl, Data: map[string]any{"id": "w", "title": "W", "ownerId": "alice", "color": "red", "deletedAt": ""}}
	if err := f.store.Transact(ctx, []nosql.Write{{Row: row}}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.tasks.Update(ctx, "w", map[string]any{"done": true}, alice); err != nil {
		t.Fatal(err)
	}
	got, _ := f.store.Get(ctx, tasks.Partition, "w")
	if got.Version != 4 || got.TTL == nil || *got.TTL != 99 || got.Data["color"] != "red" || got.Data["done"] != true {
		t.Fatalf("row = %+v", got)
	}
}

func TestMigrateAndSeed(t *testing.T) {
	ctx := context.Background()
	store := nosql.NewMemoryStore()
	for range 2 {
		if err := tasks.Migrate(ctx, store); err != nil {
			t.Fatal(err)
		}
	}
	if row, _ := store.Get(ctx, "SCHEMA", "tasks"); row == nil || row.Version != 1 {
		t.Fatalf("schema row = %+v", row)
	}
	rows := tasks.WelcomeRows([]nosql.Row{{PK: "USERS", SK: "u1", Data: map[string]any{"id": "u1"}}}, time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC))
	if len(rows) != 1 || rows[0].SK != "welcome-u1" || rows[0].Data["ownerId"] != "u1" || rows[0].Data["createdAt"] != "2026-01-02T00:00:00.000Z" {
		t.Fatalf("rows = %+v", rows)
	}
}
