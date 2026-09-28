// Package users stores local RT-App accounts in a nosql.Store, with the validation, password
// hashing, audit fields and storage format of the TypeScript reference (@gsalgadotoledo/rt-app-users).
//
// Rows: USERS/<id> (the account), EMAIL/<email> {id} (unique index, created in the same
// transaction) and INSTALLATION/owner {id} (first owner). See
// rt-app/spec/contracts/users.contract.yaml.
package users

import (
	"context"
	"net/http"
	"time"

	"rt.local/core-go/apperr"
	"rt.local/core-go/internal/js"
	"rt.local/core-go/internal/uuid"
	"rt.local/core-go/nosql"
	"rt.local/core-go/web"
)

// Roles.
const (
	RoleOwner = "owner"
	RoleAdmin = "admin"
	RoleUser  = "user"
)

// Users manages accounts. It is safe for concurrent use.
type Users struct {
	store nosql.Store
	now   func() time.Time
}

// Option configures Users.
type Option func(*Users)

// WithClock sets the clock of audit timestamps (default time.Now).
func WithClock(now func() time.Time) Option { return func(u *Users) { u.now = now } }

// New returns Users over store.
func New(store nosql.Store, options ...Option) *Users {
	u := &Users{store: store, now: time.Now}
	for _, option := range options {
		option(u)
	}
	return u
}

// Store returns the store the accounts live in (auth keeps its rows there too).
func (u *Users) Store() nosql.Store { return u.store }

// Get returns USERS/<id>, or nil.
func (u *Users) Get(ctx context.Context, id string) (*nosql.Row, error) {
	return u.store.Get(ctx, "USERS", id)
}

// ByEmail returns the user indexed under email exactly (callers normalize with
// EmailAddress), or nil. Deleted users keep their index and are returned.
func (u *Users) ByEmail(ctx context.Context, email string) (*nosql.Row, error) {
	index, err := u.store.Get(ctx, "EMAIL", email)
	if err != nil || index == nil {
		return nil, err
	}
	id, ok := index.Data["id"].(string)
	if !ok {
		return nil, nil
	}
	return u.Get(ctx, id)
}

// BootstrapOwner creates the first account as owner; 409 once any USERS row exists.
func (u *Users) BootstrapOwner(ctx context.Context, input map[string]any) (*nosql.Row, error) {
	page, err := u.store.List(ctx, "USERS", "")
	if err != nil {
		return nil, err
	}
	if len(page.Items) > 0 {
		return nil, apperr.New(http.StatusConflict, "The application already has users")
	}
	// The first owner is never a test user: the flag is set by administrators only.
	owner := make(map[string]any, len(input))
	for k, v := range input {
		if k != "testUser" {
			owner[k] = v
		}
	}
	return u.insert(ctx, owner, RoleOwner, true, "")
}

// Create validates input {email, name, password, testUser?} (testUser: a boolean, stored only when
// true; callers are administrators) and stores a new active account with role
// ("" means RoleUser). actor is recorded as creator; "" means the new user itself. A taken
// email is 409 "Conflict: refresh and try again".
func (u *Users) Create(ctx context.Context, input map[string]any, role, actor string) (*nosql.Row, error) {
	if role == "" {
		role = RoleUser
	}
	return u.insert(ctx, input, role, false, actor)
}

func (u *Users) insert(ctx context.Context, input map[string]any, role string, bootstrap bool, actor string) (*nosql.Row, error) {
	email, err := EmailAddress(input["email"])
	if err != nil {
		return nil, err
	}
	name, err := Text(input["name"], "name", 200)
	if err != nil {
		return nil, err
	}
	hash, err := HashPassword(input["password"])
	if err != nil {
		return nil, err
	}
	testUser, _, err := TestUserInput(input["testUser"])
	if err != nil {
		return nil, err
	}
	id := uuid.New()
	if actor == "" {
		actor = id
	}
	data := map[string]any{"id": id, "email": email, "name": name, "passwordHash": hash, "role": role,
		"grants": []any{}, "active": true, "tokenVersion": 1}
	if testUser {
		data["testUser"] = true
	}
	for k, v := range AuditCreate(actor, u.now()) {
		data[k] = v
	}
	row := nosql.Row{PK: "USERS", SK: id, Version: 1, Data: data}
	var writes []nosql.Write
	if bootstrap {
		writes = append(writes, nosql.Write{Row: nosql.Row{PK: "INSTALLATION", SK: "owner", Version: 1, Data: map[string]any{"id": id}}})
	}
	writes = append(writes,
		nosql.Write{Row: row},
		nosql.Write{Row: nosql.Row{PK: "EMAIL", SK: email, Version: 1, Data: map[string]any{"id": id}}})
	if err := u.store.Transact(ctx, writes); err != nil {
		return nil, err
	}
	return u.store.Get(ctx, "USERS", id)
}

