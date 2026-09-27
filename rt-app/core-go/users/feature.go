package users

import (
	"context"
	"net/http"
	"slices"
	"strings"

	"rt.local/core-go/apperr"
	"rt.local/core-go/internal/js"
	"rt.local/core-go/nosql"
	"rt.local/core-go/web"
)

// Feature exposes the account endpoints of the reference, with its paths and access levels
// (permission endpoints are mounted under /admin/app by package web):
//
//	GET    /users/me             authenticated  users.me.read   the caller's view
//	PATCH  /users/me             authenticated  users.me.edit   {name}
//	GET    /users                permission     users.list      ?id&email&name&role&active&banned&trash&cursor
//	POST   /users                permission     users.create    {email, name, password}
//	GET    /users/:id            permission     users.read      the admin view (ViewAccount: banned, ban)
//	PATCH  /users/:id            permission     users.edit      {name}; owners only for an owner
//	POST   /users/:id/restore    permission     users.restore
//	DELETE /users/:id            permission     users.delete    soft delete; revokes sessions
func (u *Users) Feature() web.Feature {
	return web.Feature{ID: "users", Endpoints: []web.Endpoint{
		{Method: "GET", Path: "/users/me", Resource: "users.me.read", Access: web.Authenticated, Handle: func(c *web.Context) (any, error) {
			return ActorView(c.Actor), nil
		}},
		{Method: "PATCH", Path: "/users/me", Resource: "users.me.edit", Access: web.Authenticated, Handle: func(c *web.Context) (any, error) {
			return u.Profile(c.Ctx, c.Actor.ID, c.Request.Body, "")
		}},
		{Method: "GET", Path: "/users", Resource: "users.list", Access: web.Permission, Handle: func(c *web.Context) (any, error) {
			return SearchPage(c.Ctx, u.store, "USERS", c.Request.Query, []string{"id", "email", "name", "role", "active", "banned"},
				func(row nosql.Row) map[string]any { return u.View(row.Data) })
		}},
		{Method: "POST", Path: "/users", Resource: "users.create", Access: web.Permission, Handle: func(c *web.Context) (any, error) {
			row, err := u.Create(c.Ctx, c.Request.Body, RoleUser, c.Actor.ID)
			if err != nil {
				return nil, err
			}
			return ViewUser(row.Data), nil
		}},
		{Method: "GET", Path: "/users/:id", Resource: "users.read", Access: web.Permission, Handle: func(c *web.Context) (any, error) {
			row, err := u.live(c.Ctx, c.Params["id"])
			if err != nil {
				return nil, err
			}
			return u.View(row.Data), nil
		}},
		{Method: "PATCH", Path: "/users/:id", Resource: "users.edit", Access: web.Permission, Handle: func(c *web.Context) (any, error) {
			row, err := u.Get(c.Ctx, c.Params["id"])
			if err != nil {
				return nil, err
			}
			if row != nil && row.Data["role"] == RoleOwner && c.Actor.Role != RoleOwner {
				return nil, apperr.New(http.StatusForbidden, "Owner role required")
			}
			return u.Profile(c.Ctx, c.Params["id"], c.Request.Body, c.Actor.ID)
		}},
		{Method: "POST", Path: "/users/:id/restore", Resource: "users.restore", Access: web.Permission, Handle: func(c *web.Context) (any, error) {
			row, err := u.Get(c.Ctx, c.Params["id"])
			if err != nil {
				return nil, err
			}
			if row == nil || !js.Truthy(row.Data["deletedAt"]) {
				return nil, apperr.NotFound("Deleted user not found")
			}
			next := *row
			next.Version++
			next.Data = With(row.Data, AuditRestore(c.Actor.ID, u.now()), map[string]any{
				"active": !js.Truthy(row.Data["provisioning"]), "tokenVersion": js.Add(row.Data["tokenVersion"], 1)})
			if err := u.store.Transact(c.Ctx, []nosql.Write{{Row: next, Expected: nosql.Expect(row.Version)}}); err != nil {
				return nil, err
			}
			return ViewUser(next.Data), nil
		}},
		{Method: "DELETE", Path: "/users/:id", Resource: "users.delete", Access: web.Permission, Handle: func(c *web.Context) (any, error) {
			row, err := u.live(c.Ctx, c.Params["id"])
			if err != nil {
				return nil, err
			}
			if row.Data["role"] == RoleOwner || js.Equal(row.Data["id"], c.Actor.ID) {
				return nil, apperr.New(http.StatusForbidden, "You cannot deactivate this account")
			}
			next := *row
			next.Version++
			next.Data = With(row.Data, AuditDelete(c.Actor.ID, u.now()), map[string]any{
				"active": false, "tokenVersion": js.Add(row.Data["tokenVersion"], 1)})
			if err := u.store.Transact(c.Ctx, []nosql.Write{{Row: next, Expected: nosql.Expect(row.Version)}}); err != nil {
				return nil, err
			}
			return map[string]bool{"ok": true}, nil
		}},
	}}
}

