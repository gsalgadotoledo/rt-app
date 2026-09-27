package main

// Subjects: microservice, session-authenticator, signed-jwt-authenticator, remote-feature
// (mirrors spec/hosts/node/microservices.mjs). Features, authenticators, metering and remote
// responses are declared as data in init; actors are returned exactly as declared.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"rt.local/core-go/apperr"
	"rt.local/core-go/conformance"
	"rt.local/core-go/internal/js"
	"rt.local/core-go/jwt"
	"rt.local/core-go/microservices"
	"rt.local/core-go/web"
)

func init() {
	register("microservice", msServiceSubject)
	register("session-authenticator", msSessionSubject)
	register("signed-jwt-authenticator", msSignedSubject)
	register("remote-feature", msRemoteSubject)
}

// msFailure is {status?, message}: an HTTP error with a status, a plain error otherwise.
type msFailure struct {
	Status  *int   `json:"status"`
	Message string `json:"message"`
}

func (f msFailure) err() error {
	if f.Status != nil {
		return apperr.New(*f.Status, f.Message)
	}
	return errors.New(f.Message)
}

// msActors remembers the declared JSON of every actor it hands out, so results show actors
// exactly as declared (web.Actor drops empty grants and false fields).
type msActors struct {
	mu  sync.Mutex
	raw map[*web.Actor]json.RawMessage
}

