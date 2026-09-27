package web

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"rt.local/core-go/apperr"
)

func echo(name string) func(*Context) (any, error) {
	return func(c *Context) (any, error) {
		actor := ""
		if c.Actor != nil {
			actor = c.Actor.ID
		}
		return map[string]any{"route": name, "params": c.Params, "actor": actor, "body": c.Request.Body, "query": c.Request.Query}, nil
	}
}

func testApp(t *testing.T, options ...Option) *App {
	t.Helper()
	quiet := slog.New(slog.NewTextHandler(io.Discard, nil))
	app, err := New([]Feature{{ID: "test", Endpoints: []Endpoint{
		{Method: "GET", Path: "/items/:id", Access: Guest, Handle: echo("param")},
		{Method: "GET", Path: "/items/new", Access: Guest, Handle: echo("literal")},
		{Method: "POST", Path: "/items", Access: Guest, Handle: echo("create")},
		{Method: "GET", Path: "/me", Access: Authenticated, Handle: echo("me")},
		{Method: "PUT", Path: "/items/:id", Access: Owner, Handle: echo("owner")},
		{Method: "GET", Path: "/grants", Access: Permission, Resource: "grants.read", Handle: echo("permission")},
		{Method: "GET", Path: "/fail", Access: Guest, Handle: func(*Context) (any, error) { return nil, errors.New("secret detail") }},
		{Method: "GET", Path: "/panic", Access: Guest, Handle: func(*Context) (any, error) { panic("boom") }},
		{Method: "GET", Path: "/teapot", Access: Guest, Handle: func(*Context) (any, error) { return nil, apperr.New(418, "Short and stout") }},
	}}}, append([]Option{WithLogger(quiet)}, options...)...)
	if err != nil {
		t.Fatal(err)
	}
	return app
}

