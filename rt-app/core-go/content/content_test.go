package content_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"rt.local/core-go/apperr"
	"rt.local/core-go/content"
	"rt.local/core-go/nosql"
	"rt.local/core-go/web"
)

func wantStatus(t *testing.T, err error, status int, message string) {
	t.Helper()
	var e *apperr.HTTPError
	if !errors.As(err, &e) || e.Status != status || e.Message != message {
		t.Fatalf("got %v, want %d %q", err, status, message)
	}
}

func TestDefaultsAndSave(t *testing.T) {
	ctx := context.Background()
	store := nosql.NewMemoryStore()
	c := content.New(store)
	home, err := c.Home(ctx)
	if err != nil || home["title"] != content.DefaultTitle || home["content"] != content.DefaultContent {
		t.Fatalf("home = %v, %v", home, err)
	}
	s, err := c.Save(ctx, map[string]any{"version": 0.0, "values": map[string]any{"title": " Hi　", "content": " Body ", "x": 1.0}})
	if err != nil || s.Version != 1 || s.Values["title"] != "Hi" || s.Values["content"] != "Body" || len(s.Values) != 2 {
		t.Fatalf("save = %+v, %v", s, err)
	}
	row, _ := store.Get(ctx, content.Partition, content.Key)
	if row.Version != 1 || row.Data["title"] != "Hi" {
		t.Fatalf("row = %+v", row)
	}
}

func TestSaveChecksVersionBeforeValues(t *testing.T) {
	ctx := context.Background()
	c := content.New(nosql.NewMemoryStore())
	for _, v := range []any{nil, "0", 0.5, true, []any{0.0}} {
		_, err := c.Save(ctx, map[string]any{"version": v})
		wantStatus(t, err, 400, "Version is required")
	}
	_, err := c.Save(ctx, map[string]any{"version": 1e300})
	wantStatus(t, err, 409, apperr.ConflictMessage)
	_, err = c.Save(ctx, map[string]any{"version": 0.0, "values": "text"})
	wantStatus(t, err, 400, "Invalid field: title")
	_, err = c.Save(ctx, map[string]any{"version": 0.0, "values": map[string]any{"title": strings.Repeat("😀", 61), "content": "c"}})
	wantStatus(t, err, 400, "Invalid field: title")
	_, err = c.Save(ctx, map[string]any{"version": 0.0, "values": map[string]any{"title": "t", "content": strings.Repeat("𝄞", 1001)}})
	wantStatus(t, err, 400, "Invalid field: content")
	if s, err := c.Save(ctx, map[string]any{"version": 0.0, "values": map[string]any{"title": strings.Repeat("😀", 60), "content": "\u0085"}}); err != nil || s.Values["content"] != "\u0085" {
		t.Fatalf("save = %+v, %v", s, err)
	}
}

func TestMigrateOnce(t *testing.T) {
	ctx := context.Background()
	store := nosql.NewMemoryStore()
	for range 2 {
		if err := content.Migrate(ctx, store); err != nil {
			t.Fatal(err)
		}
	}
	if row, _ := store.Get(ctx, "SCHEMA", "content"); row == nil || row.Version != 1 {
		t.Fatalf("schema row = %+v", row)
	}
}

func TestRoutes(t *testing.T) {
	app, err := web.New([]web.Feature{content.New(nosql.NewMemoryStore()).Feature()}, web.WithLocalAdmin())
	if err != nil {
		t.Fatal(err)
	}
	for path, status := range map[string]int{"/": 200, "/admin/app/content/settings": 200, "/content/settings": 401} {
		rec := httptest.NewRecorder()
		app.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != status {
			t.Errorf("GET %s = %d, want %d", path, rec.Code, status)
		}
	}
}
