// Package tasks stores personal tasks with soft delete (trash) and restore under partition
// TASKS, with the task id as sort key.
//
// Behavior matches the TypeScript reference (@gsalgadotoledo/rt-app-tasks) and the tasks
// contract: the owner of a task, role "owner" and holders of the "tasks.manage" grant may change
// it; deleting marks deletedAt/deletedBy, restoring clears them and records restoredAt/By.
package tasks

import (
	"context"
	"maps"
	"net/http"
	"slices"
	"time"

	"rt.local/core-go/apperr"
	"rt.local/core-go/internal/js"
	"rt.local/core-go/internal/uuid"
	"rt.local/core-go/nosql"
	"rt.local/core-go/users"
	"rt.local/core-go/web"
)

// Partition is the store partition of the tasks.
const Partition = "TASKS"

// WelcomeTitle is the title of the seeded welcome task.
const WelcomeTitle = "Explore my first task in RT-App"

// Filters are the query fields lists accept (besides cursor and trash).
var Filters = []string{"id", "title", "done", "ownerId"}

// Errors of the module.
var (
	ErrNotFound    = apperr.NotFound("Task not found")
	ErrForeign     = apperr.New(http.StatusForbidden, "This task belongs to another user")
	ErrNeedsManage = apperr.New(http.StatusForbidden, "Requires tasks.manage")
	ErrDoneNotBool = apperr.BadRequest("done must be a boolean")
)

// GrantManage lets an actor change and remove every task.
const GrantManage = "tasks.manage"

// Migration describes a module migration.
type Migration struct {
	ID          string `json:"id"`
	Checksum    string `json:"checksum"`
	Description string `json:"description"`
}

// Seed describes example data of the module (never run in prod).
type Seed struct {
	ID           string   `json:"id"`
	Description  string   `json:"description"`
	Environments []string `json:"environments"`
}

// Migrations of the module: the document schema is recorded once.
var Migrations = []Migration{{ID: "tasks:001", Checksum: "tasks-document-v1", Description: "Register the tasks document schema"}}

// Seeds of the module: one welcome task per demo user.
var Seeds = []Seed{{ID: "tasks:welcome", Description: "A welcome task for each demo user", Environments: []string{"local", "develop", "stage"}}}

// SeedRow is a row a seed inserts when it does not exist yet.
type SeedRow struct {
	PK   string         `json:"pk"`
	SK   string         `json:"sk"`
	Data map[string]any `json:"data"`
}

// Admin is the admin manifest of the module.
func Admin() map[string]any {
	return map[string]any{
		"id": "tasks", "title": "Tasks", "resource": "tasks.list", "path": "/tasks/admin", "component": "tasks",
		"fields": []any{"id", "title", "done", "ownerId"}, "actions": []any{"list", "create", "edit", "delete"},
	}
}

// Migrate runs the module migrations: SCHEMA/tasks {schemaVersion: 1} unless it exists.
func Migrate(ctx context.Context, store nosql.Store) error {
	existing, err := store.Get(ctx, "SCHEMA", "tasks")
	if err != nil || existing != nil {
		return err
	}
	row := nosql.Row{PK: "SCHEMA", SK: "tasks", Version: 1, Data: map[string]any{"schemaVersion": 1}}
	return store.Transact(ctx, []nosql.Write{{Row: row}})
}

// WelcomeRows are the rows of the tasks:welcome seed for the given demo user rows.
func WelcomeRows(demoUsers []nosql.Row, at time.Time) []SeedRow {
	rows := make([]SeedRow, 0, len(demoUsers))
	for _, user := range demoUsers {
		owner := js.String(user.Data["id"])
		id := "welcome-" + owner
		rows = append(rows, SeedRow{PK: Partition, SK: id, Data: map[string]any{
			"id": id, "title": WelcomeTitle, "done": false, "ownerId": owner, "createdAt": users.ISOTime(at),
		}})
	}
	return rows
}

