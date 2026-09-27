// Package microservices hosts selected RT-App features as a service (New), authenticates
// callers with session or signed service tokens (SessionAuthenticator, SignedJWTAuthenticator)
// and forwards features to a remote service (RemoteFeature). It is the Go port of
// @gsalgadotoledo/rt-app-microservices; rt-app/spec/contracts/microservices.contract.yaml pins
// the behavior shared with TypeScript and Python.
//
// The service never trusts forwarded identity headers: the actor comes only from the
// Authorization header through an Authenticator. Request normalization and body limits stay
// the transport adapter's responsibility.
package microservices

import (
	"context"
	"errors"
	"log"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"rt.local/core-go/apperr"
	"rt.local/core-go/internal/js"
	"rt.local/core-go/internal/uuid"
	"rt.local/core-go/web"
)

// Authenticator resolves the actor of a bearer token. Errors carrying an *apperr.HTTPError are
// answered with their status; any other error is a 500.
type Authenticator interface {
	Authenticate(ctx context.Context, token string) (*web.Actor, error)
}

// Endpoint is a web endpoint plus its subscription metadata: a non-nil Subscription marks a
// metered endpoint, which runs through Options.InvokeMetered.
type Endpoint struct {
	web.Endpoint
	Subscription any
}

// Feature is a group of endpoints hosted or forwarded together.
type Feature struct {
	ID        string
	Endpoints []Endpoint
}

// FromWeb wraps a web.Feature (no metered endpoints).
func FromWeb(f web.Feature) Feature {
	out := Feature{ID: f.ID, Endpoints: make([]Endpoint, len(f.Endpoints))}
	for i, e := range f.Endpoints {
		out.Endpoints[i] = Endpoint{Endpoint: e}
	}
	return out
}

// Metric is what Observe receives after every request.
type Metric struct {
	RequestID  string  `json:"requestId"`
	Route      string  `json:"route"`
	Status     int     `json:"status"`
	DurationMs float64 `json:"durationMs"`
}

// Options configure a Service.
type Options struct {
	Features     []Feature
	Authenticate Authenticator
	// InvokeMetered reserves and settles credits around work for metered endpoints. Without
	// it, metered endpoints answer 503 "Metering adapter required".
	InvokeMetered func(ctx context.Context, endpoint Endpoint, actor *web.Actor, work func() (any, error)) (any, error)
	// Observe receives route-level telemetry; its errors are ignored.
	Observe func(ctx context.Context, metric Metric) error
}

// Response is the answer of Handle: the JSON body and the x-request-id header.
type Response struct {
	Status  int               `json:"status"`
	Body    any               `json:"body"`
	Headers map[string]string `json:"headers"`
}

type route struct {
	endpoint Endpoint
	names    []string
	pattern  *regexp.Regexp
}

// Service hosts features. It is safe for concurrent use.
type Service struct {
	routes  []route
	options Options
}

// ErrDuplicateRoute is returned by New when two endpoints share a method and path.
var ErrDuplicateRoute = errors.New("Duplicate service route")

// New builds a service. Routes keep declaration order: the first match wins.
func New(options Options) (*Service, error) {
	s := &Service{options: options}
	seen := map[string]bool{}
	for _, f := range options.Features {
		for _, e := range f.Endpoints {
			var names []string
			segments := strings.Split(e.Path, "/")
			for i, segment := range segments {
				if name, ok := strings.CutPrefix(segment, ":"); ok {
					names = append(names, name)
					segments[i] = "([^/]+)"
				} else {
					segments[i] = regexp.QuoteMeta(segment)
				}
			}
			key := e.Method + " " + e.Path
			if seen[key] {
				return nil, ErrDuplicateRoute
			}
			seen[key] = true
			s.routes = append(s.routes, route{e, names, regexp.MustCompile("^" + strings.Join(segments, "/") + "/?$")})
		}
	}
	return s, nil
}

// Handle answers one request. It never returns an error: failures become their HTTP answer.
func (s *Service) Handle(ctx context.Context, r web.Request) Response {
	requestID := uuid.New()
	start := time.Now()
	path := "/unmatched"
	status, body := s.handle(ctx, r, requestID, &path)
	if s.options.Observe != nil {
		metric := Metric{RequestID: requestID, Route: path, Status: status, DurationMs: float64(time.Since(start).Nanoseconds()) / 1e6}
		func() {
			defer func() { _ = recover() }() // telemetry must not change a completed operation
			_ = s.options.Observe(ctx, metric)
		}()
	}
	return Response{Status: status, Body: body, Headers: map[string]string{"x-request-id": requestID}}
}

