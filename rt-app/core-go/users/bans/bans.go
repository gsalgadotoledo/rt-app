// Package bans is account bans as an extension of package users (the Go port of
// @gsalgadotoledo/rt-app-users-bans). The ban lives on the user row (USERS/<id>.data.ban, read by
// users.ActiveBan and enforced by package auth on every sign-in, refresh and request); this package
// writes it, keeps the append-only history and serves the admin endpoints:
//
//	USERS/<id>                                        data.ban = {reason, category, until, at, by} | null
//	USER_BANS#<userId>/pad15(atMs)-pad10(user version) {userId, action: ban|update|unban, reason,
//	                                                   category, until, actorId, at}
//
// Row formats and algorithms: rt-app/docs/polyglot/users-bans.md and
// spec/contracts/users-bans.contract.yaml.
package bans

import (
	"context"
	"fmt"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"time"

	"rt.local/core-go/apperr"
	"rt.local/core-go/internal/js"
	"rt.local/core-go/nosql"
	"rt.local/core-go/users"
	"rt.local/core-go/web"
)

// RootActor is the admin root principal (ADMIN_PASSWORD). Only it can ban or unban an owner.
const RootActor = "rt-app-root"

// SessionReason is the revocation reason written on the refresh sessions a ban ends.
const SessionReason = "ban"

// attempts bounds the version-conflict retries of a ban write.
const attempts = 4