func (a *msActors) actor(raw json.RawMessage) (*web.Actor, error) {
	var actor web.Actor
	if err := json.Unmarshal(raw, &actor); err != nil {
		return nil, err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.raw == nil {
		a.raw = map[*web.Actor]json.RawMessage{}
	}
	a.raw[&actor] = raw
	return &actor, nil
}

func (a *msActors) json(actor *web.Actor) any {
	if actor == nil {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if raw, ok := a.raw[actor]; ok {
		return raw
	}
	return actor
}

// msDeclaredEndpoint is an endpoint as the contract declares it.
type msDeclaredEndpoint struct {
	Method        string          `json:"method"`
	Path          string          `json:"path"`
	Access        string          `json:"access"`
	Resource      string          `json:"resource"`
	ExplicitGrant bool            `json:"explicitGrant"`
	Subscription  json.RawMessage `json:"subscription"`
	Tool          *web.Tool       `json:"tool"`
	Reply         json.RawMessage `json:"reply"`
}

type msDeclaredFeature struct {
	ID        string               `json:"id"`
	Endpoints []msDeclaredEndpoint `json:"endpoints"`
	Seeds     json.RawMessage      `json:"seeds"`
}

// msLowerHeaders returns header names in lower case (first value each), as Node shows them.
func msLowerHeaders(h http.Header) map[string]string {
	out := map[string]string{}
	for name, values := range h {
		if len(values) > 0 {
			out[strings.ToLower(name)] = values[0]
		}
	}
	return out
}

// msHandler: reply {value} is returned, {error} is returned as an error, no reply echoes
// {params, actor, headers}.
func msHandler(reply json.RawMessage, actors *msActors) func(*web.Context) (any, error) {
	var fields map[string]json.RawMessage
	_ = json.Unmarshal(reply, &fields)
	return func(c *web.Context) (any, error) {
		if raw, ok := fields["error"]; ok && string(raw) != "null" {
			var f msFailure
			_ = json.Unmarshal(raw, &f)
			return nil, f.err()
		}
		if raw, ok := fields["value"]; ok {
			return raw, nil
		}
		return map[string]any{"params": c.Params, "actor": actors.json(c.Actor), "headers": msLowerHeaders(c.Request.Headers)}, nil
	}
}

func msFeature(f msDeclaredFeature, actors *msActors) microservices.Feature {
	out := microservices.Feature{ID: f.ID}
	for _, e := range f.Endpoints {
		endpoint := microservices.Endpoint{Endpoint: web.Endpoint{
			Method: e.Method, Path: e.Path, Access: e.Access, Resource: e.Resource,
			ExplicitGrant: e.ExplicitGrant, Tool: e.Tool, Handle: msHandler(e.Reply, actors),
		}}
		if len(e.Subscription) > 0 && string(e.Subscription) != "null" {
			endpoint.Subscription = e.Subscription
		}
		out.Endpoints = append(out.Endpoints, endpoint)
	}
	return out
}

// msOrderedKeys returns the keys of a JSON object in JavaScript property order.
func msOrderedKeys(raw json.RawMessage) []string {
	dec := json.NewDecoder(bytes.NewReader(raw))
	if token, err := dec.Token(); err != nil || token != json.Delim('{') {
		return nil
	}
	var indices, names []string
	for dec.More() {
		token, err := dec.Token()
		if err != nil {
			return nil
		}
		key, _ := token.(string)
		var skip json.RawMessage
		if dec.Decode(&skip) != nil {
			return nil
		}
		if msArrayIndex(key) {
			indices = append(indices, key)
		} else {
			names = append(names, key)
		}
	}
	// Array-index keys come first in ascending order (they have no leading zeros).
	for i := 1; i < len(indices); i++ {
		for j := i; j > 0 && (len(indices[j]) < len(indices[j-1]) || len(indices[j]) == len(indices[j-1]) && indices[j] < indices[j-1]); j-- {
			indices[j], indices[j-1] = indices[j-1], indices[j]
		}
	}
	return append(indices, names...)
}

func msArrayIndex(k string) bool {
	if k == "" || len(k) > 10 || (len(k) > 1 && k[0] == '0') {
		return false
	}
	var n uint64
	for i := 0; i < len(k); i++ {
		if k[i] < '0' || k[i] > '9' {
			return false
		}
		n = n*10 + uint64(k[i]-'0')
	}
	return n < 1<<32-1
}

// msRequest decodes {method, path, headers, query, body, ip} with the facade defaults and the
// query order of the wire object.
func msRequest(ctx context.Context, raw json.RawMessage) (context.Context, web.Request, error) {
	var wire struct {
		Method  *string           `json:"method"`
		Path    *string           `json:"path"`
		Headers map[string]string `json:"headers"`
		Query   json.RawMessage   `json:"query"`
		Body    json.RawMessage   `json:"body"`
		IP      *string           `json:"ip"`
	}
	if len(raw) > 0 && string(raw) != "null" {
		if err := json.Unmarshal(raw, &wire); err != nil {
			return ctx, web.Request{}, err
		}
	}
	r := web.Request{Method: "GET", Path: "/", Query: map[string]string{}, Headers: http.Header{}, Body: map[string]any{}, Raw: []byte("{}"), IP: "127.0.0.1"}
	if wire.Method != nil {
		r.Method = *wire.Method
	}
	if wire.Path != nil {
		r.Path = *wire.Path
	}
	if wire.IP != nil {
		r.IP = *wire.IP
	}
	for name, value := range wire.Headers {
		r.Headers[http.CanonicalHeaderKey(name)] = []string{value}
	}
	if len(wire.Query) > 0 && string(wire.Query) != "null" {
		if err := json.Unmarshal(wire.Query, &r.Query); err != nil {
			return ctx, r, err
		}
		ctx = microservices.WithQueryOrder(ctx, msOrderedKeys(wire.Query))
	}
	if len(wire.Body) > 0 && string(wire.Body) != "null" {
		if err := json.Unmarshal(wire.Body, &r.Body); err != nil {
			return ctx, r, err
		}
		r.Raw = wire.Body
	}
	return ctx, r, nil
}

func msServiceSubject(_ context.Context, init json.RawMessage) (conformance.Instance, error) {
	var config struct {
		Features []msDeclaredFeature        `json:"features"`
		Tokens   map[string]json.RawMessage `json:"tokens"`
		Metering json.RawMessage            `json:"metering"`
		Observe  string                     `json:"observe"`
	}
	if err := json.Unmarshal(init, &config); err != nil {
		return conformance.Instance{}, err
	}
	actors := &msActors{}
	var mu sync.Mutex
	authentications, observations, metered := []string{}, []microservices.Metric{}, []map[string]any{}
	options := microservices.Options{
		Authenticate: msTokenTable{tokens: config.Tokens, actors: actors, log: func(token string) {
			mu.Lock()
			authentications = append(authentications, token)
			mu.Unlock()
		}},
	}
	for _, f := range config.Features {
		options.Features = append(options.Features, msFeature(f, actors))
	}
	if len(config.Metering) > 0 && string(config.Metering) != "null" {
		var metering struct {
			Error *msFailure `json:"error"`
		}
		_ = json.Unmarshal(config.Metering, &metering)
		options.InvokeMetered = func(_ context.Context, e microservices.Endpoint, actor *web.Actor, work func() (any, error)) (any, error) {
			var id any
			if actor != nil {
				id = actor.ID
			}
			mu.Lock()
			metered = append(metered, map[string]any{"resource": e.Resource, "subscription": e.Subscription, "actor": id})
			mu.Unlock()
			if metering.Error != nil {
				return nil, metering.Error.err()
			}
			return work()
		}
	}
	if config.Observe != "none" {
		options.Observe = func(_ context.Context, metric microservices.Metric) error {
			mu.Lock()
			observations = append(observations, metric)
			mu.Unlock()
			if config.Observe == "fail" {
				return errors.New("telemetry down")
			}
			return nil
		}
	}
	service, err := microservices.New(options)
	if err != nil {
		return conformance.Instance{}, err
	}
	snapshot := func(value any) conformance.Method {
		return func(context.Context, []json.RawMessage) (any, error) {
			mu.Lock()
			defer mu.Unlock()
			raw, err := json.Marshal(value)
			return json.RawMessage(raw), err
		}
	}
	return conformance.Instance{Methods: map[string]conformance.Method{
		// handle(request) → {status, body, headers}
		"handle": func(ctx context.Context, args []json.RawMessage) (any, error) {
			ctx, request, err := msRequest(ctx, arg(args, 0))
			if err != nil {
				return nil, err
			}
			return service.Handle(ctx, request), nil
		},
		"authentications": func(ctx context.Context, args []json.RawMessage) (any, error) {
			return snapshot(&authentications)(ctx, args)
		},
		"observations": func(ctx context.Context, args []json.RawMessage) (any, error) {
			return snapshot(&observations)(ctx, args)
		},
		"metered": func(ctx context.Context, args []json.RawMessage) (any, error) {
			return snapshot(&metered)(ctx, args)
		},
	}}, nil
}

// msTokenTable authenticates from init.tokens: an actor, {error}, or 401 "Unknown token".
type msTokenTable struct {
	tokens map[string]json.RawMessage
	actors *msActors
	log    func(string)
}

func (t msTokenTable) Authenticate(_ context.Context, token string) (*web.Actor, error) {
	t.log(token)
	raw, ok := t.tokens[token]
	if !ok {
		return nil, apperr.New(http.StatusUnauthorized, "Unknown token")
	}
	var entry struct {
		Error *msFailure `json:"error"`
	}
	if json.Unmarshal(raw, &entry) == nil && entry.Error != nil {
		return nil, entry.Error.err()
	}
	return t.actors.actor(raw)
}

func msSessionSubject(_ context.Context, init json.RawMessage) (conformance.Instance, error) {
	var config struct {
		Secret   string                     `json:"secret"`
		Issuer   *string                    `json:"issuer"`
		Audience *string                    `json:"audience"`
		Actors   map[string]json.RawMessage `json:"actors"`
	}
	if err := json.Unmarshal(init, &config); err != nil {
		return conformance.Instance{}, err
	}
	clock, err := newClock(init)
	if err != nil {
		return conformance.Instance{}, err
	}
	options := []jwt.Option{jwt.WithClock(clock.Now)}
	if config.Issuer != nil {
		options = append(options, jwt.WithIssuer(*config.Issuer))
	}
	if config.Audience != nil {
		options = append(options, jwt.WithAudience(*config.Audience))
	}
	tokens, err := jwt.New(config.Secret, options...)
	if err != nil {
		return conformance.Instance{}, err
	}
	actors := &msActors{}
	var mu sync.Mutex
	resolved := []string{}
	auth := microservices.NewSessionAuthenticator(tokens, func(_ context.Context, id string) (*web.Actor, error) {
		mu.Lock()
		resolved = append(resolved, id)
		mu.Unlock()
		raw, ok := config.Actors[id]
		if !ok {
			return nil, nil
		}
		return actors.actor(raw)
	})
	return conformance.Instance{Methods: map[string]conformance.Method{
		"authenticate": func(ctx context.Context, args []json.RawMessage) (any, error) {
			actor, err := auth.Authenticate(ctx, argString(args, 0))
			if err != nil {
				return nil, err
			}
			return actors.json(actor), nil
		},
		"issue": func(_ context.Context, args []json.RawMessage) (any, error) {
			var user struct {
				ID           string `json:"id"`
				TokenVersion int    `json:"tokenVersion"`
			}
			if err := decodeArgs(args, &user); err != nil {
				return nil, err
			}
			return tokens.Issue(jwt.User{ID: user.ID, TokenVersion: user.TokenVersion}), nil
		},
		"resolved": func(context.Context, []json.RawMessage) (any, error) {
			mu.Lock()
			defer mu.Unlock()
			return append([]string{}, resolved...), nil
		},
		"setNow": clock.setNow,
	}}, nil
}

func msSignedSubject(_ context.Context, init json.RawMessage) (conformance.Instance, error) {
	var config struct {
		JWKS     json.RawMessage            `json:"jwks"`
		Issuer   string                     `json:"issuer"`
		Audience string                     `json:"audience"`
		Actors   map[string]json.RawMessage `json:"actors"`
	}
	if err := json.Unmarshal(init, &config); err != nil {
		return conformance.Instance{}, err
	}
	keys, err := microservices.ParseJWKS(config.JWKS)
	if err != nil {
		return conformance.Instance{}, err
	}
	actors := &msActors{}
	var mu sync.Mutex
	resolved := []map[string]any{}
	resolve := func(_ context.Context, claims map[string]any) (*web.Actor, error) {
		mu.Lock()
		resolved = append(resolved, claims)
		mu.Unlock()
		raw, ok := config.Actors[js.String(claims["sub"])]
		if !ok {
			return nil, nil
		}
		return actors.actor(raw)
	}
	auth, err := microservices.NewSignedJWTAuthenticator(keys, config.Issuer, config.Audience, resolve)
	if err != nil {
		return conformance.Instance{}, err
	}
	return conformance.Instance{Methods: map[string]conformance.Method{
		"authenticate": func(ctx context.Context, args []json.RawMessage) (any, error) {
			actor, err := auth.Authenticate(ctx, argString(args, 0))
			if err != nil {
				return nil, err
			}
			return actors.json(actor), nil
		},
		"resolved": func(context.Context, []json.RawMessage) (any, error) {
			mu.Lock()
			defer mu.Unlock()
			return append([]map[string]any{}, resolved...), nil
		},
		// remote(url, issuer, audience) → null: configuration checks only, nothing is fetched.
		"remote": func(_ context.Context, args []json.RawMessage) (any, error) {
			_, err := microservices.NewRemoteJWTAuthenticator(argString(args, 0), argString(args, 1), argString(args, 2), resolve)
			return nil, err
		},
	}}, nil
}

// msRecorder is a transport that records requests and answers init.responses in order.
type msRecorder struct {
	mu        sync.Mutex
	requests  []map[string]any
	responses []json.RawMessage
}

func (r *msRecorder) RoundTrip(req *http.Request) (*http.Response, error) {
	var body any
	if req.Body != nil {
		raw, err := io.ReadAll(req.Body)
		if err != nil {
			return nil, err
		}
		body = string(raw)
	}
	r.mu.Lock()
	r.requests = append(r.requests, map[string]any{
		"url": req.URL.String(), "method": req.Method, "headers": msLowerHeaders(req.Header),
		"body": body, "redirect": "error", "timeout": true,
	})
	var next json.RawMessage
	if len(r.responses) > 0 {
		next, r.responses = r.responses[0], r.responses[1:]
	}
	r.mu.Unlock()
	if next == nil {
		return nil, errors.New("No response left")
	}
	var answer struct {
		Status  int             `json:"status"`
		JSON    json.RawMessage `json:"json"`
		Text    *string         `json:"text"`
		Network *string         `json:"network"`
	}
	if err := json.Unmarshal(next, &answer); err != nil {
		return nil, err
	}
	if answer.Network != nil {
		return nil, errors.New(*answer.Network)
	}
	payload := ""
	if answer.JSON != nil {
		payload = string(answer.JSON)
	} else if answer.Text != nil {
		payload = *answer.Text
	}
	return &http.Response{
		StatusCode: answer.Status, Status: http.StatusText(answer.Status), Proto: "HTTP/1.1", ProtoMajor: 1, ProtoMinor: 1,
		Header: http.Header{}, Body: io.NopCloser(strings.NewReader(payload)), ContentLength: int64(len(payload)), Request: req,
	}, nil
}

func msRemoteSubject(_ context.Context, init json.RawMessage) (conformance.Instance, error) {
	var config struct {
		Feature   msDeclaredFeature `json:"feature"`
		BaseURL   string            `json:"baseUrl"`
		TimeoutMs *float64          `json:"timeoutMs"`
		Responses []json.RawMessage `json:"responses"`
	}
	if err := json.Unmarshal(init, &config); err != nil {
		return conformance.Instance{}, err
	}
	recorder := &msRecorder{responses: config.Responses}
	options := []microservices.RemoteOption{microservices.WithTransport(recorder)}
	if config.TimeoutMs != nil {
		options = append(options, microservices.WithTimeout(time.Duration(*config.TimeoutMs*float64(time.Millisecond))))
	}
	actors := &msActors{}
	proxied, err := microservices.RemoteFeature(msFeature(config.Feature, actors), config.BaseURL, options...)
	if err != nil {
		return conformance.Instance{}, err
	}
	return conformance.Instance{Methods: map[string]conformance.Method{
		// call(index, {params, request}) → endpoints[index].Handle
		"call": func(ctx context.Context, args []json.RawMessage) (any, error) {
			var index int
			var callContext struct {
				Params  map[string]string `json:"params"`
				Request json.RawMessage   `json:"request"`
			}
			if err := decodeArgs(args, &index, &callContext); err != nil {
				return nil, err
			}
			ctx, request, err := msRequest(ctx, callContext.Request)
			if err != nil {
				return nil, err
			}
			if callContext.Params == nil {
				callContext.Params = map[string]string{}
			}
			return proxied.Endpoints[index].Handle(&web.Context{Ctx: ctx, Request: request, Params: callContext.Params})
		},
		"requests": func(context.Context, []json.RawMessage) (any, error) {
			recorder.mu.Lock()
			defer recorder.mu.Unlock()
			return append([]map[string]any{}, recorder.requests...), nil
		},
		// feature() → {id, seeds?, migrations: [], endpoints} without handlers
		"feature": func(context.Context, []json.RawMessage) (any, error) {
			endpoints := []map[string]any{}
			for _, e := range proxied.Endpoints {
				endpoint := map[string]any{"method": e.Method, "path": e.Path, "access": e.Access, "resource": e.Resource}
				if e.ExplicitGrant {
					endpoint["explicitGrant"] = true
				}
				if e.Tool != nil {
					endpoint["tool"] = e.Tool
				}
				if e.Subscription != nil {
					endpoint["subscription"] = e.Subscription
				}
				endpoints = append(endpoints, endpoint)
			}
			out := map[string]any{"id": proxied.ID, "migrations": []any{}, "endpoints": endpoints}
			if len(config.Feature.Seeds) > 0 {
				out["seeds"] = config.Feature.Seeds
			}
			return out, nil
		},
	}}, nil
}
