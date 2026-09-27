package auth

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"rt.local/core-go/acl"
	"rt.local/core-go/apperr"
	"rt.local/core-go/jwt"
	"rt.local/core-go/nosql"
	"rt.local/core-go/users"
	"rt.local/core-go/web"
)

const secret = "rt-app-contract-secret-0123456789abcdef"

func TestTOTPVectors(t *testing.T) {
	// RFC 6238 SHA-1 vectors (seed "12345678901234567890"), truncated to six digits.
	for step, want := range map[uint64]string{1: "287082", 37037036: "081804", 41152263: "005924", 666666666: "353130"} {
		if got, err := TOTPCode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", step); err != nil || got != want {
			t.Errorf("step %d: %s %v", step, got, err)
		}
	}
	now := int64(58910768) * 30000
	code, _ := TOTPCode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 58910769)
	if step, ok, _ := TOTPStep("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", code, -1, now); !ok || step != 58910769 {
		t.Error("one step of drift is accepted")
	}
	if _, ok, _ := TOTPStep("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", code, 58910769, now); ok {
		t.Error("a used step is accepted again")
	}
	if _, ok, _ := TOTPStep("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", "\uff11\uff12\uff13\uff14\uff15\uff16", -1, now); ok {
		t.Error("fullwidth digits accepted")
	}
	if s := NewTOTPSecret(); len(s) != 32 || strings.Trim(s, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567") != "" {
		t.Errorf("secret %q", s)
	}
}

func TestVault(t *testing.T) {
	vault := NewVault(secret)
	// Sealed by the TypeScript reference with IV 000102030405060708090a0b.
	value, err := vault.Open("AAECAwQFBgcICQoLOToKaO5-5QPD1JHvL0I6C9CtDSvDjl7_8wQUWo0PfU1er31KjW6fOXMyqMi2cG3Koxq82AJrCWy_b6BmyA")
	if err != nil || value.(map[string]any)["secret"] != "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" {
		t.Fatalf("open reference: %v %v", value, err)
	}
	iv := []byte{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11}
	if got := vault.seal(iv, []byte(`{"secret":"GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"}`)); got != "AAECAwQFBgcICQoLOToKaO5-5QPD1JHvL0I6C9CtDSvDjl7_8wQUWo0PfU1er31KjW6fOXMyqMi2cG3Koxq82AJrCWy_b6BmyA" {
		t.Fatalf("seal with a fixed IV: %s", got)
	}
	sealed, _ := vault.Seal(map[string]any{})
	if len(sealed) != 40 {
		t.Errorf("sealed {} has %d characters", len(sealed))
	}
	if _, err := NewVault("another secret, also long enough!!").Open(sealed); err == nil {
		t.Error("opened with another secret")
	}
}

// server wires users, acl and auth into one web.App like an application would.
type server struct {
	app     *web.App
	auth    *Auth
	users   *users.Users
	mailbox *LocalMailbox
	now     time.Time
}

func newServer(t *testing.T) *server {
	t.Helper()
	s := &server{mailbox: &LocalMailbox{}, now: time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)}
	clock := func() time.Time { return s.now }
	store := nosql.NewMemoryStore()
	s.users = users.New(store, users.WithClock(clock))
	tokens, err := jwt.New(secret, jwt.WithClock(clock))
	if err != nil {
		t.Fatal(err)
	}
	s.auth = New(s.users, tokens, s.mailbox, secret, WithClock(clock))
	var features []web.Feature
	policy := acl.New(store, func() []acl.Endpoint { return acl.Endpoints(features...) }, acl.WithClock(clock))
	features = []web.Feature{s.users.Feature(), policy.Feature(), s.auth.Feature()}
	quiet := slog.New(slog.NewTextHandler(io.Discard, nil))
	s.app, err = web.New(features, web.WithAuthenticator(s.auth.Authenticate), web.WithAdminAuthenticator(s.auth.Authenticate), web.WithLogger(quiet))
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func (s *server) call(t *testing.T, method, path, token string, body any) (int, map[string]any) {
	t.Helper()
	raw, _ := json.Marshal(body)
	if body == nil {
		raw = nil
	}
	r := httptest.NewRequest(method, path, strings.NewReader(string(raw)))
	r.RemoteAddr = "192.0.2.1:1234"
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	s.app.ServeHTTP(w, r)
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}

