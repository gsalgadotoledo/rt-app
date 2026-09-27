package web

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"rt.local/core-go/apperr"
)

// fakePolicy accepts "Bearer good" as a service actor with scope "meter".
type fakePolicy struct{}

func (fakePolicy) Actor(r *http.Request) (*Actor, error) {
	if r.Header.Get("Authorization") != "Bearer good" {
		return nil, apperr.New(http.StatusUnauthorized, "Invalid service key")
	}
	return &Actor{ID: "service:k", Role: "service", Grants: []string{"meter"}}, nil
}

func (fakePolicy) Check(e Endpoint, actor *Actor) error {
	for _, g := range actor.Grants {
		if g == e.Resource {
			return nil
		}
	}
	return apperr.New(http.StatusForbidden, "Service key not allowed for this resource")
}

func serviceApp(t *testing.T, options ...Option) *App {
	t.Helper()
	app, err := New([]Feature{{ID: "svc", Endpoints: []Endpoint{
		{Method: "GET", Path: "/service/meter", Access: Service, Resource: "meter", Handle: echo("meter")},
		{Method: "GET", Path: "/service/other", Access: Service, Resource: "other", Handle: echo("other")},
		{Method: "GET", Path: "/service-keys", Access: Owner, Resource: "keys", Handle: echo("keys")},
	}}}, append(options, WithLocalAdmin())...)
	if err != nil {
		t.Fatal(err)
	}
	return app
}

func get(app *App, path, authorization string) (int, string) {
	req := httptest.NewRequest("GET", path, nil)
	if authorization != "" {
		req.Header.Set("Authorization", authorization)
	}
	rec := httptest.NewRecorder()
	app.ServeHTTP(rec, req)
	return rec.Code, strings.TrimSpace(rec.Body.String())
}

func TestServiceEndpointsNeedAPolicy(t *testing.T) {
	app := serviceApp(t)
	if code, body := get(app, "/service/meter", ""); code != 401 || !strings.Contains(body, "Service key required") {
		t.Fatalf("%d %s", code, body)
	}
	if code, body := get(app, "/service/meter", "Bearer good"); code != 401 || !strings.Contains(body, "Invalid service key") {
		t.Fatalf("%d %s", code, body)
	}
}

func TestServiceEndpointsUseThePolicy(t *testing.T) {
	app := serviceApp(t, WithServiceKeys(fakePolicy{}))
	for _, c := range []struct {
		path, auth string
		code       int
	}{
		{"/service/meter", "Bearer good", 200},
		{"/service/meter", "Bearer bad", 401},
		{"/service/other", "Bearer good", 403},
		{"/admin/app/service/meter", "Bearer good", 404},
		{"/service-keys", "", 404},
		{"/admin/app/service-keys", "", 200},
	} {
		if code, body := get(app, c.path, c.auth); code != c.code {
			t.Errorf("%s: %d %s", c.path, code, body)
		}
	}
}

func TestServicePathsAreValidated(t *testing.T) {
	for _, e := range []Endpoint{
		{Method: "GET", Path: "/meter", Access: Service, Handle: echo("x")},
		{Method: "GET", Path: "/service/x", Access: Guest, Handle: echo("x")},
	} {
		if _, err := New([]Feature{{ID: "bad", Endpoints: []Endpoint{e}}}); err == nil {
			t.Errorf("%s %s accepted", e.Access, e.Path)
		}
	}
	if !AdminOnly(Endpoint{Path: "/service-keys/:id/revoke", Access: Owner}) {
		t.Error("service keys must be admin only")
	}
}
