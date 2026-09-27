package microservices

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"rt.local/core-go/apperr"
	"rt.local/core-go/jwt"
	"rt.local/core-go/web"
)

type tokenTable map[string]*web.Actor

func (t tokenTable) Authenticate(_ context.Context, token string) (*web.Actor, error) {
	if actor, ok := t[token]; ok {
		return actor, nil
	}
	if token == "boom" {
		return nil, errors.New("database down")
	}
	return nil, apperr.New(401, "Unknown token")
}

func echo(c *web.Context) (any, error) {
	return map[string]any{"params": c.Params, "actor": c.Actor, "requestId": c.Request.Headers.Get("X-Request-Id")}, nil
}

func request(method, path, authorization string) web.Request {
	h := http.Header{}
	if authorization != "" {
		h.Set("Authorization", authorization)
	}
	h.Set("X-User-Id", "evil")
	return web.Request{Method: method, Path: path, Headers: h, Query: map[string]string{}, Body: map[string]any{}}
}

var user = &web.Actor{ID: "u", Role: "user", Grants: []string{"x.read"}, Active: true, TokenVersion: 1}

func service(t *testing.T, endpoints []Endpoint, options Options) *Service {
	t.Helper()
	options.Features = []Feature{{ID: "x", Endpoints: endpoints}}
	if options.Authenticate == nil {
		options.Authenticate = tokenTable{"good": user, "owner": {ID: "o", Role: "owner", Active: true}, "off": {ID: "i", Role: "owner", Active: false}}
	}
	s, err := New(options)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func ep(method, path, access, resource string) Endpoint {
	return Endpoint{Endpoint: web.Endpoint{Method: method, Path: path, Access: access, Resource: resource, Handle: echo}}
}

func TestRoutingAndCorrelation(t *testing.T) {
	var metrics []Metric
	s := service(t, []Endpoint{ep("GET", "/x/:id", "permission", "x.read"), ep("GET", "/files/a.b", "guest", "f")}, Options{
		Observe: func(_ context.Context, m Metric) error { metrics = append(metrics, m); return errors.New("ignored") },
	})
	r := s.Handle(context.Background(), request("GET", "/x/42/", "Bearer good"))
	body := r.Body.(map[string]any)
	if r.Status != 200 || body["params"].(map[string]string)["id"] != "42" || body["actor"] != user || body["requestId"] != r.Headers["x-request-id"] {
		t.Fatalf("unexpected %+v", r)
	}
	for path, status := range map[string]int{"/no": 404, "/x/1//": 404, "/files/aXb": 404, "/files/a.b": 200} {
		if got := s.Handle(context.Background(), request("GET", path, "")).Status; got != status {
			t.Errorf("%s: %d, want %d", path, got, status)
		}
	}
	if s.Handle(context.Background(), request("get", "/x/1", "Bearer good")).Status != 404 {
		t.Error("methods compare exactly")
	}
	if metrics[0].Route != "/x/:id" || metrics[1].Route != "/unmatched" || metrics[0].RequestID != r.Headers["x-request-id"] {
		t.Errorf("metrics %+v", metrics)
	}
	if _, err := New(Options{Features: []Feature{{Endpoints: []Endpoint{ep("GET", "/a", "guest", "a"), ep("GET", "/a", "guest", "b")}}}}); !errors.Is(err, ErrDuplicateRoute) {
		t.Errorf("duplicate: %v", err)
	}
}

func TestAuthorizationHeader(t *testing.T) {
	s := service(t, []Endpoint{ep("GET", "/x/:id", "permission", "x.read")}, Options{})
	cases := map[string]int{
		"Basic good": 401, "Bearer  good": 401, "Bearer good ": 401, "Bearer good\n": 401, "Bearer ": 401,
		"bEARER good": 200, "Bearer go​od": 401, "": 401, "Bearer boom": 500,
	}
	for header, status := range cases {
		r := s.Handle(context.Background(), request("GET", "/x/1", header))
		if r.Status != status {
			t.Errorf("%q: %d, want %d (%v)", header, r.Status, status, r.Body)
		}
	}
	if r := s.Handle(context.Background(), request("GET", "/x/1", "Bearer boom")); r.Body.(map[string]any)["error"] != "Internal error" {
		t.Errorf("non-HTTP errors are hidden: %v", r.Body)
	}
}

func TestAccess(t *testing.T) {
	explicit := ep("GET", "/explicit", "permission", "x.read")
	explicit.ExplicitGrant = true
	s := service(t, []Endpoint{
		ep("GET", "/other", "permission", "x.write"), explicit, ep("GET", "/owner", "owner", "x.admin"),
		ep("GET", "/custom", "admin", "x.custom"), ep("GET", "/guest", "guest", "x.guest"),
	}, Options{})
	cases := []struct {
		path, token string
		status      int
	}{
		{"/other", "good", 403}, {"/other", "owner", 200}, {"/explicit", "owner", 403}, {"/explicit", "good", 200},
		{"/owner", "good", 403}, {"/owner", "owner", 200}, {"/custom", "good", 200}, {"/custom", "", 401},
		{"/owner", "off", 401}, {"/guest", "off", 200},
	}
	for _, c := range cases {
		header := ""
		if c.token != "" {
			header = "Bearer " + c.token
		}
		if got := s.Handle(context.Background(), request("GET", c.path, header)).Status; got != c.status {
			t.Errorf("%s as %q: %d, want %d", c.path, c.token, got, c.status)
		}
	}
}

func TestDecodeURIComponent(t *testing.T) {
	good := map[string]string{"a%2Fb%20%C3%A9+%F0%9F%98%80": "a/b é+😀", "%41%62": "Ab", "é": "é", "plain": "plain"}
	for in, want := range good {
		if got, ok := DecodeURIComponent(in); !ok || got != want {
			t.Errorf("%q → %q %v", in, got, ok)
		}
	}
	for _, in := range []string{"%E0", "%zz", "%", "%C0%AF", "%ED%A0%80", "%F4%90%80%80", "%C3x%A9"} {
		if _, ok := DecodeURIComponent(in); ok {
			t.Errorf("%q should fail", in)
		}
	}
	s := service(t, []Endpoint{ep("GET", "/x/:id", "permission", "x.read")}, Options{})
	if s.Handle(context.Background(), request("GET", "/x/%E0", "Bearer good")).Status != 400 {
		t.Error("bad encoding is 400")
	}
	if s.Handle(context.Background(), request("GET", "/x/%E0", "")).Status != 401 {
		t.Error("access is checked first")
	}
}

func TestMetering(t *testing.T) {
	metered := ep("GET", "/m", "guest", "x.read")
	metered.Subscription = map[string]any{}
	endpoints := []Endpoint{metered}
	if r := service(t, endpoints, Options{}).Handle(context.Background(), request("GET", "/m", "")); r.Status != 503 {
		t.Errorf("no adapter: %d", r.Status)
	}
	var calls int
	s := service(t, endpoints, Options{InvokeMetered: func(_ context.Context, e Endpoint, _ *web.Actor, work func() (any, error)) (any, error) {
		calls++
		return work()
	}})
	if r := s.Handle(context.Background(), request("GET", "/m", "")); r.Status != 200 || calls != 1 {
		t.Errorf("metered: %d %d", r.Status, calls)
	}
}

// --- authenticators -------------------------------------------------------------------------

func TestSessionAuthenticator(t *testing.T) {
	now := time.Date(2026, 9, 24, 10, 0, 0, 0, time.UTC)
	tokens, _ := jwt.New(strings.Repeat("s", 32), jwt.WithClock(func() time.Time { return now }))
	actors := map[string]*web.Actor{"u": user, "revoked": {ID: "revoked", Active: true, TokenVersion: 2}, "alias": {ID: "x", Active: true, TokenVersion: 1}}
	auth := NewSessionAuthenticator(tokens, func(_ context.Context, id string) (*web.Actor, error) { return actors[id], nil })
	if actor, err := auth.Authenticate(context.Background(), tokens.Issue(jwt.User{ID: "u", TokenVersion: 1})); err != nil || actor != user {
		t.Fatalf("%v %v", actor, err)
	}
	for _, id := range []string{"revoked", "alias", "ghost"} {
		_, err := auth.Authenticate(context.Background(), tokens.Issue(jwt.User{ID: id, TokenVersion: 1}))
		if e, ok := apperr.As(err); !ok || e.Message != "Invalid or revoked session" {
			t.Errorf("%s: %v", id, err)
		}
	}
	if _, err := auth.Authenticate(context.Background(), "x"); err == nil || err.Error() != "Invalid or expired session" {
		t.Errorf("bad token: %v", err)
	}
}

type keys struct {
	rsa *rsa.PrivateKey
	ec  *ecdsa.PrivateKey
}

func newKeys(t *testing.T) keys {
	r, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	e, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return keys{r, e}
}

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func (k keys) jwks(extra ...map[string]any) []byte {
	x, y := k.ec.PublicKey.X.FillBytes(make([]byte, 32)), k.ec.PublicKey.Y.FillBytes(make([]byte, 32))
	set := []map[string]any{
		{"kty": "RSA", "kid": "rsa-1", "alg": "RS256", "use": "sig", "n": b64(k.rsa.N.Bytes()), "e": b64(big.NewInt(int64(k.rsa.E)).Bytes())},
		{"kty": "EC", "kid": "ec-1", "crv": "P-256", "x": b64(x), "y": b64(y)},
	}
	raw, _ := json.Marshal(map[string]any{"keys": append(set, extra...)})
	return raw
}

func (k keys) sign(t *testing.T, header, payload map[string]any) string {
	h, _ := json.Marshal(header)
	p, _ := json.Marshal(payload)
	input := b64(h) + "." + b64(p)
	digest := sha256.Sum256([]byte(input))
	var sig []byte
	if header["alg"] == "ES256" {
		r, s, err := ecdsa.Sign(rand.Reader, k.ec, digest[:])
		if err != nil {
			t.Fatal(err)
		}
		sig = append(r.FillBytes(make([]byte, 32)), s.FillBytes(make([]byte, 32))...)
	} else {
		var err error
		if sig, err = rsa.SignPKCS1v15(rand.Reader, k.rsa, crypto.SHA256, digest[:]); err != nil {
			t.Fatal(err)
		}
	}
	return input + "." + b64(sig)
}

func claims(extra map[string]any) map[string]any {
	c := map[string]any{"sub": "svc", "iss": "issuer", "aud": "service", "iat": 1790000000, "exp": 4102444800}
	for k, v := range extra {
		if v == nil {
			delete(c, k)
		} else {
			c[k] = v
		}
	}
	return c
}

var svc = &web.Actor{ID: "svc", Role: "user", Active: true}

func resolveSvc(_ context.Context, c map[string]any) (*web.Actor, error) {
	switch c["sub"] {
	case "svc":
		return svc, nil
	case 5.0:
		return &web.Actor{ID: "5", Active: true}, nil
	case "sleepy":
		return &web.Actor{ID: "sleepy"}, nil
	}
	return nil, nil
}

func TestSignedJWTAuthenticator(t *testing.T) {
	k := newKeys(t)
	set, err := ParseJWKS(k.jwks())
	if err != nil {
		t.Fatal(err)
	}
	auth, err := NewSignedJWTAuthenticator(set, "issuer", "service", resolveSvc)
	if err != nil {
		t.Fatal(err)
	}
	rs := map[string]any{"alg": "RS256", "kid": "rsa-1"}
	es := map[string]any{"alg": "ES256", "kid": "ec-1"}
	ok := []string{
		k.sign(t, rs, claims(nil)), k.sign(t, es, claims(nil)), k.sign(t, map[string]any{"alg": "RS256"}, claims(nil)),
		k.sign(t, rs, claims(map[string]any{"aud": []string{"other", "service"}, "iat": 4000000000})),
		k.sign(t, map[string]any{"alg": "RS256", "kid": "rsa-1", "crit": []string{"b64"}, "b64": true}, claims(nil)),
	}
	for i, token := range ok {
		if actor, err := auth.Authenticate(context.Background(), token); err != nil || actor != svc {
			t.Errorf("ok %d: %v", i, err)
		}
	}
	invalid := []string{
		k.sign(t, rs, claims(map[string]any{"aud": "other"})), k.sign(t, rs, claims(map[string]any{"iss": "x"})),
		k.sign(t, rs, claims(map[string]any{"exp": 1700000000})), k.sign(t, rs, claims(map[string]any{"nbf": 4102444000})),
		k.sign(t, rs, claims(map[string]any{"iat": nil})), k.sign(t, rs, claims(map[string]any{"iat": "1"})),
		k.sign(t, map[string]any{"alg": "RS256", "kid": "nope"}, claims(nil)),
		k.sign(t, map[string]any{"alg": "RS256", "kid": "ec-1"}, claims(nil)),
		k.sign(t, map[string]any{"alg": "RS256", "kid": "rsa-1", "crit": []string{"exp"}}, claims(nil)),
		k.sign(t, map[string]any{"alg": "RS256", "kid": "rsa-1", "crit": []string{"b64"}, "b64": false}, claims(nil)),
		"a.b", "", strings.Replace(k.sign(t, rs, claims(nil)), ".", ".e30.", 1),
	}
	for i, token := range invalid {
		if _, err := auth.Authenticate(context.Background(), token); err == nil || err.Error() != "Invalid service JWT" {
			t.Errorf("invalid %d: %v", i, err)
		}
	}
	for _, sub := range []any{5, "sleepy", "ghost"} {
		_, err := auth.Authenticate(context.Background(), k.sign(t, rs, claims(map[string]any{"sub": sub})))
		if err == nil || err.Error() != "Inactive service identity" {
			t.Errorf("sub %v: %v", sub, err)
		}
	}
	if _, err := NewSignedJWTAuthenticator(set, "", "service", resolveSvc); !errors.Is(err, ErrIssuerAudience) {
		t.Error(err)
	}
	if _, err := ParseJWKS([]byte(`{"keys":[1]}`)); !errors.Is(err, ErrMalformedJWKS) {
		t.Error(err)
	}
	// Two RSA keys and a token without kid: several candidates.
	other, _ := rsa.GenerateKey(rand.Reader, 2048)
	two, _ := ParseJWKS(k.jwks(map[string]any{"kty": "RSA", "n": b64(other.N.Bytes()), "e": "AQAB"}))
	twice, _ := NewSignedJWTAuthenticator(two, "issuer", "service", resolveSvc)
	if _, err := twice.Authenticate(context.Background(), k.sign(t, map[string]any{"alg": "RS256"}, claims(nil))); err == nil {
		t.Error("several candidates must fail")
	}
	// The clock option.
	late, _ := NewSignedJWTAuthenticator(set, "issuer", "service", resolveSvc, WithClock(func() time.Time { return time.Unix(4102444800, 0) }))
	if _, err := late.Authenticate(context.Background(), ok[0]); err == nil {
		t.Error("exp == now is expired")
	}
}

func TestRemoteJWKS(t *testing.T) {
	k := newKeys(t)
	var fetches atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fetches.Add(1)
		_, _ = w.Write(k.jwks())
	}))
	defer server.Close()
	auth, err := NewRemoteJWTAuthenticator(server.URL+"/jwks", "issuer", "service", resolveSvc, WithJWKSClient(server.Client()))
	if err != nil {
		t.Fatal(err)
	}
	token := k.sign(t, map[string]any{"alg": "ES256", "kid": "ec-1"}, claims(nil))
	for range 3 {
		if _, err := auth.Authenticate(context.Background(), token); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := auth.Authenticate(context.Background(), k.sign(t, map[string]any{"alg": "RS256", "kid": "later"}, claims(nil))); err == nil {
		t.Error("unknown kid")
	}
	if fetches.Load() != 1 {
		t.Errorf("fetched %d times; keys are cached and refetched after the cooldown only", fetches.Load())
	}
	for url, want := range map[string]error{"http://x/jwks": ErrJWKSNotHTTPS, "https://u:p@x/jwks": ErrJWKSNotHTTPS, "file:///j": ErrJWKSNotHTTPS, "not a url": ErrInvalidURL} {
		if _, err := NewRemoteJWTAuthenticator(url, "i", "a", resolveSvc); !errors.Is(err, want) {
			t.Errorf("%s: %v", url, err)
		}
	}
}