func call(t *testing.T, h http.Handler, method, target, body string) *httptest.ResponseRecorder {
	t.Helper()
	r, err := NewRequest(context.Background(), method, target, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestDispatch(t *testing.T) {
	app := testApp(t)
	cases := []struct {
		method, target, body string
		status               int
		want                 string
	}{
		{"GET", "/items/new", "", 200, `"route":"literal"`},
		{"GET", "/items/new/", "", 200, `"route":"literal"`},
		{"GET", "/items/a%20b", "", 200, `"params":{"id":"a b"}`},
		{"GET", "/items/%E0%A4%A", "", 400, `{"error":"Invalid URL"}`},
		{"GET", "/items/%FF", "", 400, `{"error":"Invalid URL"}`},
		{"GET", "/items/x?a=1&a=2", "", 200, `"query":{"a":"2"}`},
		{"DELETE", "/items/x", "", 404, `{"error":"Endpoint not found"}`},
		{"GET", "/items/", "", 404, `{"error":"Endpoint not found"}`},
		{"PUT", "/items/x", "{}", 401, `{"error":"Sign in"}`}, // also at its plain path, like TypeScript
		{"GET", "/me", "", 401, `{"error":"Sign in"}`},
		{"PUT", "/admin/app/items/x", "", 401, `{"error":"Sign in to admin"}`},
		{"GET", "/fail", "", 500, `{"error":"Internal error"}`},
		{"GET", "/panic", "", 500, `{"error":"Internal error"}`},
		{"GET", "/teapot", "", 418, `{"error":"Short and stout"}`},
		{"POST", "/items", `{"a":"<b>"}`, 200, `"body":{"a":"<b>"}`},
		{"POST", "/items", "", 200, `"body":{}`},
		{"POST", "/items", "{bad", 400, `{"error":"Invalid JSON"}`},
		{"POST", "/items", "[1]", 400, `{"error":"Invalid JSON"}`},
		{"POST", "/items", "null", 400, `{"error":"Invalid JSON"}`},
		{"POST", "/items", " ", 400, `{"error":"Invalid JSON"}`},
		{"POST", "/nope", "{bad", 400, `{"error":"Invalid JSON"}`},
		{"POST", "/items", `{"a":"` + strings.Repeat("x", DefaultBodyLimit) + `"}`, 413, `{"error":"Request body too large"}`},
	}
	for _, c := range cases {
		w := call(t, app, c.method, c.target, c.body)
		if w.Code != c.status || !strings.Contains(w.Body.String(), c.want) {
			t.Errorf("%s %s: got %d %s", c.method, c.target, w.Code, w.Body)
		}
		if w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("Content-Type") != "application/json" {
			t.Errorf("%s %s: headers %v", c.method, c.target, w.Header())
		}
	}
}

func TestLocalAdminAndAccess(t *testing.T) {
	app := testApp(t, WithLocalAdmin())
	if w := call(t, app, "PUT", "/admin/app/items/x", ""); w.Code != 200 || !strings.Contains(w.Body.String(), `"actor":"rt-app-root"`) {
		t.Fatalf("owner endpoint: %d %s", w.Code, w.Body)
	}
	if w := call(t, app, "GET", "/admin/app/grants", ""); w.Code != 200 {
		t.Fatalf("owners pass permission checks: %d %s", w.Code, w.Body)
	}
	if w := call(t, app, "GET", "/me", ""); w.Code != 401 {
		t.Fatalf("local admin must not authenticate app routes: %d", w.Code)
	}
	member := func(*http.Request) (*Actor, error) {
		return &Actor{ID: "m", Role: "member", Grants: []string{"grants.read"}}, nil
	}
	app = testApp(t, WithAdminAuthenticator(member), WithAuthenticator(member))
	// Grants apply at plain paths; /admin/app only admits the admin root (TypeScript AdminIdentity).
	for target, status := range map[string]int{"/grants": 200, "/me": 200, "/admin/app/grants": 401} {
		if w := call(t, app, "GET", target, ""); w.Code != status {
			t.Errorf("member GET %s: %d %s", target, w.Code, w.Body)
		}
	}
	if w := call(t, app, "PUT", "/items/x", ""); w.Code != 403 {
		t.Errorf("member on owner endpoint: %d %s", w.Code, w.Body)
	}
}

func TestNewRejectsBadRoutes(t *testing.T) {
	ok := func(*Context) (any, error) { return nil, nil }
	if _, err := New([]Feature{{ID: "a", Endpoints: []Endpoint{{Method: "GET", Path: "/x", Access: Guest, Handle: ok}, {Method: "GET", Path: "/x", Access: Guest, Handle: ok}}}}); err == nil {
		t.Error("duplicate endpoints accepted")
	}
	if _, err := New([]Feature{{ID: "a", Endpoints: []Endpoint{{Method: "GET", Path: "/x", Access: "public", Handle: ok}}}}); err == nil {
		t.Error("unknown access accepted")
	}
}

// The real server must hand invalid escapes to the App (Go's own parser answers plain 400),
// on a first request and on a kept-alive connection.
func TestServerKeepsInvalidEscapes(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- ServeListener(ctx, ln, testApp(t)) }()
	defer func() {
		cancel()
		if err := <-done; err != nil {
			t.Error(err)
		}
	}()
	conn, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	reader := bufio.NewReader(conn)
	for i, target := range []string{"/items/%E0%A4%A", "/items/ok", "/items/%zz", "/items/%25zz"} {
		fmt.Fprintf(conn, "GET %s HTTP/1.1\r\nHost: test\r\n\r\n", target)
		res, err := http.ReadResponse(reader, nil)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(res.Body)
		res.Body.Close()
		want := map[int]string{0: `{"error":"Invalid URL"}`, 1: `"id":"ok"`, 2: `{"error":"Invalid URL"}`, 3: `"id":"%zz"`}[i]
		if !bytes.Contains(body, []byte(want)) {
			t.Errorf("GET %s: %d %s", target, res.StatusCode, body)
		}
	}
}

func TestCLI(t *testing.T) {
	app := testApp(t, WithLocalAdmin())
	var out, errOut bytes.Buffer
	code := RunCLI(app, []string{"POST", "/items", "--body", `{"n":1}`, "--header", "X-Test: yes"}, &out, &errOut)
	if code != 0 || !strings.Contains(out.String(), `"body":{"n":1}`) {
		t.Fatalf("exit %d, stdout %s, stderr %s", code, &out, &errOut)
	}
	out.Reset()
	if code := RunCLI(app, []string{"get", "/nope"}, &out, &errOut); code != 1 || strings.TrimSpace(out.String()) != `{"error":"Endpoint not found"}` {
		t.Fatalf("404: exit %d, %s", code, &out)
	}
	if code := RunCLI(app, []string{"GET"}, &out, &errOut); code != 2 {
		t.Fatalf("usage error: exit %d", code)
	}
}
