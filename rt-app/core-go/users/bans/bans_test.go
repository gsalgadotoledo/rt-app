package bans_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"rt.local/core-go/apperr"
	"rt.local/core-go/auth"
	"rt.local/core-go/jwt"
	"rt.local/core-go/nosql"
	"rt.local/core-go/users"
	"rt.local/core-go/users/bans"
	"rt.local/core-go/web"
)

const (
	secret   = "users-bans-test-secret-users-bans-test-secret"
	password = "correct horse battery"
)

var root = &web.Actor{ID: bans.RootActor, Role: users.RoleOwner}

type fixture struct {
	store    nosql.Store
	accounts *users.Users
	auth     *auth.Auth
	bans     *bans.Bans
	now      *time.Time
	mail     *auth.LocalMailbox
}

func setup(t *testing.T, store nosql.Store) *fixture {
	t.Helper()
	now := time.Date(2026, 3, 1, 10, 0, 0, 0, time.UTC)
	f := &fixture{store: store, now: &now, mail: &auth.LocalMailbox{}}
	clock := func() time.Time { return *f.now }
	tokens, err := jwt.New(secret, jwt.WithClock(clock))
	if err != nil {
		t.Fatal(err)
	}
	f.accounts = users.New(store, users.WithClock(clock))
	f.auth = auth.New(f.accounts, tokens, f.mail, secret, auth.WithClock(clock))
	f.bans = bans.New(f.accounts, bans.WithClock(clock), bans.WithSessions(f.auth))
	return f
}

func (f *fixture) make(t *testing.T, email, role string) map[string]any {
	t.Helper()
	row, err := f.accounts.Create(context.Background(), map[string]any{"name": strings.Split(email, "@")[0], "email": email, "password": password}, role, "")
	if err != nil {
		t.Fatal(err)
	}
	return row.Data
}

func wantError(t *testing.T, err error, status int, message string) {
	t.Helper()
	e, ok := apperr.As(err)
	if !ok || e.Status != status || e.Message != message {
		t.Fatalf("want %d %q, got %v", status, message, err)
	}
}

func TestValidation(t *testing.T) {
	now := time.Date(2026, 3, 1, 10, 0, 0, 0, time.UTC).UnixMilli()
	if r, err := bans.Reason("  abc  "); r != "abc" || err != nil {
		t.Fatal(r, err)
	}
	if r, err := bans.Reason(strings.Repeat("😀", 250)); err != nil || r == "" {
		t.Fatal("250 emoji are 500 UTF-16 units", err)
	}
	for _, bad := range []any{nil, 5, "ab", " ab ", strings.Repeat("x", 501), strings.Repeat("😀", 251)} {
		_, err := bans.Reason(bad)
		wantError(t, err, 400, "A reason of 3 to 500 characters is required")
	}
	if u, err := bans.Until(nil, now); u != nil || err != nil {
		t.Fatal(u, err)
	}
	if u, _ := bans.Until("2026-03-02T01:30:00.5+01:30", now); u != "2026-03-02T00:00:00.500Z" {
		t.Fatal(u)
	}
	for _, bad := range []any{5.0, true, "tomorrow", "2026-02-30T00:00:00Z"} {
		_, err := bans.Until(bad, now)
		wantError(t, err, 400, "Invalid until: use an ISO 8601 date and time")
	}
	_, err := bans.Until("2026-03-01T10:00:00.000Z", now)
	wantError(t, err, 400, "until must be in the future")
	for _, bad := range []any{"", "Fraud", strings.Repeat("a", 41), 5.0, "abc\n"} {
		_, err := bans.Category(bad)
		wantError(t, err, 400, "Invalid category")
	}
	if c, _ := bans.Category("fraud"); c != "fraud" {
		t.Fatal(c)
	}
}

