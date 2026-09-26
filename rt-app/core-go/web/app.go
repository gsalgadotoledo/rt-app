// Package web serves RT-App features over HTTP with the same behavior as the TypeScript
// framework: routing, access checks, JSON bodies and {"error": message} responses.
//
// App implements http.Handler, so one App runs unchanged behind the local server (Serve),
// AWS Lambda (package weblambda) and the command line (RunCLI).
package web

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"runtime/debug"
	"slices"
	"strings"
	"unicode/utf8"

	"rt.local/core-go/apperr"
)

// Access levels of an endpoint.
const (
	Guest         = "guest"         // anyone; no actor is resolved
	Authenticated = "authenticated" // any actor
	Permission    = "permission"    // owners, or actors granted Resource; mounted under /admin/app
	Owner         = "owner"         // owners only; mounted under /admin/app
)

// AdminPrefix is where owner and permission endpoints are mounted.
const AdminPrefix = "/admin/app"

// DefaultBodyLimit is the largest accepted request body (16 KiB).
const DefaultBodyLimit = 16 << 10

// Feature is a module's HTTP surface.
type Feature struct {
	ID        string
	Endpoints []Endpoint
}

// Endpoint is one route. Path uses ":name" parameters, as in TypeScript ("/flags/:key").
type Endpoint struct {
	Method   string
	Path     string
	Access   string
	Resource string
	Handle   func(*Context) (any, error)
}

// Actor is the authenticated caller.
type Actor struct {
	ID     string   `json:"id"`
	Role   string   `json:"role"`
	Grants []string `json:"grants,omitempty"`
}

// LocalOwner is the actor of local admin mode.
var LocalOwner = Actor{ID: "rt-app-root", Role: "owner"}

// Request is the decoded HTTP request handed to endpoints.
type Request struct {
	Method string
	// Path is the path as received (percent-encoded).
	Path string
	// Query holds the last value of each query parameter.
	Query   map[string]string
	Headers http.Header
	// Body is the JSON object sent by the client ({} when the body is empty).
	Body map[string]any
	// Raw is the body as received.
	Raw []byte
}

// Context is what an endpoint handler receives.
type Context struct {
	Ctx     context.Context
	Request Request
	// Params are the URL-decoded ":name" path parameters.
	Params map[string]string
	// Actor is nil for guest endpoints.
	Actor *Actor
}

// Authenticator resolves the actor of a request; (nil, nil) means anonymous.
type Authenticator func(r *http.Request) (*Actor, error)

// Option configures an App.
type Option func(*App)

// WithLocalAdmin makes every /admin/ request act as LocalOwner. Use it for local development
// only: it grants owner access to anyone who can reach the server.
func WithLocalAdmin() Option {
	return func(a *App) {
		a.adminAuth = func(*http.Request) (*Actor, error) { owner := LocalOwner; return &owner, nil }
	}
}

// WithAuthenticator resolves actors for endpoints outside /admin/.
func WithAuthenticator(auth Authenticator) Option { return func(a *App) { a.auth = auth } }

// WithAdminAuthenticator resolves actors for /admin/ endpoints.
func WithAdminAuthenticator(auth Authenticator) Option {
	return func(a *App) { a.adminAuth = auth }
}

// WithBodyLimit changes the body limit (default DefaultBodyLimit).
func WithBodyLimit(bytes int64) Option { return func(a *App) { a.bodyLimit = bytes } }

// WithLogger sets the logger for internal errors (default slog.Default()).
func WithLogger(logger *slog.Logger) Option { return func(a *App) { a.logger = logger } }

// App routes requests to feature endpoints. It is safe for concurrent use.
type App struct {
	routes    []route
	auth      Authenticator
	adminAuth Authenticator
	bodyLimit int64
	logger    *slog.Logger
}

type route struct {
	Endpoint
	segments []string // pattern split on "/"
	params   bool
}

// New mounts the features: guest and authenticated endpoints at their path, owner and
// permission endpoints under AdminPrefix only. Duplicate routes are an error.
func New(features []Feature, options ...Option) (*App, error) {
	a := &App{bodyLimit: DefaultBodyLimit, logger: slog.Default()}
	for _, option := range options {
		option(a)
	}
	seen := map[string]bool{}
	for _, f := range features {
		for _, e := range f.Endpoints {
			switch e.Access {
			case Guest, Authenticated:
			case Owner, Permission:
				e.Path = AdminPrefix + e.Path
			default:
				return nil, fmt.Errorf("web: %s %s %s: unknown access %q", f.ID, e.Method, e.Path, e.Access)
			}
			if e.Handle == nil || !strings.HasPrefix(e.Path, "/") {
				return nil, fmt.Errorf("web: %s %s %s: needs a handler and an absolute path", f.ID, e.Method, e.Path)
			}
			signature := e.Method + " " + e.Path
			if seen[signature] {
				return nil, fmt.Errorf("web: duplicate endpoint %s", signature)
			}
			seen[signature] = true
			a.routes = append(a.routes, route{Endpoint: e, segments: strings.Split(e.Path, "/"), params: strings.Contains(e.Path, ":")})
		}
	}
	// Literal routes take precedence over parameter routes.
	slices.SortStableFunc(a.routes, func(x, y route) int {
		switch {
		case x.params == y.params:
			return 0
		case x.params:
			return 1
		default:
			return -1
		}
	})
	return a, nil
}