func (s *Service) handle(ctx context.Context, r web.Request, requestID string, routePath *string) (int, any) {
	value, err := s.dispatch(ctx, r, requestID, routePath)
	if err == nil {
		return http.StatusOK, value
	}
	if httpErr, ok := apperr.As(err); ok {
		return httpErr.Status, map[string]any{"error": httpErr.Message}
	}
	log.Printf("microservices: %s %s: %v", r.Method, r.Path, err)
	return http.StatusInternalServerError, map[string]any{"error": "Internal error"}
}

func (s *Service) dispatch(ctx context.Context, r web.Request, requestID string, routePath *string) (any, error) {
	var selected *route
	for i := range s.routes {
		if s.routes[i].endpoint.Method == r.Method && s.routes[i].pattern.MatchString(r.Path) {
			selected = &s.routes[i]
			break
		}
	}
	if selected == nil {
		return nil, apperr.NotFound("Not found")
	}
	*routePath = selected.endpoint.Path
	var actor *web.Actor
	if authorization := r.Headers.Get("Authorization"); authorization != "" {
		if !bearer(authorization) {
			return nil, apperr.New(http.StatusUnauthorized, "Invalid authorization")
		}
		var err error
		if actor, err = s.options.Authenticate.Authenticate(ctx, authorization[7:]); err != nil {
			return nil, err
		}
	}
	if err := authorize(selected.endpoint, actor); err != nil {
		return nil, err
	}
	match := selected.pattern.FindStringSubmatch(r.Path)
	params := map[string]string{}
	for i, name := range selected.names {
		value, ok := DecodeURIComponent(match[i+1])
		if !ok {
			return nil, apperr.BadRequest("Invalid route encoding")
		}
		params[name] = value
	}
	headers := r.Headers.Clone()
	if headers == nil {
		headers = http.Header{}
	}
	headers.Set("X-Request-Id", requestID)
	request := r
	request.Headers = headers
	endpoint := selected.endpoint
	work := func() (any, error) {
		return endpoint.Handle(&web.Context{Ctx: ctx, Request: request, Params: params, Actor: actor})
	}
	if endpoint.Subscription != nil {
		if s.options.InvokeMetered == nil {
			return nil, apperr.New(http.StatusServiceUnavailable, "Metering adapter required")
		}
		return s.options.InvokeMetered(ctx, endpoint, actor, work)
	}
	return work()
}

// bearer is /^Bearer [^\s]+$/i with the JavaScript \s set.
func bearer(header string) bool {
	if len(header) < 8 || !strings.EqualFold(header[:7], "Bearer ") {
		return false
	}
	return !strings.ContainsFunc(header[7:], js.IsSpace)
}

func authorize(e Endpoint, actor *web.Actor) error {
	if e.Access == "guest" {
		return nil
	}
	if actor == nil || !actor.Active {
		return apperr.New(http.StatusUnauthorized, "Sign in")
	}
	if e.Access == "owner" && actor.Role != "owner" {
		return apperr.New(http.StatusForbidden, "Owner permission required")
	}
	if e.Access == "permission" && !(slices.Contains(actor.Grants, e.Resource) || (!e.ExplicitGrant && actor.Role == "owner")) {
		return apperr.New(http.StatusForbidden, "Permission required")
	}
	return nil
}

// DecodeURIComponent is JavaScript's decodeURIComponent: every "%" needs two hex digits and
// each run of escapes must be well-formed UTF-8 (no overlong forms, surrogates or code points
// above U+10FFFF); "+" stays "+". ok is false where JavaScript throws URIError.
func DecodeURIComponent(s string) (string, bool) {
	if !strings.Contains(s, "%") {
		return s, true
	}
	var out strings.Builder
	var run []byte
	flush := func() bool {
		if len(run) > 0 && !utf8.Valid(run) {
			return false
		}
		out.Write(run)
		run = run[:0]
		return true
	}
	for i := 0; i < len(s); i++ {
		if s[i] != '%' {
			if !flush() {
				return "", false
			}
			out.WriteByte(s[i])
			continue
		}
		if i+2 >= len(s) || !isHex(s[i+1]) || !isHex(s[i+2]) {
			return "", false
		}
		run = append(run, unhex(s[i+1])<<4|unhex(s[i+2]))
		i += 2
	}
	if !flush() {
		return "", false
	}
	return out.String(), true
}

func isHex(c byte) bool {
	return '0' <= c && c <= '9' || 'a' <= c && c <= 'f' || 'A' <= c && c <= 'F'
}

func unhex(c byte) byte {
	switch {
	case c <= '9':
		return c - '0'
	case c <= 'F':
		return c - 'A' + 10
	default:
		return c - 'a' + 10
	}
}
