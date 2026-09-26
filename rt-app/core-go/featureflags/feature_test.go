package featureflags

import (
	"net/http/httptest"
	"strings"
	"testing"

	"rt.local/core-go/nosql"
	"rt.local/core-go/web"
)

func TestHTTPEndpoints(t *testing.T) {
	app, err := web.New([]web.Feature{New(nosql.NewMemoryStore()).Feature()}, web.WithLocalAdmin())
	if err != nil {
		t.Fatal(err)
	}
	do := func(method, path, body string) (int, string) {
		t.Helper()
		r, err := web.NewRequest(ctx, method, path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		w := httptest.NewRecorder()
		app.ServeHTTP(w, r)
		return w.Code, strings.TrimSpace(w.Body.String())
	}
	steps := []struct {
		method, path, body string
		status             int
		contains           string
	}{
		{"GET", "/feature-flags", "", 404, `{"error":"Endpoint not found"}`},
		{"PUT", "/admin/app/feature-flags/api-x", `{"version":null,"description":"","enabled":true,"public":true,"rollout":100,"subjects":[]}`, 200, `"updatedBy":"rt-app-root","version":1`},
		{"PUT", "/admin/app/feature-flags/api-y", `{"description":"","enabled":true,"public":true,"rollout":100,"subjects":[]}`, 400, "Invalid flag configuration"},
		{"PUT", "/admin/app/feature-flags/Bad%20Key", `{"version":null}`, 400, "Invalid flag key"},
		{"POST", "/feature-flags/evaluate", `{"keys":["api-x","api-missing"]}`, 200, `{"api-missing":false,"api-x":true}`},
		{"POST", "/feature-flags/evaluate", `{"keys":[],"subject":5}`, 200, `{}`},
		{"POST", "/feature-flags/evaluate", `{"keys":["ok"],"subject":null}`, 400, "Invalid flag subject"},
		{"POST", "/feature-flags/evaluate", `{"keys":"x"}`, 400, "Provide up to 20 flag keys"},
		{"POST", "/feature-flags/evaluate", `{"keys":[1]}`, 400, "Provide up to 20 flag keys"},
		{"POST", "/feature-flags/evaluate", `{"keys":["a","b","c","d","e","f","g","h","i","j","k","l","m","n","o","p","q","r","s","t","u"]}`, 400, "Provide up to 20 flag keys"},
		{"GET", "/admin/app/feature-flags", "", 200, `{"items":[{"key":"api-x"`},
		{"GET", "/admin/app/feature-flags?cursor=bad", "", 400, "Invalid cursor"},
	}
	for _, s := range steps {
		status, body := do(s.method, s.path, s.body)
		if status != s.status || !strings.Contains(body, s.contains) {
			t.Errorf("%s %s %s: got %d %s", s.method, s.path, s.body, status, body)
		}
	}
}
