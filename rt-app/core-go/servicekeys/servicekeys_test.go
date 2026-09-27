package servicekeys

import (
	"context"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"rt.local/core-go/apperr"
	"rt.local/core-go/nosql"
	"rt.local/core-go/web"
)

func env(values map[string]string) func(string) string {
	return func(name string) string { return values[name] }
}

func TestFromEnv(t *testing.T) {
	if v, err := FromEnv(env(nil)); v != nil || err != nil {
		t.Fatalf("nothing configured: %v %v", v, err)
	}
	v, err := FromEnv(env(map[string]string{"RT_APP_SERVICE_KEYS": `[{"id":"a"}]`}))
	if err != nil || len(v.([]any)) != 1 {
		t.Fatalf("inline: %v %v", v, err)
	}
	file := filepath.Join(t.TempDir(), "keys.json")
	if err := os.WriteFile(file, []byte(`[{"id":"b"}]`), 0o600); err != nil {
		t.Fatal(err)
	}
	v, err = FromEnv(env(map[string]string{"RT_APP_SERVICE_KEYS_FILE": file}))
	if err != nil || v.([]any)[0].(map[string]any)["id"] != "b" {
		t.Fatalf("file: %v %v", v, err)
	}
	if _, err := FromEnv(env(map[string]string{"RT_APP_SERVICE_KEYS": "{"})); err == nil {
		t.Fatal("bad JSON accepted")
	}
	if _, err := FromEnv(env(map[string]string{"RT_APP_SERVICE_KEYS_FILE": filepath.Join(t.TempDir(), "missing")})); err == nil {
		t.Fatal("missing file accepted")
	}
}

func TestNewRejectsBadConfiguration(t *testing.T) {
	_, err := New(nosql.NewMemoryStore(), "s", []any{map[string]any{"id": "a", "secret": "short", "scopes": []any{"x"}}}, []string{"x"})
	if e, ok := apperr.As(err); !ok || e.Status != 400 {
		t.Fatalf("got %v", err)
	}
}

func TestCreateAuthenticateRevokeOverHTTP(t *testing.T) {
	ctx := context.Background()
	keys, err := New(nosql.NewMemoryStore(), "secret", nil, []string{"subscriptions.meter"})
	if err != nil {
		t.Fatal(err)
	}
	created, err := keys.Create(ctx, map[string]any{"description": "Agent", "scopes": []any{"subscriptions.meter"}}, "root")
	if err != nil {
		t.Fatal(err)
	}
	token := created["token"].(string)
	req := httptest.NewRequest("GET", "/service/x", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	actor, err := keys.Actor(req)
	if err != nil || actor.Role != "service" || actor.Name != "Agent" {
		t.Fatalf("actor %+v %v", actor, err)
	}
	if err := keys.Check(web.Endpoint{Access: web.Service, Resource: "subscriptions.meter"}, actor); err != nil {
		t.Fatal(err)
	}
	id := created["key"].(map[string]any)["id"].(string)
	if len(id) != 12 {
		t.Fatalf("generated id %q", id)
	}
	if _, err := keys.Revoke(ctx, id, "root"); err != nil {
		t.Fatal(err)
	}
	if _, err := keys.Actor(req); err == nil {
		t.Fatal("revoked key accepted")
	}
	if keys.String() == "" || len(keys.Scopes()) != 1 {
		t.Fatal("describe")
	}
}
