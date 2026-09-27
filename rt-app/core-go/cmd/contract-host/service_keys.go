package main

// Subject: serviceKeys (package servicekeys). Mirrors spec/hosts/node/service-keys.mjs: a memory
// store (init.rows), a settable clock (init.now), init.secret, init.keys (configured keys),
// init.scopes and a deterministic random source (call n returns `bytes` bytes of value n % 256
// as base64url). See docs/polyglot/service-keys.md.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"

	"rt.local/core-go/conformance"
	"rt.local/core-go/servicekeys"
	"rt.local/core-go/web"
)

func init() {
	register("serviceKeys", serviceKeysSubject)
}

// serviceActorView is the wire form of a service actor (the TypeScript Actor fields).
func serviceActorView(a *web.Actor) map[string]any {
	grants := make([]any, len(a.Grants))
	for i, g := range a.Grants {
		grants[i] = g
	}
	return map[string]any{"id": a.ID, "role": a.Role, "grants": grants, "email": a.Email, "name": a.Name, "tokenVersion": float64(a.TokenVersion), "active": a.Active}
}

// serviceEndpoint reads a wire endpoint {access, resource}.
func serviceEndpoint(v any) web.Endpoint {
	o, _ := v.(map[string]any)
	var e web.Endpoint
	e.Access, _ = o["access"].(string)
	e.Resource, _ = o["resource"].(string)
	return e
}

func stringList(v any) []string {
	var out []string
	for _, item := range asList(v) {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func asList(v any) []any {
	l, _ := v.([]any)
	return l
}

func serviceKeysSubject(ctx context.Context, init json.RawMessage) (conformance.Instance, error) {
	var config struct {
		Now    *string `json:"now"`
		Secret string  `json:"secret"`
		Keys   any     `json:"keys"`
		Scopes []any   `json:"scopes"`
	}
	if err := json.Unmarshal(init, &config); err != nil {
		return conformance.Instance{}, err
	}
	iso := "2026-01-01T00:00:00.000Z"
	if config.Now != nil {
		iso = *config.Now
	}
	start, err := parseISO(iso)
	if err != nil {
		return conformance.Instance{}, errors.New("init.now must be an ISO 8601 date")
	}
	now := float64(start.UnixMilli())
	store, err := memoryStore(ctx, init)
	if err != nil {
		return conformance.Instance{}, err
	}
	calls := 0
	random := func(n int) string {
		calls++
		return base64.RawURLEncoding.EncodeToString([]byte(strings.Repeat(string([]byte{byte(calls % 256)}), n)))
	}
	keys, err := servicekeys.New(store, config.Secret, config.Keys, stringList(config.Scopes),
		servicekeys.WithClock(func() float64 { return now }), servicekeys.WithRandom(random))
	if err != nil {
		return conformance.Instance{}, err
	}
	feature := keys.Feature()
	type method = conformance.Method
	all := func(ctx context.Context, pk string) ([]any, error) {
		var out []any
		cursor := ""
		for {
			page, err := store.List(ctx, pk, cursor)
			if err != nil {
				return nil, err
			}
			for _, r := range page.Items {
				item := map[string]any{"sk": r.SK}
				for k, v := range r.Data {
					item[k] = v
				}
				out = append(out, item)
			}
			if cursor = page.Cursor; cursor == "" {
				return nonNil(out), nil
			}
		}
	}
	return conformance.Instance{Methods: map[string]method{
		"parse": func(_ context.Context, a []json.RawMessage) (any, error) {
			records, err := servicekeys.Parse(argAny(a, 0), stringList(argAny(a, 1)))
			if err != nil {
				return nil, err
			}
			out := []any{}
			for _, k := range records {
				out = append(out, map[string]any{"id": k["id"], "secretHash": k["secretHash"], "scopes": k["scopes"], "description": k["description"], "rateLimit": k["rateLimit"]})
			}
			return out, nil
		},
		"list": func(ctx context.Context, _ []json.RawMessage) (any, error) { return keys.List(ctx) },
		"create": func(ctx context.Context, a []json.RawMessage) (any, error) {
			return keys.Create(ctx, objectOr(argAny(a, 0)), argString(a, 1))
		},
		"rotate": func(ctx context.Context, a []json.RawMessage) (any, error) {
			return keys.Rotate(ctx, argString(a, 0), argString(a, 1))
		},
		"revoke": func(ctx context.Context, a []json.RawMessage) (any, error) {
			return keys.Revoke(ctx, argString(a, 0), argString(a, 1))
		},
		"actor": func(ctx context.Context, a []json.RawMessage) (any, error) {
			actor, err := keys.Authenticate(ctx, argAny(a, 0))
			if err != nil {
				return nil, err
			}
			return serviceActorView(actor), nil
		},
		"check": func(_ context.Context, a []json.RawMessage) (any, error) {
			return nil, keys.Check(serviceEndpoint(argAny(a, 0)), actorFrom(argAny(a, 1)))
		},
		"authorize": func(ctx context.Context, a []json.RawMessage) (any, error) {
			actor, err := keys.Authenticate(ctx, argAny(a, 0))
			if err != nil {
				return nil, err
			}
			if err := keys.Check(serviceEndpoint(argAny(a, 1)), actor); err != nil {
				return nil, err
			}
			return serviceActorView(actor), nil
		},
		"hash": func(_ context.Context, a []json.RawMessage) (any, error) {
			return servicekeys.Hash(argString(a, 0)), nil
		},
		"endpoints": func(context.Context, []json.RawMessage) (any, error) {
			out := make([]any, len(feature.Endpoints))
			for i, e := range feature.Endpoints {
				item := map[string]any{"method": e.Method, "path": e.Path, "access": e.Access, "resource": e.Resource}
				if e.Tool != nil {
					item["tool"] = e.Tool.Name
				}
				out[i] = item
			}
			return out, nil
		},
		"admin": func(context.Context, []json.RawMessage) (any, error) { return servicekeys.Admin(), nil },
		"self": func(ctx context.Context, a []json.RawMessage) (any, error) {
			return keys.SelfView(ctx, actorFrom(argAny(a, 0)))
		},
		"audit": func(ctx context.Context, a []json.RawMessage) (any, error) {
			return all(ctx, servicekeys.Audit(argString(a, 0)))
		},
		"row": rowMethod(store),
		"setNow": func(_ context.Context, a []json.RawMessage) (any, error) {
			t, err := parseISO(argString(a, 0))
			if err != nil {
				return nil, errors.New("setNow needs an ISO 8601 date")
			}
			now = float64(t.UnixMilli())
			return nil, nil
		},
	}}, nil
}
