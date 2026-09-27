package auth

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"rt.local/core-go/apperr"
	"rt.local/core-go/nosql"
)

// Rows of spec/contracts/auth-sessions.contract.yaml (sessionAlice0000000001), as written by the
// TypeScript reference: current secret secretTwo…, previous secretOne… rotated 60 s ago.
func seedSession(t *testing.T, s *server) {
	t.Helper()
	ctx := context.Background()
	ttl := int64(1767582245)
	alice := nosql.Row{PK: "USERS", SK: "u-alice", Version: 1, Data: map[string]any{"id": "u-alice", "email": "alice@example.test", "name": "Alice",
		"role": "user", "grants": []any{}, "active": true, "tokenVersion": 1}}
	pointer := nosql.Row{PK: "SESSION", SK: "sessionAlice0000000001", Version: 1, TTL: &ttl, Data: map[string]any{"userId": "u-alice"}}
	session := nosql.Row{PK: "SESSIONS#u-alice", SK: "sessionAlice0000000001", Version: 1, TTL: &ttl, Data: map[string]any{
		"userId": "u-alice", "provider": "local", "tokenVersion": 1,
		"secretHash":   "a22213d5d1f5f0bd41f7e78cf05c48a7e27ce66e70ab217f512b2e3fb4bfe731",
		"previousHash": "6739169ea1e7c1816f255b48ae4accaebd9dd6e9551cabd56e505dbd9f5edb2e",
		"rotatedAt":    1767322985000, "createdAt": 1767236645000, "lastUsedAt": 1767322985000, "expiresAt": 1767582245000,
		"revokedAt": nil, "revokedReason": nil, "ip": "1.1.1.1", "userAgent": "Fixture/1.0"}}
	if err := s.users.Store().Transact(ctx, []nosql.Write{{Row: alice}, {Row: pointer}, {Row: session}}); err != nil {
		t.Fatal(err)
	}
}

func status(err error) int {
	if e, ok := apperr.As(err); ok {
		return e.Status
	}
	return 0
}

func TestRefreshRotatesReferenceRows(t *testing.T) {
	ctx := context.Background()
	s := newServer(t)
	seedSession(t, s)
	got, err := s.auth.Refresh(ctx, "sessionAlice0000000001.secretTwo2222222222222222222222222222222222", "1.1.1.1")
	if err != nil {
		t.Fatal(err)
	}
	// The access token of the TypeScript reference, byte for byte (payload v, sid, sub, …).
	want := "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ2IjoxLCJzaWQiOiJzZXNzaW9uQWxpY2UwMDAwMDAwMDAxIiwic3ViIjoidS1hbGljZSIsImlzcyI6InJ0LWFwcCIsImF1ZCI6InJ0LWFwcC1hcGkiLCJpYXQiOjE3NjczMjMwNDUsImV4cCI6MTc2NzMyMzk0NX0.A20bgnWNo87GH8r5t-WoKPBlTeqIN481pyFQBodvNQE"
	if got.Token != want || got.SessionID != "sessionAlice0000000001" || got.RefreshExpiresAt != "2026-01-05T03:04:05.000Z" ||
		!strings.HasPrefix(got.RefreshToken, "sessionAlice0000000001.") || len(got.RefreshToken) != 22+1+43 {
		t.Fatalf("refresh: %+v", got)
	}
	row, _ := s.users.Store().Get(ctx, "SESSIONS#u-alice", "sessionAlice0000000001")
	if row.Version != 2 || row.Data["previousHash"] != "a22213d5d1f5f0bd41f7e78cf05c48a7e27ce66e70ab217f512b2e3fb4bfe731" ||
		row.Data["rotatedAt"] != 1767323045000.0 || row.Data["lastUsedAt"] != 1767323045000.0 || *row.TTL != 1767582245 {
		t.Fatalf("row %+v", row)
	}
	// The TypeScript refresh-token hash format: HMAC(secret, "refresh:<id>:<secret>").
	secret := strings.TrimPrefix(got.RefreshToken, "sessionAlice0000000001.")
	if row.Data["secretHash"] != s.auth.refreshHash("sessionAlice0000000001", secret) {
		t.Fatal("secretHash")
	}
	// secretOne… was superseded 60 s ago: theft, the whole session is revoked.
	if _, err := s.auth.Refresh(ctx, "sessionAlice0000000001.secretOne1111111111111111111111111111111111", "1.1.1.1"); status(err) != 401 || err.Error() != "Invalid session" {
		t.Fatalf("reuse: %v", err)
	}
	if _, err := s.auth.Refresh(ctx, got.RefreshToken, "1.1.1.1"); status(err) != 401 {
		t.Fatalf("after reuse: %v", err)
	}
	row, _ = s.users.Store().Get(ctx, "SESSIONS#u-alice", "sessionAlice0000000001")
	if row.Data["revokedReason"] != "reuse" || row.Version != 3 {
		t.Fatalf("revoked row %+v", row)
	}
	if _, err := s.auth.Actor(ctx, "Bearer "+got.Token); status(err) != 401 {
		t.Fatalf("access token of a revoked session: %v", err)
	}
}

