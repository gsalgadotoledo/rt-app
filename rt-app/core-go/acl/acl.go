// Package acl is the RT-App endpoint access policy (roles and grants) and the owner-only
// delegation endpoint, ported from @gsalgadotoledo/rt-app-acl. See
// rt-app/spec/contracts/acl.contract.yaml.
package acl

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"time"

	"rt.local/core-go/apperr"
	"rt.local/core-go/internal/js"
	"rt.local/core-go/nosql"
	"rt.local/core-go/users"
	"rt.local/core-go/web"
)

// MaxGrants is the largest grants list Assign accepts (before de-duplication).
const MaxGrants = 100

// Messages of the policy.
const (
	msgSignIn    = "Sign in"
	msgForbidden = "You do not have permission to access this resource"
	msgOwnerOnly = "Only the owner can perform this operation"
	msgDelegate  = "Only the owner can assign permissions"
)

// Endpoint is what the policy knows about a registered endpoint.
type Endpoint struct {
	Resource string `json:"resource"`
	Method   string `json:"method"`
	Path     string `json:"path"`
	Access   string `json:"access"`
	// ExplicitGrant requires the grant even for owners.
	ExplicitGrant bool `json:"-"`
}

// Endpoints lists the endpoints of features, the resources Assign may grant.
func Endpoints(features ...web.Feature) []Endpoint {
	var out []Endpoint
	for _, f := range features {
		for _, e := range f.Endpoints {
			out = append(out, Endpoint{Resource: e.Resource, Method: e.Method, Path: e.Path, Access: e.Access})
		}
	}
	return out
}

// ACL checks access and delegates grants. It is safe for concurrent use.
type ACL struct {
	store     nosql.Store
	resources func() []Endpoint
	now       func() time.Time
}

// Option configures an ACL.
type Option func(*ACL)

// WithClock sets the clock of audit timestamps (default time.Now).
func WithClock(now func() time.Time) Option { return func(a *ACL) { a.now = now } }

// New returns an ACL over the users in store; resources lists the registered endpoints
// (read on each use, so features registered later are included).
func New(store nosql.Store, resources func() []Endpoint, options ...Option) *ACL {
	a := &ACL{store: store, resources: resources, now: time.Now}
	for _, option := range options {
		option(a)
	}
	return a
}

// Allows reports whether actor may use resource: owners always; others need the exact grant
// (no wildcards, case-sensitive; admin has no implicit rights; Active is not consulted).
func (a *ACL) Allows(actor *web.Actor, resource string) bool {
	return actor != nil && (actor.Role == users.RoleOwner || slices.Contains(actor.Grants, resource))
}

// Check enforces endpoint's access for actor (nil when anonymous): guest passes; an unknown
// access level fails closed (403, even for owners); then 401 "Sign in" without an actor;
// owner endpoints need role owner; permission endpoints need Allows (or the exact grant when
// ExplicitGrant); authenticated endpoints accept any actor.
func (a *ACL) Check(endpoint Endpoint, actor *web.Actor) error {
	switch endpoint.Access {
	case web.Guest:
		return nil
	case web.Authenticated, web.Permission, web.Owner:
	default:
		return apperr.New(http.StatusForbidden, msgForbidden)
	}
	if actor == nil {
		return apperr.New(http.StatusUnauthorized, msgSignIn)
	}
	if endpoint.Access == web.Owner && actor.Role != users.RoleOwner {
		return apperr.New(http.StatusForbidden, msgOwnerOnly)
	}
	if endpoint.Access == web.Permission {
		allowed := a.Allows(actor, endpoint.Resource)
		if endpoint.ExplicitGrant {
			allowed = slices.Contains(actor.Grants, endpoint.Resource)
		}
		if !allowed {
			return apperr.New(http.StatusForbidden, msgForbidden)
		}
	}
	return nil
}

// Resources lists {resource, method, path, access} of every registered endpoint, filtered by
// query (case-insensitive substrings on those fields; "cursor" is ignored; other names are
// 400 "Unsupported filter: <name>").
func (a *ACL) Resources(query map[string]string) ([]map[string]any, error) {
	all := a.resources()
	items := make([]map[string]any, len(all))
	for i, r := range all {
		items[i] = map[string]any{"resource": r.Resource, "method": r.Method, "path": r.Path, "access": r.Access}
	}
	return users.Filtered(items, query, []string{"resource", "method", "path", "access"})
}

// Assign sets the role ("user" or "admin") and grants of user id, revoking their sessions
// (tokenVersion+1), and returns the public view. Only owners delegate; the target must exist,
// not be deleted and not be the owner; every grant must name a registered permission
// endpoint and there may be at most MaxGrants (400 "Invalid permissions or role").
func (a *ACL) Assign(ctx context.Context, id string, body map[string]any, actor *web.Actor) (map[string]any, error) {
	if actor == nil {
		return nil, errors.New("acl: Assign needs an actor")
	}
	if actor.Role != users.RoleOwner {
		return nil, apperr.New(http.StatusForbidden, msgDelegate)
	}
	row, err := a.store.Get(ctx, "USERS", id)
	if err != nil {
		return nil, err
	}
	if row == nil || js.Truthy(row.Data["deletedAt"]) {
		return nil, apperr.NotFound("User not found")
	}
	if row.Data["role"] == users.RoleOwner {
		return nil, apperr.New(http.StatusForbidden, "The owner cannot be modified through this endpoint")
	}
	grants, ok := a.grants(body["grants"])
	role, _ := body["role"].(string)
	if !ok || role != users.RoleUser && role != users.RoleAdmin {
		return nil, apperr.BadRequest("Invalid permissions or role")
	}
	next := *row
	next.Version++
	next.Data = users.With(row.Data, users.AuditUpdate(actor.ID, a.now()), map[string]any{
		"role": role, "grants": grants, "tokenVersion": js.Add(row.Data["tokenVersion"], 1)})
	if err := a.store.Transact(ctx, []nosql.Write{{Row: next, Expected: nosql.Expect(row.Version)}}); err != nil {
		return nil, err
	}
	return users.ViewUser(next.Data), nil
}

// grants validates a grants list and de-duplicates it in first-seen order.
func (a *ACL) grants(value any) ([]any, bool) {
	list, ok := value.([]any)
	if !ok || len(list) > MaxGrants {
		return nil, false
	}
	valid := map[string]bool{}
	for _, r := range a.resources() {
		if r.Access == web.Permission {
			valid[r.Resource] = true
		}
	}
	seen := map[string]bool{}
	out := []any{}
	for _, item := range list {
		g, ok := item.(string)
		if !ok || !valid[g] {
			return nil, false
		}
		if !seen[g] {
			seen[g] = true
			out = append(out, g)
		}
	}
	return out, true
}

// Feature exposes resource discovery and owner-only delegation (both mounted under
// /admin/app as permission endpoints):
//
//	GET /acl/resources      acl.resources  ?resource&method&path&access
//	PUT /acl/users/:id      acl.assign     {role, grants}
func (a *ACL) Feature() web.Feature {
	return web.Feature{ID: "acl", Endpoints: []web.Endpoint{
		{Method: "GET", Path: "/acl/resources", Resource: "acl.resources", Access: web.Permission, Handle: func(c *web.Context) (any, error) {
			return a.Resources(c.Request.Query)
		}},
		{Method: "PUT", Path: "/acl/users/:id", Resource: "acl.assign", Access: web.Permission, Handle: func(c *web.Context) (any, error) {
			return a.Assign(c.Ctx, c.Params["id"], c.Request.Body, c.Actor)
		}},
	}}
}