func TestRules(t *testing.T) {
	ctx := context.Background()
	f := setup(t, nosql.NewMemoryStore())
	owner, other := f.make(t, "owner@example.test", "owner"), f.make(t, "owner2@example.test", "owner")
	admin, admin2, user := f.make(t, "admin@example.test", "admin"), f.make(t, "admin2@example.test", "admin"), f.make(t, "user@example.test", "")
	ownerActor := &web.Actor{ID: owner["id"].(string), Role: "owner"}
	adminActor := &web.Actor{ID: admin["id"].(string), Role: "admin"}
	reason := map[string]any{"reason": "Policy violation"}
	_, err := f.bans.Ban(ctx, owner["id"], reason, ownerActor)
	wantError(t, err, 403, "You cannot ban your own account")
	_, err = f.bans.Ban(ctx, other["id"], reason, ownerActor)
	wantError(t, err, 403, "Only the admin root can ban an owner")
	_, err = f.bans.Ban(ctx, admin2["id"], reason, adminActor)
	wantError(t, err, 403, "Only an owner can ban an administrator")
	for _, id := range []any{"nobody", 5.0, strings.Repeat("x", 101)} {
		_, err = f.bans.Ban(ctx, id, reason, root)
		wantError(t, err, 404, "User not found")
	}
	if v, err := f.bans.Ban(ctx, user["id"], reason, adminActor); err != nil || v["banned"] != true {
		t.Fatal(v, err)
	}
	if v, err := f.bans.Ban(ctx, other["id"], reason, root); err != nil || v["banned"] != true {
		t.Fatal(v, err)
	}
	_, err = f.bans.Unban(ctx, other["id"], reason, ownerActor)
	wantError(t, err, 403, "Only the admin root can unban an owner")
	if v, err := f.bans.Unban(ctx, other["id"], reason, root); err != nil || v["banned"] != false || v["ban"] != nil {
		t.Fatal(v, err)
	}
}