func TestSignInWritesSessionRows(t *testing.T) {
	ctx := context.Background()
	s := newServer(t)
	if _, err := s.users.Create(ctx, map[string]any{"email": "bob@example.test", "name": "Bob", "password": "correct horse battery"}, "", ""); err != nil {
		t.Fatal(err)
	}
	res, err := s.auth.Login(ctx, "bob@example.test", "correct horse battery", strings.Repeat("1", 70), "Mozilla/5.0 (Test) ünïcode\a")
	if err != nil || res.Session == nil {
		t.Fatal(err)
	}
	if res.RefreshExpiresAt != "2026-01-06T03:04:05.000Z" || len(res.SessionID) != 22 {
		t.Fatalf("session %+v", res.Session)
	}
	userID := res.User["id"].(string)
	row, _ := s.users.Store().Get(ctx, "SESSIONS#"+userID, res.SessionID)
	pointer, _ := s.users.Store().Get(ctx, "SESSION", res.SessionID)
	if row == nil || pointer == nil || pointer.Data["userId"] != userID || *pointer.TTL != 1767668645 || *row.TTL != 1767668645 {
		t.Fatalf("rows %+v %+v", row, pointer)
	}
	if row.Data["userAgent"] != "Mozilla/5.0 (Test) ncode" || row.Data["ip"] != strings.Repeat("1", 64) || row.Data["previousHash"] != nil ||
		row.Data["expiresAt"] != 1767668645000.0 || row.Data["provider"] != "local" {
		t.Fatalf("session row %+v", row.Data)
	}
	actor, err := s.auth.Actor(ctx, "Bearer "+res.Token)
	if err != nil || actor["sessionId"] != res.SessionID {
		t.Fatalf("actor %v %v", actor, err)
	}
}

func TestConcurrentRefreshesUseTheGraceWindow(t *testing.T) {
	ctx := context.Background()
	s := newServer(t)
	seedSession(t, s)
	var wg sync.WaitGroup
	errs := make([]error, 2)
	for i := range errs {
		wg.Go(func() {
			_, errs[i] = s.auth.Refresh(ctx, "sessionAlice0000000001.secretTwo2222222222222222222222222222222222", "1.1.1.1")
		})
	}
	wg.Wait()
	if errs[0] != nil || errs[1] != nil {
		t.Fatalf("two tabs: %v", errs)
	}
	row, _ := s.users.Store().Get(ctx, "SESSIONS#u-alice", "sessionAlice0000000001")
	if row.Version != 3 || row.Data["revokedAt"] != nil || row.Data["previousHash"] != "a22213d5d1f5f0bd41f7e78cf05c48a7e27ce66e70ab217f512b2e3fb4bfe731" {
		t.Fatalf("row %+v", row)
	}
	// 31 s later the superseded token is theft.
	s.now = s.now.Add(31 * time.Second)
	if _, err := s.auth.Refresh(ctx, "sessionAlice0000000001.secretTwo2222222222222222222222222222222222", "1.1.1.1"); status(err) != 401 {
		t.Fatalf("after grace: %v", err)
	}
}

