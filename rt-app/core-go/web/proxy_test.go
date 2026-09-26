package web

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// upstream records what the core received and answers with a hop-by-hop header of its own.
func upstream(t *testing.T) (*httptest.Server, chan *http.Request, chan string) {
	t.Helper()
	requests, bodies := make(chan *http.Request, 10), make(chan string, 10)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		requests <- r
		bodies <- string(body)
		w.Header().Set("Keep-Alive", "timeout=5")
		w.Header().Set("Connection", "X-Core-Private")
		w.Header().Set("X-Core-Private", "secret")
		w.Header().Set("X-Core", "node")
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, `{"from":"core"}`)
	}))
	t.Cleanup(server.Close)
	return server, requests, bodies
}

func TestNewCoreProxyRejectsNonLoopback(t *testing.T) {
	for _, bad := range []string{"", "https://127.0.0.1:1", "http://10.0.0.1:80", "http://example.com:80", "http://127.0.0.1", "http://u:p@127.0.0.1:1", "http://127.0.0.1:1/?a=1"} {
		if _, err := NewCoreProxy(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
	for _, good := range []string{"http://127.0.0.1:4000", "http://[::1]:4000", "http://localhost:4000/"} {
		if _, err := NewCoreProxy(good); err != nil {
			t.Errorf("%q rejected: %v", good, err)
		}
	}
}

func TestFallbackForwardsUnmatchedRoutes(t *testing.T) {
	core, requests, bodies := upstream(t)
	proxy, err := NewCoreProxy(core.URL)
	if err != nil {
		t.Fatal(err)
	}
	app := testApp(t, WithFallback(proxy))

	// Native routes are still served by the App, errors included.
	if w := call(t, app, "GET", "/items/new", ""); w.Code != 200 || !strings.Contains(w.Body.String(), `"route":"literal"`) {
		t.Fatalf("native route: %d %s", w.Code, w.Body)
	}
	if w := call(t, app, "POST", "/items", "{bad"); w.Code != 400 {
		t.Fatalf("native route with a bad body: %d %s", w.Code, w.Body)
	}
	if len(requests) != 0 {
		t.Fatal("native routes reached the core")
	}

	// Unmatched routes (another method, unknown path) reach the core with body and headers.
	r, _ := NewRequest(context.Background(), "DELETE", "//evil.test/users/a%20b?q=a%20b", strings.NewReader("not json"))
	r.RemoteAddr = "192.0.2.7:5555"
	r.Header.Set("Authorization", "Bearer t")
	r.Header.Set("Connection", "X-Client-Private")
	r.Header.Set("X-Client-Private", "drop me")
	r.Header.Set("X-Forwarded-For", "203.0.113.9")
	r.Header.Set("Te", "trailers")
	w := httptest.NewRecorder()
	app.ServeHTTP(w, r)
	if w.Code != http.StatusCreated || w.Body.String() != `{"from":"core"}` {
		t.Fatalf("proxied: %d %s", w.Code, w.Body)
	}
	for _, hop := range []string{"Keep-Alive", "Connection", "X-Core-Private"} {
		if w.Header().Get(hop) != "" {
			t.Errorf("response hop-by-hop header %s kept", hop)
		}
	}
	if w.Header().Get("X-Core") != "node" {
		t.Error("end-to-end response header dropped")
	}
	got := <-requests
	if got.Method != "DELETE" || got.RequestURI != "/evil.test/users/a%20b?q=a%20b" || <-bodies != "not json" {
		t.Errorf("upstream got %s %s", got.Method, got.RequestURI)
	}
	if got.Header.Get("Authorization") != "Bearer t" {
		t.Error("authorization not forwarded")
	}
	if got.Header.Get("X-Client-Private") != "" || got.Header.Get("Te") != "" {
		t.Errorf("request hop-by-hop headers forwarded: %v", got.Header)
	}
	if got.Header.Get("X-Forwarded-For") != "192.0.2.7" {
		t.Errorf("X-Forwarded-For = %q", got.Header.Get("X-Forwarded-For"))
	}
	if got.Host != strings.TrimPrefix(core.URL, "http://") {
		t.Errorf("Host = %q", got.Host)
	}
}

// Invalid percent-escapes reach the core as received, so it answers its own 400 "Invalid URL".
func TestCoreProxyKeepsRawTarget(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	lines := make(chan string, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		line, _ := bufio.NewReader(conn).ReadString('\n')
		lines <- line
		_, _ = io.WriteString(conn, "HTTP/1.1 400 Bad Request\r\nContent-Length: 23\r\nConnection: close\r\n\r\n{\"error\":\"Invalid URL\"}")
	}()
	proxy, err := NewCoreProxy("http://" + ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	w := call(t, testApp(t, WithFallback(proxy)), "GET", "/users/%E0%A4%A?x=%zz", "")
	if w.Code != 400 || w.Body.String() != `{"error":"Invalid URL"}` {
		t.Fatalf("got %d %s", w.Code, w.Body)
	}
	if line := <-lines; line != "GET /users/%E0%A4%A?x=%zz HTTP/1.1\r\n" {
		t.Fatalf("request line %q", line)
	}
}

func TestCoreProxyUnavailable(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	ln.Close() // nothing listens there now
	proxy, err := NewCoreProxy("http://" + addr)
	if err != nil {
		t.Fatal(err)
	}
	w := call(t, testApp(t, WithFallback(proxy)), "GET", "/not-ported", "")
	var body map[string]string
	if w.Code != http.StatusBadGateway || json.Unmarshal(w.Body.Bytes(), &body) != nil || body["error"] != CoreUnavailable {
		t.Fatalf("got %d %s", w.Code, w.Body)
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Error("502 is not a JSON RT-App error")
	}
}

func TestWithoutFallbackUnmatchedIs404(t *testing.T) {
	if w := call(t, testApp(t), "GET", "/not-ported", ""); w.Code != 404 {
		t.Fatalf("got %d", w.Code)
	}
}

func TestRequestIP(t *testing.T) {
	var ip string
	app, err := New([]Feature{{ID: "ip", Endpoints: []Endpoint{{Method: "GET", Path: "/ip", Access: Guest, Handle: func(c *Context) (any, error) { ip = c.Request.IP; return nil, nil }}}}})
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("GET", "/ip", nil)
	r.RemoteAddr = "[::1]:1234"
	app.ServeHTTP(httptest.NewRecorder(), r)
	if ip != "::1" {
		t.Fatalf("IP = %q", ip)
	}
}