// Tasks stores and edits tasks. It is safe for concurrent use if its store is.
type Tasks struct {
	store nosql.Store
	now   func() time.Time
	newID func() string
}

// Option configures Tasks.
type Option func(*Tasks)

// WithClock sets the clock of audit timestamps (default time.Now).
func WithClock(now func() time.Time) Option { return func(t *Tasks) { t.now = now } }

// WithIDs sets the generator of task ids (default random UUID v4).
func WithIDs(newID func() string) Option { return func(t *Tasks) { t.newID = newID } }

// New returns Tasks over store.
func New(store nosql.Store, options ...Option) *Tasks {
	t := &Tasks{store: store, now: time.Now, newID: uuid.New}
	for _, option := range options {
		option(t)
	}
	return t
}

func manager(actor *web.Actor) bool {
	return actor.Role == users.RoleOwner || slices.Contains(actor.Grants, GrantManage)
}

// List returns one search page of live tasks (deleted ones with trash=true): the actor's own,
// or every task when all is set. Query names: id, title, done, ownerId, cursor, trash.
func (t *Tasks) List(ctx context.Context, query map[string]string, actor *web.Actor, all bool) (users.Page, error) {
	return users.SearchPage(ctx, t.store, Partition, query, Filters, func(row nosql.Row) map[string]any {
		if all || js.Equal(row.Data["ownerId"], actor.ID) {
			return row.Data
		}
		return nil
	})
}

// Create stores a new open task owned by actor; only body["title"] is read.
func (t *Tasks) Create(ctx context.Context, body map[string]any, actor *web.Actor) (map[string]any, error) {
	title, err := users.Text(body["title"], "title", 200)
	if err != nil {
		return nil, err
	}
	id := t.newID()
	data := map[string]any{"id": id, "title": title, "done": false, "ownerId": actor.ID}
	maps.Copy(data, users.AuditCreate(actor.ID, t.now()))
	row := nosql.Row{PK: Partition, SK: id, Version: 1, Data: data}
	if err := t.store.Transact(ctx, []nosql.Write{{Row: row}}); err != nil {
		return nil, err
	}
	return data, nil
}

type action int

const (
	update action = iota
	remove
	restore
)

// Update edits title and/or done of a live task.
func (t *Tasks) Update(ctx context.Context, id string, body map[string]any, actor *web.Actor) (map[string]any, error) {
	return t.edit(ctx, id, actor, update, body)
}

// Remove moves a live task to the trash and returns {ok: true}.
func (t *Tasks) Remove(ctx context.Context, id string, actor *web.Actor) (map[string]any, error) {
	if _, err := t.edit(ctx, id, actor, remove, nil); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true}, nil
}

// Restore brings a deleted task back.
func (t *Tasks) Restore(ctx context.Context, id string, actor *web.Actor) (map[string]any, error) {
	return t.edit(ctx, id, actor, restore, nil)
}

// AdminRemove removes any task; it needs role "owner" or the grant "tasks.manage", checked
// before the task is looked up.
func (t *Tasks) AdminRemove(ctx context.Context, id string, actor *web.Actor) (map[string]any, error) {
	if !manager(actor) {
		return nil, ErrNeedsManage
	}
	return t.Remove(ctx, id, actor)
}