func TestSessionEndpoints(t *testing.T) {
	ctx := context.Background()
	s := newServer(t)
	if _, err := s.users.Create(ctx, map[string]any{"email": "alice@example.test", "name": "Alice", "password": "correct horse battery"}, "", ""); err != nil {
		t.Fatal(err)
	}
	login := func(agent string) map[string]any {
		t.Helper()
		r := httptest.NewRequest("POST", "/auth/login", strings.NewReader(`{"email":"alice@example.test","password":"correct horse battery"}`))
		r.RemoteAddr = "192.0.2.1:1234"
		r.Header.Set("User-Agent", agent)
		w := httptest.NewRecorder()
		s.app.ServeHTTP(w, r)
		if w.Code != http.StatusOK {
			t.Fatalf("login: %d %s", w.Code, w.Body)
		}
		_, body := s.call(t, "POST", "/auth/refresh", "", map[string]any{"refreshToken": decode(t, w.Body.String())["refreshToken"]})
		return body
	}
	a := login("Browser A")
	s.now = s.now.Add(time.Minute)
	b := login("Browser B")
	if code, methods := s.call(t, "GET", "/auth/methods", "", nil); code != 200 || methods["refreshTokens"] != true {
		t.Fatalf("methods: %d %v", code, methods)
	}
	code, list := s.call(t, "GET", "/auth/sessions", b["token"].(string), nil)
	items, _ := list["items"].([]any)
	if code != 200 || len(items) != 2 {
		t.Fatalf("sessions: %d %v", code, list)
	}
	first := items[0].(map[string]any)
	if first["id"] != b["sessionId"] || first["current"] != true || first["userAgent"] != "Browser B" || first["ip"] != "192.0.2.1" || first["secretHash"] != nil {
		t.Fatalf("newest first, current marked: %v", items)
	}
	if code, body := s.call(t, "DELETE", "/auth/sessions/"+a["sessionId"].(string), b["token"].(string), nil); code != 200 || body["ok"] != true {
		t.Fatalf("revoke: %d %v", code, body)
	}
	if code, body := s.call(t, "GET", "/users/me", a["token"].(string), nil); code != 401 || body["error"] != "Invalid session" {
		t.Fatalf("revoked access token: %d %v", code, body)
	}
	if code, body := s.call(t, "DELETE", "/auth/sessions/"+a["sessionId"].(string), b["token"].(string), nil); code != 404 || body["error"] != "Session not found" {
		t.Fatalf("revoke twice: %d %v", code, body)
	}
	// Logout ends the current session only; the user keeps its tokenVersion.
	if code, body := s.call(t, "POST", "/auth/logout", b["token"].(string), map[string]any{}); code != 200 || body["ok"] != true {
		t.Fatalf("logout: %d %v", code, body)
	}
	if code, _ := s.call(t, "POST", "/auth/refresh", "", map[string]any{"refreshToken": b["refreshToken"]}); code != 401 {
		t.Fatal("refresh after logout")
	}
	user, _ := s.users.ByEmail(ctx, "alice@example.test")
	if user.Data["tokenVersion"] != 1.0 {
		t.Fatalf("tokenVersion %v", user.Data["tokenVersion"])
	}
	// all: true signs out everywhere.
	c := login("Browser C")
	if code, _ := s.call(t, "POST", "/auth/logout", c["token"].(string), map[string]any{"all": true}); code != 200 {
		t.Fatal("logout all")
	}
	user, _ = s.users.ByEmail(ctx, "alice@example.test")
	if user.Data["tokenVersion"] != 2.0 {
		t.Fatalf("tokenVersion after all: %v", user.Data["tokenVersion"])
	}
	if code, body := s.call(t, "POST", "/auth/refresh", "", map[string]any{"refreshToken": "garbage"}); code != 401 || body["error"] != "Invalid session" {
		t.Fatalf("garbage: %d %v", code, body)
	}
}

func decode(t *testing.T, text string) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal([]byte(text), &out); err != nil {
		t.Fatal(err)
	}
	return out
}