func TestHTTPFlows(t *testing.T) {
	ctx := context.Background()
	s := newServer(t)
	owner, err := s.users.BootstrapOwner(ctx, map[string]any{"email": "owner@example.test", "name": "Owner", "password": "correct horse battery"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.users.Create(ctx, map[string]any{"email": "alice@example.test", "name": "Alice", "password": "correct horse battery"}, "", owner.SK); err != nil {
		t.Fatal(err)
	}

	// Password sign-in normalizes the email; the session identifies the actor.
	code, session := s.call(t, "POST", "/auth/login", "", map[string]any{"email": " Alice@Example.test", "password": "correct horse battery"})
	if code != 200 || session["expiresIn"] != 900.0 {
		t.Fatalf("login: %d %v", code, session)
	}
	token := session["token"].(string)
	if code, me := s.call(t, "GET", "/users/me", token, nil); code != 200 || me["email"] != "alice@example.test" || me["createdAt"] != nil {
		t.Fatalf("me: %d %v", code, me)
	}
	if code, body := s.call(t, "GET", "/users/me", "", nil); code != 401 || body["error"] != "Sign in" {
		t.Fatalf("anonymous me: %d %v", code, body)
	}
	if code, body := s.call(t, "GET", "/users/me", "garbage", nil); code != 401 || body["error"] != "Invalid or expired session" {
		t.Fatalf("bad token: %d %v", code, body)
	}
	if code, _ := s.call(t, "GET", "/users", token, nil); code != 403 {
		t.Fatalf("users.list without the grant: %d", code)
	}

	// The owner delegates users.list; the grant revokes Alice's sessions.
	_, ownerSession := s.call(t, "POST", "/auth/login", "", map[string]any{"email": "owner@example.test", "password": "correct horse battery"})
	ownerToken := ownerSession["token"].(string)
	aliceID := session["user"].(map[string]any)["id"].(string)
	if code, body := s.call(t, "PUT", "/acl/users/"+aliceID, ownerToken, map[string]any{"role": "user", "grants": []string{"users.list"}}); code != 200 {
		t.Fatalf("assign: %d %v", code, body)
	}
	if code, _ := s.call(t, "GET", "/users/me", token, nil); code != 401 {
		t.Fatal("assign did not revoke the session")
	}

	// Email code sign-in with the new grant.
	if code, body := s.call(t, "POST", "/auth/code", "", map[string]any{"email": "alice@example.test"}); code != 200 || body["message"] != msgCodeSent {
		t.Fatalf("code: %d %v", code, body)
	}
	emailed := s.mailbox.Messages()[0]
	code, session = s.call(t, "POST", "/auth/code/verify", "", map[string]any{"email": "alice@example.test", "code": emailed.Code})
	if code != 200 {
		t.Fatalf("code verify: %d %v", code, session)
	}
	token = session["token"].(string)
	if code, list := s.call(t, "GET", "/users?email=ALICE", token, nil); code != 200 || len(list["items"].([]any)) != 1 {
		t.Fatalf("users.list with the grant: %d %v", code, list)
	}

	// MFA enrollment, then password sign-in needs the authenticator.
	code, enroll := s.call(t, "POST", "/auth/mfa/setup", token, map[string]any{"password": "correct horse battery"})
	if code != 200 || !strings.HasPrefix(enroll["uri"].(string), "otpauth://totp/RT-APP:alice%40example.test?secret=") {
		t.Fatalf("setup: %d %v", code, enroll)
	}
	totp, _ := TOTPCode(enroll["secret"].(string), uint64(s.now.UnixMilli()/30000))
	if code, body := s.call(t, "POST", "/auth/mfa/enable", token, map[string]any{"challengeId": enroll["challengeId"], "code": totp}); code != 200 || body["reauthenticate"] != true {
		t.Fatalf("enable: %d %v", code, body)
	}
	code, pending := s.call(t, "POST", "/auth/login", "", map[string]any{"email": "alice@example.test", "password": "correct horse battery"})
	if code != 200 || pending["challenge"] != "totp" || pending["token"] != nil {
		t.Fatalf("login with MFA: %d %v", code, pending)
	}
	s.now = s.now.Add(30 * time.Second)
	totp, _ = TOTPCode(enroll["secret"].(string), uint64(s.now.UnixMilli()/30000))
	if code, body := s.call(t, "POST", "/auth/mfa/verify", "", map[string]any{"challengeId": pending["challengeId"], "code": totp}); code != 200 || body["token"] == nil {
		t.Fatalf("verify: %d %v", code, body)
	}
	if code, body := s.call(t, "PUT", "/auth/settings", ownerToken, map[string]any{"version": 0, "values": map[string]any{"passwordLogin": false, "emailCodeLogin": true}}); code != 409 {
		t.Fatalf("disabling passwords with MFA on: %d %v", code, body)
	}
	if code, methods := s.call(t, "GET", "/auth/methods", "", nil); code != 200 || methods["provider"] != "local" || methods["passwordLogin"] != true {
		t.Fatalf("methods: %d %v", code, methods)
	}
}

func TestLimit(t *testing.T) {
	ctx := context.Background()
	s := newServer(t)
	for i := 0; i < 2; i++ {
		if err := s.auth.Limit(ctx, "login:alice@example.test", 2); err != nil {
			t.Fatal(err)
		}
	}
	err := s.auth.Limit(ctx, "login:alice@example.test", 2)
	if e, ok := apperr.As(err); !ok || e.Status != http.StatusTooManyRequests {
		t.Fatalf("third attempt: %v", err)
	}
	// The row is shared with other languages: RATE/HMAC(secret, "<key>:<minute>").
	row, _ := s.users.Store().Get(ctx, "RATE", "997006e472b1a08e8093fae9240c2d24f49e984e5144f8339382975d5d5e5e36")
	if row == nil || row.Data["count"] != 2.0 || *row.TTL != 1767323165 {
		t.Fatalf("rate row %+v", row)
	}
	s.now = time.Date(2026, 1, 2, 3, 5, 0, 0, time.UTC)
	if err := s.auth.Limit(ctx, "login:alice@example.test", 2); err != nil {
		t.Fatalf("new window: %v", err)
	}
}