func (t *Tasks) edit(ctx context.Context, id string, actor *web.Actor, what action, body map[string]any) (map[string]any, error) {
	row, err := t.store.Get(ctx, Partition, id)
	if err != nil {
		return nil, err
	}
	if row == nil || js.Truthy(row.Data["deletedAt"]) != (what == restore) {
		return nil, ErrNotFound
	}
	if !js.Equal(row.Data["ownerId"], actor.ID) && !manager(actor) {
		return nil, ErrForeign
	}
	data := maps.Clone(row.Data)
	if data == nil {
		data = map[string]any{}
	}
	at := t.now()
	switch what {
	case restore:
		maps.Copy(data, users.AuditRestore(actor.ID, at))
	case remove:
		maps.Copy(data, users.AuditDelete(actor.ID, at))
	default:
		maps.Copy(data, users.AuditUpdate(actor.ID, at))
		if raw, present := body["title"]; present {
			title, err := users.Text(raw, "title", 200)
			if err != nil {
				return nil, err
			}
			data["title"] = title
		}
		if raw, present := body["done"]; present {
			done, ok := raw.(bool)
			if !ok {
				return nil, ErrDoneNotBool
			}
			data["done"] = done
		}
	}
	next := nosql.Row{PK: row.PK, SK: row.SK, Version: row.Version + 1, Data: data, TTL: row.TTL}
	if err := t.store.Transact(ctx, []nosql.Write{{Row: next, Expected: nosql.Expect(row.Version)}}); err != nil {
		return nil, err
	}
	return data, nil
}

// Feature exposes the task endpoints (permission endpoints are mounted under /admin/app):
//
//	GET    /tasks                     authenticated  tasks.mine     the actor's tasks
//	GET    /tasks/admin               permission     tasks.list     every task
//	POST   /tasks                     authenticated  tasks.create   {title}
//	PATCH  /tasks/:id                 authenticated  tasks.edit     {title?, done?}
//	DELETE /tasks/:id                 authenticated  tasks.delete
//	POST   /tasks/:id/restore         authenticated  tasks.restore
//	PATCH  /tasks/admin/:id           permission     tasks.manage
//	DELETE /tasks/admin/:id           permission     tasks.remove   (also needs tasks.manage)
//	POST   /tasks/admin/:id/restore   permission     tasks.restore
func (t *Tasks) Feature() web.Feature {
	byID := func(fn func(context.Context, string, *web.Actor) (map[string]any, error)) func(*web.Context) (any, error) {
		return func(c *web.Context) (any, error) { return fn(c.Ctx, c.Params["id"], c.Actor) }
	}
	edit := func(c *web.Context) (any, error) { return t.Update(c.Ctx, c.Params["id"], c.Request.Body, c.Actor) }
	return web.Feature{
		ID: "tasks",
		Endpoints: []web.Endpoint{
			{Method: "POST", Path: "/tasks/:id/restore", Access: web.Authenticated, Resource: "tasks.restore", Handle: byID(t.Restore)},
			{Method: "POST", Path: "/tasks/admin/:id/restore", Access: web.Permission, Resource: "tasks.restore", Handle: byID(t.Restore)},
			{Method: "GET", Path: "/tasks", Access: web.Authenticated, Resource: "tasks.mine", Handle: func(c *web.Context) (any, error) {
				return t.List(c.Ctx, c.Request.Query, c.Actor, false)
			}},
			{Method: "GET", Path: "/tasks/admin", Access: web.Permission, Resource: "tasks.list", Handle: func(c *web.Context) (any, error) {
				return t.List(c.Ctx, c.Request.Query, c.Actor, true)
			}},
			{Method: "POST", Path: "/tasks", Access: web.Authenticated, Resource: "tasks.create", Handle: func(c *web.Context) (any, error) {
				return t.Create(c.Ctx, c.Request.Body, c.Actor)
			}},
			{Method: "PATCH", Path: "/tasks/:id", Access: web.Authenticated, Resource: "tasks.edit", Handle: edit},
			{Method: "DELETE", Path: "/tasks/:id", Access: web.Authenticated, Resource: "tasks.delete", Handle: byID(t.Remove)},
			{Method: "PATCH", Path: "/tasks/admin/:id", Access: web.Permission, Resource: "tasks.manage", Handle: edit},
			{Method: "DELETE", Path: "/tasks/admin/:id", Access: web.Permission, Resource: "tasks.remove", Handle: byID(t.AdminRemove)},
		},
	}
}
