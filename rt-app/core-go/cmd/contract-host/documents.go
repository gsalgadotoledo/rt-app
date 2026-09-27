package main

// Subjects: content, tasks (document modules). Facades over the modules' endpoint handlers with
// the surface of spec/hosts/node/documents.mjs; see docs/polyglot/content.md and tasks.md.

import (
	"context"
	"encoding/json"
	"strings"

	"rt.local/core-go/conformance"
	"rt.local/core-go/content"
	"rt.local/core-go/internal/js"
	"rt.local/core-go/nosql"
	"rt.local/core-go/tasks"
	"rt.local/core-go/web"
)

func init() {
	register("content", contentSubject)
	register("tasks", tasksSubject)
}

// routes lists {method, path, resource, access} of a feature's endpoints as registered.
func routes(feature web.Feature) []map[string]any {
	out := make([]map[string]any, len(feature.Endpoints))
	for i, e := range feature.Endpoints {
		out[i] = map[string]any{"method": e.Method, "path": e.Path, "resource": e.Resource, "access": e.Access}
	}
	return out
}

// handlerCall is one endpoint call: wire null bodies and queries become {}.
type handlerCall struct {
	id    string
	body  any
	query any
	actor any
}

// invoke calls the handler of method and path the way the framework does.
func invoke(ctx context.Context, feature web.Feature, method, path string, call handlerCall) (any, error) {
	body, _ := call.body.(map[string]any)
	if body == nil {
		body = map[string]any{}
	}
	query := map[string]string{}
	raw, _ := call.query.(map[string]any)
	for k, v := range raw {
		if s, ok := v.(string); ok {
			query[k] = s
		} else if v != nil {
			query[k] = js.String(v)
		}
	}
	params := map[string]string{}
	if strings.Contains(path, "/:id") {
		params["id"] = call.id
	}
	for _, e := range feature.Endpoints {
		if e.Method == method && e.Path == path {
			return e.Handle(&web.Context{Ctx: ctx, Request: web.Request{Method: method, Path: path, Body: body, Query: query}, Params: params, Actor: actorFrom(call.actor)})
		}
	}
	panic("no endpoint " + method + " " + path)
}

func contentSubject(ctx context.Context, init json.RawMessage) (conformance.Instance, error) {
	store, err := memoryStore(ctx, init)
	if err != nil {
		return conformance.Instance{}, err
	}
	feature := content.New(store).Feature()
	endpoint := func(method, path string) conformance.Method {
		return func(ctx context.Context, args []json.RawMessage) (any, error) {
			return invoke(ctx, feature, method, path, handlerCall{body: argAny(args, 0)})
		}
	}
	return conformance.Instance{Methods: map[string]conformance.Method{
		"home":     endpoint("GET", "/"),
		"settings": endpoint("GET", "/content/settings"),
		// save(body) → settings
		"save":       endpoint("PUT", "/content/settings"),
		"endpoints":  func(context.Context, []json.RawMessage) (any, error) { return routes(feature), nil },
		"admin":      func(context.Context, []json.RawMessage) (any, error) { return content.Admin(), nil },
		"migrations": func(context.Context, []json.RawMessage) (any, error) { return content.Migrations, nil },
		"migrate": func(ctx context.Context, _ []json.RawMessage) (any, error) {
			return nil, content.Migrate(ctx, store)
		},
		"row": rowMethod(store),
	}}, nil
}

func tasksSubject(ctx context.Context, init json.RawMessage) (conformance.Instance, error) {
	now, err := newClock(init)
	if err != nil {
		return conformance.Instance{}, err
	}
	store, err := memoryStore(ctx, init)
	if err != nil {
		return conformance.Instance{}, err
	}
	feature := tasks.New(store, tasks.WithClock(now.Now)).Feature()
	// (query, actor) methods
	listing := func(path string) conformance.Method {
		return func(ctx context.Context, args []json.RawMessage) (any, error) {
			return invoke(ctx, feature, "GET", path, handlerCall{query: argAny(args, 0), actor: argAny(args, 1)})
		}
	}
	// (id, actor) methods
	byID := func(method, path string) conformance.Method {
		return func(ctx context.Context, args []json.RawMessage) (any, error) {
			return invoke(ctx, feature, method, path, handlerCall{id: argString(args, 0), actor: argAny(args, 1)})
		}
	}
	// (id, body, actor) methods
	withBody := func(path string) conformance.Method {
		return func(ctx context.Context, args []json.RawMessage) (any, error) {
			return invoke(ctx, feature, "PATCH", path, handlerCall{id: argString(args, 0), body: argAny(args, 1), actor: argAny(args, 2)})
		}
	}
	return conformance.Instance{Methods: map[string]conformance.Method{
		"list":    listing("/tasks"),
		"listAll": listing("/tasks/admin"),
		// create(body, actor) → task
		"create": func(ctx context.Context, args []json.RawMessage) (any, error) {
			return invoke(ctx, feature, "POST", "/tasks", handlerCall{body: argAny(args, 0), actor: argAny(args, 1)})
		},
		"update":       withBody("/tasks/:id"),
		"remove":       byID("DELETE", "/tasks/:id"),
		"restore":      byID("POST", "/tasks/:id/restore"),
		"manage":       withBody("/tasks/admin/:id"),
		"adminRemove":  byID("DELETE", "/tasks/admin/:id"),
		"adminRestore": byID("POST", "/tasks/admin/:id/restore"),
		"endpoints":    func(context.Context, []json.RawMessage) (any, error) { return routes(feature), nil },
		"admin":        func(context.Context, []json.RawMessage) (any, error) { return tasks.Admin(), nil },
		"migrations":   func(context.Context, []json.RawMessage) (any, error) { return tasks.Migrations, nil },
		"migrate": func(ctx context.Context, _ []json.RawMessage) (any, error) {
			return nil, tasks.Migrate(ctx, store)
		},
		"seeds": func(context.Context, []json.RawMessage) (any, error) { return tasks.Seeds, nil },
		// seedRows(users) → rows the welcome seed inserts
		"seedRows": func(_ context.Context, args []json.RawMessage) (any, error) {
			var users []nosql.Row
			if err := decodeArgs(args, &users); err != nil {
				return nil, err
			}
			return tasks.WelcomeRows(users, now.Now()), nil
		},
		"row":    rowMethod(store),
		"setNow": now.setNow,
	}}, nil
}