func TestBanCutsSessionsAndUnbanRestoresSignIn(t *testing.T) {
	ctx := context.Background()
	f := setup(t, nosql.NewMemoryStore())
	user := f.make(t, "user@example.test", "")
	id := user["id"].(string)
	signed, err := f.auth.Login(ctx, "user@example.test", password, "1.1.1.1")
	if err != nil {
		t.Fatal(err)
	}
	view, err := f.bans.Ban(ctx, id, map[string]any{"reason": " Fraud ", "until": "2026-03-01T11:00:00Z", "category": "fraud"}, root)
	if err != nil {
		t.Fatal(err)
	}
	ban := view["ban"].(map[string]any)
	if ban["reason"] != "Fraud" || ban["until"] != "2026-03-01T11:00:00.000Z" || ban["at"] != "2026-03-01T10:00:00.000Z" || ban["by"] != bans.RootActor {
		t.Fatal(ban)
	}
	session, _ := f.store.Get(ctx, auth.SessionPartition(id), signed.SessionID)
	if session.Data["revokedReason"] != bans.SessionReason || session.Data["revokedAt"] != float64(f.now.UnixMilli()) {
		t.Fatal(session.Data)
	}
	audit, _ := f.store.Get(ctx, bans.Partition(id), "001772359200000-0000000002")
	if audit == nil || audit.Data["action"] != "ban" || audit.Data["actorId"] != bans.RootActor {
		t.Fatal(audit)
	}
	_, err = f.auth.Actor(ctx, "Bearer "+signed.Token)
	wantError(t, err, 401, "Invalid session")
	_, err = f.auth.Refresh(ctx, signed.RefreshToken, "1.1.1.1")
	wantError(t, err, 403, users.AccountSuspended)
	_, err = f.auth.Refresh(ctx, signed.SessionID+"."+strings.Repeat("x", 43), "1.1.1.1")
	wantError(t, err, 401, "Invalid session")
	_, err = f.auth.Login(ctx, "user@example.test", password, "1.1.1.1")
	wantError(t, err, 403, users.AccountSuspended)
	_, err = f.auth.Login(ctx, "user@example.test", password+"x", "1.1.1.1")
	wantError(t, err, 401, "Incorrect email or password")
	if _, err := f.auth.Issue(ctx, "user@example.test", "login", "1.1.1.1"); err != nil {
		t.Fatal(err)
	}
	_, err = f.auth.Consume(ctx, "user@example.test", f.mail.Messages()[0].Code, "login", "1.1.1.1", nil)
	wantError(t, err, 403, users.AccountSuspended)

	*f.now = f.now.Add(time.Hour - time.Millisecond)
	_, err = f.auth.Login(ctx, "user@example.test", password, "1.1.1.1")
	wantError(t, err, 403, users.AccountSuspended)
	*f.now = f.now.Add(time.Millisecond)
	if _, err := f.auth.Login(ctx, "user@example.test", password, "1.1.1.1"); err != nil {
		t.Fatal("lifted at until:", err)
	}
	_, err = f.bans.Unban(ctx, id, map[string]any{"reason": "Expired"}, root)
	wantError(t, err, 409, "User is not banned")

	if _, err := f.bans.Ban(ctx, id, map[string]any{"reason": "Again"}, root); err != nil {
		t.Fatal(err)
	}
	*f.now = f.now.Add(time.Second)
	if _, err := f.bans.Ban(ctx, id, map[string]any{"reason": "Updated"}, &web.Actor{ID: "u-admin", Role: "admin"}); err != nil {
		t.Fatal(err)
	}
	if v, err := f.bans.Unban(ctx, id, map[string]any{"reason": "Appeal"}, root); err != nil || v["banned"] != false {
		t.Fatal(v, err)
	}
	row, _ := f.store.Get(ctx, "USERS", id)
	if row.Data["tokenVersion"] != 4.0 || row.Data["ban"] != nil {
		t.Fatal(row.Data)
	}
	_, err = f.auth.Refresh(ctx, signed.RefreshToken, "1.1.1.1")
	wantError(t, err, 401, "Invalid session")
	if _, err := f.auth.Login(ctx, "user@example.test", password, "1.1.1.1"); err != nil {
		t.Fatal(err)
	}
	history, err := f.bans.History(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	var actions []string
	for _, item := range history.Items {
		actions = append(actions, item.Action.(string))
	}
	if strings.Join(actions, ",") != "unban,update,ban,ban" {
		t.Fatal(actions)
	}
	_, err = f.bans.History(ctx, "nobody")
	wantError(t, err, 404, "User not found")
	_, err = f.bans.History(ctx, 7.0)
	wantError(t, err, 404, "User not found")
}

// conflicting fails the transactions that write a ban history row while failures > 0.
type conflicting struct {
	nosql.Store
	failures int
}

func (c *conflicting) Transact(ctx context.Context, writes []nosql.Write) error {
	for _, w := range writes {
		if c.failures > 0 && strings.HasPrefix(w.Row.PK, "USER_BANS#") {
			c.failures--
			return apperr.Conflict()
		}
	}
	return c.Store.Transact(ctx, writes)
}

func TestConflictsAreRetried(t *testing.T) {
	ctx := context.Background()
	store := &conflicting{Store: nosql.NewMemoryStore()}
	f := setup(t, store)
	f.bans = bans.New(f.accounts) // no clock option: the users clock; no sessions
	user := f.make(t, "user@example.test", "")
	store.failures = 1
	if v, err := f.bans.Ban(ctx, user["id"], map[string]any{"reason": "Retried"}, root); err != nil || v["banned"] != true {
		t.Fatal(v, err)
	}
	store.failures = 4
	_, err := f.bans.Unban(ctx, user["id"], map[string]any{"reason": "Four conflicts"}, root)
	wantError(t, err, 409, apperr.ConflictMessage)
}

func TestHTTP(t *testing.T) {
	f := setup(t, nosql.NewMemoryStore())
	user := f.make(t, "user@example.test", "")
	app, err := web.New([]web.Feature{f.accounts.Feature(), f.bans.Feature(), f.auth.Feature()}, web.WithAuthenticator(f.auth.Authenticate), web.WithLocalAdmin())
	if err != nil {
		t.Fatal(err)
	}
	call := func(method, path, body string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		app.ServeHTTP(w, httptest.NewRequest(method, path, strings.NewReader(body)))
		return w
	}
	id := user["id"].(string)
	if w := call(http.MethodPost, "/users/"+id+"/ban", `{"reason":"Spam"}`); w.Code != 401 {
		t.Fatal(w.Code, w.Body)
	}
	if w := call(http.MethodPost, "/admin/app/users/"+id+"/ban", `{"reason":"Spam"}`); w.Code != 200 || !strings.Contains(w.Body.String(), `"banned":true`) {
		t.Fatal(w.Code, w.Body)
	}
	if w := call(http.MethodGet, "/admin/app/users?banned=true", ""); !strings.Contains(w.Body.String(), id) {
		t.Fatal(w.Body)
	}
	if w := call(http.MethodGet, "/admin/app/users/"+id+"/bans", ""); !strings.Contains(w.Body.String(), `"action":"ban"`) {
		t.Fatal(w.Body)
	}
	for _, e := range f.bans.Feature().Endpoints {
		if e.Tool == nil || !strings.HasPrefix(e.Tool.Name, "users_") {
			t.Fatal(e)
		}
	}
}