var category = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,39}$`)

// Partition is the partition of a user's ban history: USER_BANS#<userId>.
func Partition(userID string) string { return "USER_BANS#" + userID }

// SessionRevoker ends the refresh sessions of a user (auth.Auth.RevokeAll).
type SessionRevoker interface {
	RevokeAll(ctx context.Context, userID, reason string) (int, error)
}

// Bans bans and unbans the accounts of a users.Users. It is safe for concurrent use.
type Bans struct {
	users    *users.Users
	store    nosql.Store
	now      func() time.Time
	sessions SessionRevoker
}

// Option configures Bans.
type Option func(*Bans)

// WithClock sets the clock (default: the users clock). Share it with auth.
func WithClock(now func() time.Time) Option { return func(b *Bans) { b.now = now } }

// WithSessions marks the user's refresh sessions revoked ("ban") after a ban is stored.
func WithSessions(sessions SessionRevoker) Option { return func(b *Bans) { b.sessions = sessions } }

// New returns Bans over accounts.
func New(accounts *users.Users, options ...Option) *Bans {
	b := &Bans{users: accounts, store: accounts.Store(), now: accounts.Now}
	for _, option := range options {
		option(b)
	}
	return b
}

// HistoryItem is one audit row, as GET /users/:id/bans returns it.
type HistoryItem struct {
	ID       string `json:"id"`
	UserID   any    `json:"userId"`
	Action   any    `json:"action"`
	Reason   any    `json:"reason"`
	Category any    `json:"category"`
	Until    any    `json:"until"`
	ActorID  any    `json:"actorId"`
	At       any    `json:"at"`
}

// History is the response of GET /users/:id/bans.
type History struct {
	Items []HistoryItem `json:"items"`
}

// Reason validates a required reason: a string whose JavaScript trim() has 3 to 500 UTF-16
// units (400 otherwise); it returns the trimmed text.
func Reason(value any) (string, error) {
	s, _ := value.(string)
	reason := js.Trim(s)
	if n := js.Len(reason); n < 3 || n > 500 {
		return "", apperr.BadRequest("A reason of 3 to 500 characters is required")
	}
	return reason, nil
}

// Until validates the optional end of a temporary ban: nil is permanent (nil); otherwise a strict
// ISO 8601 instant (users.ParseInstant) after nowMs, returned normalized (milliseconds, Z).
func Until(value any, nowMs int64) (any, error) {
	if value == nil {
		return nil, nil
	}
	ms, ok := users.ParseInstant(value)
	if !ok {
		return nil, apperr.BadRequest("Invalid until: use an ISO 8601 date and time")
	}
	if ms <= nowMs {
		return nil, apperr.BadRequest("until must be in the future")
	}
	return users.ISOTime(time.UnixMilli(ms)), nil
}

// Category validates the optional label: nil → nil; else ^[a-z][a-z0-9_-]{0,39}$ or 400.
func Category(value any) (any, error) {
	if value == nil {
		return nil, nil
	}
	if s, ok := value.(string); ok && category.MatchString(s) {
		return s, nil
	}
	return nil, apperr.BadRequest("Invalid category")
}

// target returns a user that exists and is not deleted; ids that are not short strings are never read.
func (b *Bans) target(ctx context.Context, userID any) (*nosql.Row, error) {
	id, ok := userID.(string)
	if !ok || js.Len(id) > 100 {
		return nil, apperr.NotFound("User not found")
	}
	row, err := b.users.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	if row == nil || js.Truthy(row.Data["deletedAt"]) {
		return nil, apperr.NotFound("User not found")
	}
	return row, nil
}

// authorize: never yourself; an owner only by the admin root; an administrator only by an owner.
func authorize(row *nosql.Row, actor *web.Actor, verb string) error {
	switch {
	case js.Equal(row.Data["id"], actor.ID):
		return apperr.New(http.StatusForbidden, "You cannot "+verb+" your own account")
	case row.Data["role"] == users.RoleOwner && actor.ID != RootActor:
		return apperr.New(http.StatusForbidden, "Only the admin root can "+verb+" an owner")
	case row.Data["role"] == users.RoleAdmin && actor.Role != users.RoleOwner:
		return apperr.New(http.StatusForbidden, "Only an owner can "+verb+" an administrator")
	}
	return nil
}

// change computes the next user data and the audit fields of a write.
type change func(row *nosql.Row, nowMs int64) (data map[string]any, audit map[string]any, err error)

// write stores the next user row and its audit row in one transaction (both or neither),
// re-reading and re-checking the user on a conflict (4 attempts, then 409).
func (b *Bans) write(ctx context.Context, userID any, actor *web.Actor, verb string, next change) (*nosql.Row, int64, error) {
	for range attempts {
		row, err := b.target(ctx, userID)
		if err != nil {
			return nil, 0, err
		}
		if err := authorize(row, actor, verb); err != nil {
			return nil, 0, err
		}
		at := b.now()
		nowMs := at.UnixMilli()
		data, audit, err := next(row, nowMs)
		if err != nil {
			return nil, 0, err
		}
		updated := *row
		updated.Version++
		updated.Data = users.With(data, users.AuditUpdate(actor.ID, at))
		history := nosql.Row{
			PK: Partition(js.String(row.Data["id"])), SK: fmt.Sprintf("%015d-%010d", nowMs, updated.Version), Version: 1,
			Data: users.With(map[string]any{"userId": row.Data["id"]}, audit, map[string]any{"actorId": actor.ID, "at": users.ISOTime(at)}),
		}
		err = b.store.Transact(ctx, []nosql.Write{{Row: updated, Expected: nosql.Expect(row.Version)}, {Row: history}})
		if err == nil {
			return &updated, nowMs, nil
		}
		if !apperr.IsConflict(err) {
			return nil, 0, err
		}
	}
	return nil, 0, apperr.Conflict()
}

// Ban bans (suspends) an account at once and returns its admin view. Validates reason, until and
// category (400), then the user (404) and who may ban them (403). One transaction writes data.ban,
// tokenVersion + 1 and the audit row (action "ban", or "update" when a ban was already in force:
// re-banning replaces reason, until and category); then the live refresh sessions are revoked.
func (b *Bans) Ban(ctx context.Context, userID any, input map[string]any, actor *web.Actor) (map[string]any, error) {
	reason, err := Reason(input["reason"])
	if err != nil {
		return nil, err
	}
	until, err := Until(input["until"], b.now().UnixMilli())
	if err != nil {
		return nil, err
	}
	cat, err := Category(input["category"])
	if err != nil {
		return nil, err
	}
	row, nowMs, err := b.write(ctx, userID, actor, "ban", func(row *nosql.Row, nowMs int64) (map[string]any, map[string]any, error) {
		action := "ban"
		if users.ActiveBan(row.Data, nowMs) != nil {
			action = "update"
		}
		ban := map[string]any{"reason": reason, "category": cat, "until": until, "at": users.ISOTime(time.UnixMilli(nowMs)), "by": actor.ID}
		data := users.With(row.Data, map[string]any{"ban": ban, "tokenVersion": js.Add(row.Data["tokenVersion"], 1)})
		return data, map[string]any{"action": action, "reason": reason, "category": cat, "until": until}, nil
	})
	if err != nil {
		return nil, err
	}
	// The tokenVersion bump already cut every session; this records why on each session row.
	if b.sessions != nil {
		if _, err := b.sessions.RevokeAll(ctx, js.String(row.Data["id"]), SessionReason); err != nil {
			return nil, err
		}
	}
	return users.ViewAccount(row.Data, nowMs), nil
}

// Unban lifts the ban in force (409 "User is not banned" otherwise, also once a temporary ban
// expired) and returns the admin view. data.ban = null and an "unban" audit row; tokenVersion is
// not changed, so sessions ended by the ban stay ended.
func (b *Bans) Unban(ctx context.Context, userID any, input map[string]any, actor *web.Actor) (map[string]any, error) {
	reason, err := Reason(input["reason"])
	if err != nil {
		return nil, err
	}
	row, nowMs, err := b.write(ctx, userID, actor, "unban", func(row *nosql.Row, nowMs int64) (map[string]any, map[string]any, error) {
		if users.ActiveBan(row.Data, nowMs) == nil {
			return nil, nil, apperr.New(http.StatusConflict, "User is not banned")
		}
		return users.With(row.Data, map[string]any{"ban": nil}),
			map[string]any{"action": "unban", "reason": reason, "category": nil, "until": nil}, nil
	})
	if err != nil {
		return nil, err
	}
	return users.ViewAccount(row.Data, nowMs), nil
}

// History returns the append-only history of a user, newest first; 404 when the user row does
// not exist (deleted users keep their history).
func (b *Bans) History(ctx context.Context, userID any) (History, error) {
	id, ok := userID.(string)
	if !ok || js.Len(id) > 100 {
		return History{}, apperr.NotFound("User not found")
	}
	row, err := b.users.Get(ctx, id)
	if err != nil {
		return History{}, err
	}
	if row == nil {
		return History{}, apperr.NotFound("User not found")
	}
	var rows []nosql.Row
	cursor := ""
	for {
		page, err := b.store.List(ctx, Partition(id), cursor)
		if err != nil {
			return History{}, err
		}
		rows = append(rows, page.Items...)
		if cursor = page.Cursor; cursor == "" {
			break
		}
	}
	slices.SortFunc(rows, func(x, y nosql.Row) int { return strings.Compare(y.SK, x.SK) })
	items := make([]HistoryItem, 0, len(rows))
	for _, r := range rows {
		items = append(items, HistoryItem{ID: r.SK, UserID: r.Data["userId"], Action: r.Data["action"], Reason: r.Data["reason"],
			Category: r.Data["category"], Until: r.Data["until"], ActorID: r.Data["actorId"], At: r.Data["at"]})
	}
	return History{Items: items}, nil
}

// Tools is the CLI/MCP metadata of the endpoints (the TypeScript reference's text).
var Tools = map[string]*web.Tool{
	"users_ban": {Name: "users_ban",
		Description: "Suspend an application account at once: its sessions and access tokens stop working and sign-in, codes and refresh answer 403 Account suspended. params.id and body.reason (3-500 characters, kept in the admin history, never shown to the user) are required; body.until (ISO 8601, in the future) makes the ban temporary and it lifts by itself at that instant; body.category is an optional label (^[a-z][a-z0-9_-]{0,39}$). Banning a banned account replaces reason, until and category (history action update). Owners can be banned only by the admin root, administrators only by owners; nobody bans themselves.",
		Example:     map[string]any{"params": map[string]any{"id": "user-123"}, "body": map[string]any{"reason": "Chargeback fraud reported by the bank", "until": "2026-12-31T00:00:00Z", "category": "fraud"}}},
	"users_unban": {Name: "users_unban",
		Description: "Lift the ban in force on an application account (409 when it is not banned, also after a temporary ban expired). params.id and body.reason (3-500 characters) are required. Sessions ended by the ban stay ended: the user signs in again.",
		Example:     map[string]any{"params": map[string]any{"id": "user-123"}, "body": map[string]any{"reason": "Bank confirmed the payment"}}},
	"users_bans": {Name: "users_bans",
		Description: "Ban history of an application account, newest first: {items: [{id, userId, action (ban | update | unban), reason, category, until, actorId, at}]}. Append-only. params.id is required.",
		Example:     map[string]any{"params": map[string]any{"id": "user-123"}}},
}

// Feature exposes the endpoints (permission endpoints are also mounted under /admin/app):
//
//	POST /users/:id/ban     permission  users.ban        {reason, until?, category?}
//	POST /users/:id/unban   permission  users.ban        {reason}
//	GET  /users/:id/bans    permission  users.bans.read  → {items}
func (b *Bans) Feature() web.Feature {
	return web.Feature{ID: "users-bans", Endpoints: []web.Endpoint{
		{Method: "POST", Path: "/users/:id/ban", Resource: "users.ban", Access: web.Permission, Tool: Tools["users_ban"], Handle: func(c *web.Context) (any, error) {
			return b.Ban(c.Ctx, c.Params["id"], c.Request.Body, c.Actor)
		}},
		{Method: "POST", Path: "/users/:id/unban", Resource: "users.ban", Access: web.Permission, Tool: Tools["users_unban"], Handle: func(c *web.Context) (any, error) {
			return b.Unban(c.Ctx, c.Params["id"], c.Request.Body, c.Actor)
		}},
		{Method: "GET", Path: "/users/:id/bans", Resource: "users.bans.read", Access: web.Permission, Tool: Tools["users_bans"], Handle: func(c *web.Context) (any, error) {
			return b.History(c.Ctx, c.Params["id"])
		}},
	}}
}