// live returns a user that exists and is not deleted, or 404 "User not found".
func (u *Users) live(ctx context.Context, id string) (*nosql.Row, error) {
	row, err := u.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	if row == nil || js.Truthy(row.Data["deletedAt"]) {
		return nil, apperr.NotFound("User not found")
	}
	return row, nil
}

// Page is one page of a search: the matching items and the cursor to continue from.
type Page struct {
	Items  []map[string]any `json:"items"`
	Cursor string           `json:"cursor,omitempty"`
}

// SearchPage lists partition pk with query filters (case-insensitive substrings on fields),
// "trash" ("true" lists deleted rows) and "cursor". It inspects up to 10 store pages and
// stops at the first one with matches, keeping the cursor when more data remains.
func SearchPage(ctx context.Context, store nosql.Store, pk string, query map[string]string, fields []string, project func(nosql.Row) map[string]any) (Page, error) {
	trash, hasTrash := query["trash"]
	if hasTrash && trash != "true" && trash != "false" {
		return Page{}, apperr.BadRequest("Invalid trash filter")
	}
	filters := make(map[string]string, len(query))
	for k, v := range query {
		if k != "trash" {
			filters[k] = v
		}
	}
	if _, err := Filtered(nil, filters, fields); err != nil { // validate even for empty collections
		return Page{}, err
	}
	cursor := query["cursor"]
	for inspected := 0; inspected < 10; inspected++ {
		page, err := store.List(ctx, pk, cursor)
		if err != nil {
			return Page{}, err
		}
		var rows []map[string]any
		for _, row := range page.Items {
			if js.Truthy(row.Data["deletedAt"]) == (trash == "true") {
				if item := project(row); item != nil {
					rows = append(rows, item)
				}
			}
		}
		items, _ := Filtered(rows, filters, fields)
		cursor = page.Cursor
		if len(items) > 0 || cursor == "" {
			return Page{Items: items, Cursor: cursor}, nil
		}
	}
	return Page{Items: []map[string]any{}, Cursor: cursor}, nil
}

// Filtered keeps the items whose fields contain the query values (case-insensitive
// substrings; empty values are ignored). Query names other than fields and "cursor" are
// 400 "Unsupported filter: <name>" (the first in code point order when several).
func Filtered(items []map[string]any, query map[string]string, fields []string) ([]map[string]any, error) {
	names := make([]string, 0, len(query))
	for name := range query {
		names = append(names, name)
	}
	slices.Sort(names)
	for _, name := range names {
		if name != "cursor" && !slices.Contains(fields, name) {
			return nil, apperr.BadRequest("Unsupported filter: " + name)
		}
	}
	out := make([]map[string]any, 0, len(items))
	for _, item := range items {
		if matches(item, query, fields) {
			out = append(out, item)
		}
	}
	return out, nil
}

func matches(item map[string]any, query map[string]string, fields []string) bool {
	for _, field := range fields {
		want := query[field]
		if want == "" {
			continue
		}
		value := ""
		if v := item[field]; v != nil {
			value = js.String(v)
		}
		if !strings.Contains(js.ToLower(value), js.ToLower(want)) {
			return false
		}
	}
	return true
}