// Profile edits the name of an account (trimmed) and returns its public view. Only "name"
// may be sent: email changes need the verified flow of package auth. actor "" means id.
func (u *Users) Profile(ctx context.Context, id string, input map[string]any, actor string) (map[string]any, error) {
	row, err := u.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	if row == nil || js.Truthy(row.Data["deletedAt"]) {
		return nil, apperr.NotFound("User not found")
	}
	for key := range input {
		if key != "name" {
			return nil, apperr.BadRequest("Only name can be edited; email requires verification")
		}
	}
	name, err := Text(input["name"], "name", 200)
	if err != nil {
		return nil, err
	}
	if actor == "" {
		actor = id
	}
	next := *row
	next.Version++
	next.Data = With(row.Data, map[string]any{"name": name}, AuditUpdate(actor, u.now()))
	if err := u.store.Transact(ctx, []nosql.Write{{Row: next, Expected: nosql.Expect(row.Version)}}); err != nil {
		return nil, err
	}
	return ViewUser(next.Data), nil
}

// With returns a copy of row data with the fields of each patch applied in order, like the
// reference's {...data, ...patch} spreads.
func With(data map[string]any, patches ...map[string]any) map[string]any {
	out := make(map[string]any, len(data)+4)
	for k, v := range data {
		out[k] = v
	}
	for _, patch := range patches {
		for k, v := range patch {
			out[k] = v
		}
	}
	return out
}

// ISOTime formats t like JavaScript's Date.prototype.toISOString (milliseconds, UTC, Z).
func ISOTime(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

// AuditCreate returns the audit fields of a new row.
func AuditCreate(actor string, at time.Time) map[string]any {
	now := ISOTime(at)
	return map[string]any{"createdAt": now, "createdBy": actor, "updatedAt": now, "updatedBy": actor, "deletedAt": nil, "deletedBy": nil}
}

// AuditUpdate returns the audit fields of an edit.
func AuditUpdate(actor string, at time.Time) map[string]any {
	return map[string]any{"updatedAt": ISOTime(at), "updatedBy": actor}
}

// AuditDelete returns the audit fields of a soft delete.
func AuditDelete(actor string, at time.Time) map[string]any {
	now := ISOTime(at)
	return map[string]any{"updatedAt": now, "updatedBy": actor, "deletedAt": now, "deletedBy": actor}
}

// AuditRestore returns the audit fields of a restore.
func AuditRestore(actor string, at time.Time) map[string]any {
	now := ISOTime(at)
	return map[string]any{"updatedAt": now, "updatedBy": actor, "deletedAt": nil, "deletedBy": nil, "restoredAt": now, "restoredBy": actor}
}

var auditFields = []string{"createdAt", "createdBy", "updatedAt", "updatedBy", "deletedAt", "deletedBy", "restoredAt", "restoredBy"}

// PublicUser is the session actor of a USERS row: {id, email, name, role, grants,
// tokenVersion, active}, values copied as stored.
func PublicUser(data map[string]any) map[string]any {
	return map[string]any{"id": data["id"], "email": data["email"], "name": data["name"], "role": data["role"],
		"grants": data["grants"], "tokenVersion": data["tokenVersion"], "active": data["active"]}
}

// ViewUser is the public view of a USERS row: PublicUser without tokenVersion, plus the audit
// fields (null when absent). It never contains passwordHash.
func ViewUser(data map[string]any) map[string]any {
	view := PublicUser(data)
	delete(view, "tokenVersion")
	for _, field := range auditFields {
		view[field] = data[field]
	}
	return view
}

// Actor converts a USERS row to the web actor of its session.
func Actor(data map[string]any) *web.Actor {
	actor := &web.Actor{Grants: []string{}}
	actor.ID, _ = data["id"].(string)
	actor.Email, _ = data["email"].(string)
	actor.Name, _ = data["name"].(string)
	actor.Role, _ = data["role"].(string)
	actor.Active = js.Truthy(data["active"])
	if v, ok := js.Integer(data["tokenVersion"]); ok {
		actor.TokenVersion = int(v)
	}
	if grants, ok := data["grants"].([]any); ok {
		for _, g := range grants {
			if s, ok := g.(string); ok {
				actor.Grants = append(actor.Grants, s)
			}
		}
	}
	return actor
}

// ActorView is the public view of a session actor (GET /users/me): the actor's profile with
// null audit fields, as the reference's viewUser(actor).
func ActorView(actor *web.Actor) map[string]any {
	grants := make([]any, len(actor.Grants))
	for i, g := range actor.Grants {
		grants[i] = g
	}
	return ViewUser(map[string]any{"id": actor.ID, "email": actor.Email, "name": actor.Name, "role": actor.Role, "grants": grants, "active": actor.Active})
}
