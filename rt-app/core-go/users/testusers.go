package users

import (
	"context"
	"net/http"
	"sort"

	"rt.local/core-go/apperr"
	"rt.local/core-go/internal/js"
	"rt.local/core-go/nosql"
)

// Test users (QA, demo and internal accounts) as stored on the USERS row: data.testUser. Only the
// boolean true marks a test user. The flag is a label for reports and filters: it never changes
// sign-in, bans, permissions or credits. See docs/polyglot/users-test-flag.md.

// IsTestUser reports whether a user row (its data) is marked as a test user.
func IsTestUser(data map[string]any) bool {
	v, ok := data["testUser"].(bool)
	return ok && v
}

// TestUserInput validates an optional testUser input: nil means "not given" (set false), a bool is
// returned with set true, anything else is 400 "Invalid field: testUser".
func TestUserInput(value any) (v bool, set bool, err error) {
	if value == nil {
		return false, false, nil
	}
	b, ok := value.(bool)
	if !ok {
		return false, false, apperr.BadRequest("Invalid field: testUser")
	}
	return b, true, nil
}

// TestUserFilter validates the ?testUser= list filter: absent, "", "true" or "false"; otherwise
// 400 "Invalid testUser filter".
func TestUserFilter(query map[string]string) error {
	v, ok := query["testUser"]
	if ok && v != "" && v != "true" && v != "false" {
		return apperr.BadRequest("Invalid testUser filter")
	}
	return nil
}

// TestUserIDs returns the sorted ids of every USERS row marked as a test user (deleted ones
// included), for reports that must exclude them (revenue, usage, economics).
func TestUserIDs(ctx context.Context, store nosql.Store) ([]string, error) {
	ids := []string{}
	cursor := ""
	for {
		page, err := store.List(ctx, "USERS", cursor)
		if err != nil {
			return nil, err
		}
		for _, row := range page.Items {
			if id, ok := row.Data["id"].(string); ok && IsTestUser(row.Data) {
				ids = append(ids, id)
			}
		}
		if page.Cursor == "" {
			sort.Strings(ids)
			return ids, nil
		}
		cursor = page.Cursor
	}
}

// Update is the administrator edit of an account (PATCH /users/:id): input {name?, testUser?}.
// 404 "User not found" for a missing or deleted user first; other keys are 400 "Only name and
// testUser can be edited; email requires verification"; name is validated when not null or when
// testUser is null/missing; then testUser. tokenVersion and the ban are kept. Returns the admin view.
func (u *Users) Update(ctx context.Context, id string, input map[string]any, actor string) (map[string]any, error) {
	row, err := u.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	if row == nil || js.Truthy(row.Data["deletedAt"]) {
		return nil, apperr.NotFound("User not found")
	}
	for key := range input {
		if key != "name" && key != "testUser" {
			return nil, apperr.New(http.StatusBadRequest, "Only name and testUser can be edited; email requires verification")
		}
	}
	patch := map[string]any{}
	if input["name"] != nil || input["testUser"] == nil {
		name, err := Text(input["name"], "name", 200)
		if err != nil {
			return nil, err
		}
		patch["name"] = name
	}
	testUser, set, err := TestUserInput(input["testUser"])
	if err != nil {
		return nil, err
	}
	if set {
		patch["testUser"] = testUser
	}
	next := *row
	next.Version++
	next.Data = With(row.Data, patch, AuditUpdate(actor, u.now()))
	if err := u.store.Transact(ctx, []nosql.Write{{Row: next, Expected: nosql.Expect(row.Version)}}); err != nil {
		return nil, err
	}
	return u.View(next.Data), nil
}
