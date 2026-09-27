// Package content is the editable home page of an application: one row CONTENT/home holding
// {title, content}, read with defaults (version 0) until the first save.
//
// Behavior matches the TypeScript reference (@gsalgadotoledo/rt-app-content) and the content
// contract: saves need the current version (checked before the values) and text limits count
// UTF-16 code units before JavaScript trim().
package content

import (
	"context"

	"rt.local/core-go/apperr"
	"rt.local/core-go/internal/js"
	"rt.local/core-go/nosql"
	"rt.local/core-go/users"
	"rt.local/core-go/web"
)

// Storage location of the home content.
const (
	Partition = "CONTENT"
	Key       = "home"
)

// Limits of the fields, in UTF-16 code units.
const (
	TitleMax   = 120
	ContentMax = 2000
)

// Default home values, served until the first save.
const (
	DefaultTitle   = "Welcome to RT-App"
	DefaultContent = "A small starting point for building great applications."
)

// ErrVersionRequired is returned when a save has no integer version.
var ErrVersionRequired = apperr.BadRequest("Version is required")

// Field describes one editable field for the admin form.
type Field struct {
	Name      string `json:"name"`
	Label     string `json:"label"`
	Type      string `json:"type"`
	MaxLength int    `json:"maxLength"`
}

// Fields are the editable fields, in form order.
var Fields = []Field{
	{Name: "title", Label: "Title", Type: "text", MaxLength: TitleMax},
	{Name: "content", Label: "Description", Type: "textarea", MaxLength: ContentMax},
}

// Settings is what the admin edits: the stored version (0 before the first save), the stored
// data as is (or the defaults) and the form fields.
type Settings struct {
	Version int            `json:"version"`
	Values  map[string]any `json:"values"`
	Fields  []Field        `json:"fields"`
}

// Migration describes a module migration.
type Migration struct {
	ID          string `json:"id"`
	Checksum    string `json:"checksum"`
	Description string `json:"description"`
}

// Migrations of the module: the document schema is recorded once.
var Migrations = []Migration{{ID: "content:001", Checksum: "content-document-v1", Description: "Register the content document schema"}}

// Admin is the admin manifest of the module.
func Admin() map[string]any {
	return map[string]any{
		"id": "content", "group": "content", "title": "Home", "resource": "content.read",
		"path": "/content/settings", "component": "content", "fields": []any{}, "actions": []any{},
		"settings": map[string]any{"path": "/content/settings", "resource": "content.write"},
	}
}

// Migrate runs the module migrations: SCHEMA/content {schemaVersion: 1} unless it exists.
func Migrate(ctx context.Context, store nosql.Store) error {
	return schemaMigration(ctx, store, "content")
}

func schemaMigration(ctx context.Context, store nosql.Store, module string) error {
	existing, err := store.Get(ctx, "SCHEMA", module)
	if err != nil || existing != nil {
		return err
	}
	row := nosql.Row{PK: "SCHEMA", SK: module, Version: 1, Data: map[string]any{"schemaVersion": 1}}
	return store.Transact(ctx, []nosql.Write{{Row: row}})
}

// Content reads and edits the home page. It is safe for concurrent use if its store is.
type Content struct {
	store nosql.Store
}

// New returns Content over store.
func New(store nosql.Store) *Content { return &Content{store: store} }

// Settings returns the current settings.
func (c *Content) Settings(ctx context.Context) (Settings, error) {
	row, err := c.store.Get(ctx, Partition, Key)
	if err != nil {
		return Settings{}, err
	}
	return settingsOf(row), nil
}

func settingsOf(row *nosql.Row) Settings {
	s := Settings{Values: map[string]any{"title": DefaultTitle, "content": DefaultContent}, Fields: Fields}
	if row != nil {
		s.Version, s.Values = row.Version, row.Data
		if s.Values == nil {
			s.Values = map[string]any{}
		}
	}
	return s
}

// Home returns {title, content} of the settings (nil for fields the stored data lacks).
func (c *Content) Home(ctx context.Context) (map[string]any, error) {
	s, err := c.Settings(ctx)
	if err != nil {
		return nil, err
	}
	return map[string]any{"title": s.Values["title"], "content": s.Values["content"]}, nil
}

// Save replaces the values when body["version"] is the stored version and returns the new
// settings. Errors, in order: 400 "Version is required" (not an integer), 409 (stale version),
// 400 "Invalid field: title" and 400 "Invalid field: content".
func (c *Content) Save(ctx context.Context, body map[string]any) (Settings, error) {
	row, err := c.store.Get(ctx, Partition, Key)
	if err != nil {
		return Settings{}, err
	}
	version, ok := js.Integer(body["version"])
	if !ok {
		return Settings{}, ErrVersionRequired
	}
	current := 0
	var expected *int
	if row != nil {
		current, expected = row.Version, nosql.Expect(row.Version)
	}
	if version != float64(current) {
		return Settings{}, apperr.Conflict()
	}
	values, _ := body["values"].(map[string]any)
	title, err := users.Text(values["title"], "title", TitleMax)
	if err != nil {
		return Settings{}, err
	}
	text, err := users.Text(values["content"], "content", ContentMax)
	if err != nil {
		return Settings{}, err
	}
	data := map[string]any{"title": title, "content": text}
	write := nosql.Write{Row: nosql.Row{PK: Partition, SK: Key, Version: current + 1, Data: data}, Expected: expected}
	if err := c.store.Transact(ctx, []nosql.Write{write}); err != nil {
		return Settings{}, err
	}
	return c.Settings(ctx)
}

// Feature exposes the home page and its settings (permission endpoints are mounted under
// /admin/app):
//
//	GET /                   guest       content.home   → {title, content}
//	GET /content/settings   permission  content.read   → Settings
//	PUT /content/settings   permission  content.write  {version, values: {title, content}} → Settings
func (c *Content) Feature() web.Feature {
	return web.Feature{
		ID: "content",
		Endpoints: []web.Endpoint{
			{Method: "GET", Path: "/", Access: web.Guest, Resource: "content.home", Handle: func(x *web.Context) (any, error) { return c.Home(x.Ctx) }},
			{Method: "GET", Path: "/content/settings", Access: web.Permission, Resource: "content.read", Handle: func(x *web.Context) (any, error) { return c.Settings(x.Ctx) }},
			{Method: "PUT", Path: "/content/settings", Access: web.Permission, Resource: "content.write", Handle: func(x *web.Context) (any, error) { return c.Save(x.Ctx, x.Request.Body) }},
		},
	}
}