// ServeHTTP reads the JSON body, dispatches and writes a JSON response.
func (a *App) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	raw, err := io.ReadAll(io.LimitReader(r.Body, a.bodyLimit+1))
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			writeJSON(w, http.StatusRequestEntityTooLarge, errorBody("Request body too large"))
			return
		}
		writeJSON(w, http.StatusBadRequest, errorBody("Invalid request body"))
		return
	}
	if int64(len(raw)) > a.bodyLimit {
		writeJSON(w, http.StatusRequestEntityTooLarge, errorBody("Request body too large"))
		return
	}
	body, ok := decodeObject(raw)
	if !ok {
		writeJSON(w, http.StatusBadRequest, errorBody("Invalid JSON"))
		return
	}
	target := RawTarget(r)
	path, rawQuery, _ := strings.Cut(target, "?")
	query := map[string]string{}
	values, _ := url.ParseQuery(rawQuery)
	for name, list := range values {
		query[name] = list[len(list)-1]
	}
	req := Request{Method: r.Method, Path: path, Query: query, Headers: r.Header, Body: body, Raw: raw}
	status, result := a.dispatch(r, req)
	writeJSON(w, status, result)
}

// dispatch mirrors the TypeScript framework: route, resolve the actor, check access, handle.
func (a *App) dispatch(r *http.Request, req Request) (status int, body any) {
	defer func() {
		if p := recover(); p != nil {
			a.logger.Error("rt-app: handler panic", "method", req.Method, "path", req.Path, "panic", p, "stack", string(debug.Stack()))
			status, body = http.StatusInternalServerError, errorBody("Internal error")
		}
	}()
	value, err := a.run(r, req)
	if err == nil {
		return http.StatusOK, value
	}
	if httpErr, ok := apperr.As(err); ok {
		return httpErr.Status, errorBody(httpErr.Message)
	}
	a.logger.Error("rt-app: internal error", "method", req.Method, "path", req.Path, "error", err)
	return http.StatusInternalServerError, errorBody("Internal error")
}

func (a *App) run(r *http.Request, req Request) (any, error) {
	var found *route
	var params map[string]string
	for i := range a.routes {
		rt := &a.routes[i]
		if rt.Method != req.Method {
			continue
		}
		values, ok := rt.match(req.Path)
		if !ok {
			continue
		}
		found = rt
		params = make(map[string]string, len(values))
		for name, value := range values {
			decoded, err := decodeURIComponent(value)
			if err != nil {
				return nil, apperr.BadRequest("Invalid URL")
			}
			params[name] = decoded
		}
		break
	}
	if found == nil {
		return nil, apperr.NotFound("Endpoint not found")
	}
	var actor *Actor
	if found.Access != Guest {
		auth := a.auth
		if strings.HasPrefix(found.Path, "/admin/") {
			auth = a.adminAuth
		}
		if auth != nil {
			var err error
			if actor, err = auth(r); err != nil {
				return nil, err
			}
		}
		if err := check(found.Endpoint, actor); err != nil {
			return nil, err
		}
	}
	return found.Handle(&Context{Ctx: r.Context(), Request: req, Params: params, Actor: actor})
}

// check enforces the endpoint's access level.
func check(e Endpoint, actor *Actor) error {
	if e.Access == Guest {
		return nil
	}
	if actor == nil {
		return apperr.New(http.StatusUnauthorized, "Sign in")
	}
	switch e.Access {
	case Owner:
		if actor.Role != "owner" {
			return apperr.New(http.StatusForbidden, "Only the owner can perform this operation")
		}
	case Permission:
		if actor.Role != "owner" && !slices.Contains(actor.Grants, e.Resource) {
			return apperr.New(http.StatusForbidden, "You do not have permission to access this resource")
		}
	}
	return nil
}

// match compares the percent-encoded path with the pattern; one trailing slash is allowed.
func (rt *route) match(path string) (map[string]string, bool) {
	if values, ok := rt.matchExact(path); ok {
		return values, true
	}
	if trimmed, ok := strings.CutSuffix(path, "/"); ok {
		return rt.matchExact(trimmed)
	}
	return nil, false
}

func (rt *route) matchExact(path string) (map[string]string, bool) {
	parts := strings.Split(path, "/")
	if len(parts) != len(rt.segments) {
		return nil, false
	}
	var values map[string]string
	for i, segment := range rt.segments {
		if name, ok := strings.CutPrefix(segment, ":"); ok {
			if parts[i] == "" {
				return nil, false
			}
			if values == nil {
				values = map[string]string{}
			}
			values[name] = parts[i]
		} else if segment != parts[i] {
			return nil, false
		}
	}
	return values, true
}

// decodeURIComponent follows JavaScript: bad escapes and invalid UTF-8 are errors.
func decodeURIComponent(s string) (string, error) {
	decoded, err := url.PathUnescape(s)
	if err != nil {
		return "", err
	}
	if !utf8.ValidString(decoded) {
		return "", errors.New("invalid UTF-8")
	}
	return decoded, nil
}

// decodeObject parses a JSON object body; an empty body is {}.
func decodeObject(raw []byte) (map[string]any, bool) {
	if len(bytes.TrimSpace(raw)) == 0 {
		if len(raw) == 0 {
			return map[string]any{}, true
		}
		return nil, false
	}
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil || body == nil {
		return nil, false
	}
	return body, true
}

func errorBody(message string) map[string]string { return map[string]string{"error": message} }

// Marshal encodes JSON like JavaScript's JSON.stringify: compact, without HTML escaping.
func Marshal(value any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	body, err := Marshal(value)
	if err != nil {
		slog.Error("rt-app: response is not JSON", "error", err)
		status, body = http.StatusInternalServerError, []byte(`{"error":"Internal error"}`)
	}
	h := w.Header()
	h.Set("Content-Type", "application/json")
	h.Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}