// --- remote feature ------------------------------------------------------------------------

type recorder struct {
	requests []*http.Request
	bodies   []string
	answer   func(*http.Request) (*http.Response, error)
}

func (r *recorder) RoundTrip(req *http.Request) (*http.Response, error) {
	body := ""
	if req.Body != nil {
		raw, _ := io.ReadAll(req.Body)
		body = string(raw)
	}
	r.requests, r.bodies = append(r.requests, req), append(r.bodies, body)
	return r.answer(req)
}

func answer(status int, body string) func(*http.Request) (*http.Response, error) {
	return func(req *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: status, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body)), Request: req}, nil
	}
}

func TestRemoteFeature(t *testing.T) {
	rec := &recorder{answer: answer(200, `{"ok":true}`)}
	f := Feature{ID: "y", Endpoints: []Endpoint{ep("POST", "/y/:id/:name.json", "guest", "y")}}
	remote, err := RemoteFeature(f, "https://EXAMPLE.test:443/api/", WithTransport(rec))
	if err != nil {
		t.Fatal(err)
	}
	h := http.Header{}
	h.Set("Authorization", "Bearer t")
	h.Set("Cookie", "s=1")
	ctx := WithQueryOrder(context.Background(), []string{"b", "a"})
	value, err := remote.Endpoints[0].Handle(&web.Context{Ctx: ctx, Params: map[string]string{"id": "a/b ~"}, Request: web.Request{
		Headers: h, Query: map[string]string{"a": "x y", "b": "~*"}, Raw: []byte(`{"z":1,"2":[1e21,"< >"],"a":null}`),
	}})
	if err != nil || value.(map[string]any)["ok"] != true {
		t.Fatalf("%v %v", value, err)
	}
	req := rec.requests[0]
	if got := req.URL.String(); got != "https://example.test/api/y/a%2Fb%20~/undefined.json?b=%7E*&a=x+y" {
		t.Errorf("url %s", got)
	}
	if rec.bodies[0] != `{"2":[1e+21,"<`+" "+`>"],"z":1,"a":null}` {
		t.Errorf("body %s", rec.bodies[0])
	}
	if req.Header.Get("Cookie") != "" || req.Header.Get("Authorization") != "Bearer t" || req.Header.Get("Content-Type") != "application/json" {
		t.Errorf("headers %v", req.Header)
	}
	for _, id := range []string{".", ".."} {
		if _, err := remote.Endpoints[0].Handle(&web.Context{Params: map[string]string{"id": id}}); err == nil || err.Error() != "Invalid route parameter" {
			t.Errorf("%q: %v", id, err)
		}
	}
	for status, want := range map[int]string{503: "Remote service request failed", 302: "Remote service request failed"} {
		rec.answer = answer(status, "secret")
		_, err := remote.Endpoints[0].Handle(&web.Context{Params: map[string]string{}})
		if e, ok := apperr.As(err); !ok || e.Status != status || e.Message != want {
			t.Errorf("%d: %v", status, err)
		}
	}
	rec.answer = answer(204, "")
	if v, err := remote.Endpoints[0].Handle(&web.Context{Params: map[string]string{}}); v != nil || err != nil {
		t.Errorf("204: %v %v", v, err)
	}
	rec.answer = func(*http.Request) (*http.Response, error) { return nil, errors.New("connection reset") }
	if _, err := remote.Endpoints[0].Handle(&web.Context{Params: map[string]string{}}); err == nil || err.Error() != "connection reset" {
		t.Errorf("transport: %v", err)
	}
	// Sorted query and body keys without an order; GET sends no body.
	get, _ := RemoteFeature(Feature{Endpoints: []Endpoint{ep("GET", "/g", "guest", "g")}}, "https://example.test", WithTransport(rec))
	rec.answer = answer(200, "1")
	if _, err := get.Endpoints[0].Handle(&web.Context{Request: web.Request{Query: map[string]string{"b": "", "a": "", "10": "", "2": ""}, Body: map[string]any{"x": 1}}}); err != nil {
		t.Fatal(err)
	}
	if last := rec.requests[len(rec.requests)-1]; last.URL.RawQuery != "2=&10=&a=&b=" || rec.bodies[len(rec.bodies)-1] != "" {
		t.Errorf("get %s %q", last.URL.RawQuery, rec.bodies[len(rec.bodies)-1])
	}
	for base, timeout := range map[string]time.Duration{
		"http://example.test": time.Second, "https://u:p@example.test": time.Second, "https://example.test/?k=1": time.Second,
		"https://example.test/#f": time.Second, "https://example.test": 1500 * time.Microsecond, "https://example.test/x": 1 << 31 * time.Millisecond,
	} {
		if _, err := RemoteFeature(f, base, WithTimeout(timeout)); !errors.Is(err, ErrRemoteConfiguration) {
			t.Errorf("%s %v: %v", base, timeout, err)
		}
	}
	if _, err := RemoteFeature(f, "example.test"); !errors.Is(err, ErrInvalidURL) {
		t.Error(err)
	}
}
