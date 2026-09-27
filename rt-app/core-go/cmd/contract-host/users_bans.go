package main

// Subject: userBans (package users/bans). Mirrors spec/hosts/node/users-bans.mjs: users + jwt +
// a capturing mailbox + auth + bans (sessions: auth) over one memory store (init.rows) and one
// settable clock (init.now). See docs/polyglot/users-bans.md.

import (
	"context"
	"encoding/json"
	"fmt"

	"rt.local/core-go/auth"
	"rt.local/core-go/conformance"
	"rt.local/core-go/jwt"
	"rt.local/core-go/users"
	"rt.local/core-go/users/bans"
	"rt.local/core-go/web"
)

func init() {
	register("userBans", userBansSubject)
}

func userBansSubject(ctx context.Context, init json.RawMessage) (conformance.Instance, error) {
	now, err := newClock(init)
	if err != nil {
		return conformance.Instance{}, err
	}
	store, err := memoryStore(ctx, init)
	if err != nil {
		return conformance.Instance{}, err
	}
	var config struct {
		Secret string `json:"secret"`
	}
	if err := json.Unmarshal(init, &config); err != nil {
		return conformance.Instance{}, fmt.Errorf("init: %w", err)
	}
	tokens, err := jwt.New(config.Secret, jwt.WithClock(now.Now))
	if err != nil {
		return conformance.Instance{}, err
	}
	mailbox := &auth.LocalMailbox{}
	accounts := users.New(store, users.WithClock(now.Now))
	a := auth.New(accounts, tokens, mailbox, config.Secret, auth.WithClock(now.Now))
	b := bans.New(accounts, bans.WithClock(now.Now), bans.WithSessions(a))
	handlers := map[string]web.Endpoint{}
	for _, e := range accounts.Feature().Endpoints {
		handlers[e.Method+" "+e.Path] = e
	}
	str := argString
	body := func(args []json.RawMessage, i int) map[string]any {
		input, _ := argAny(args, i).(map[string]any)
		if input == nil {
			input = map[string]any{}
		}
		return input
	}
	nilMap := func(m map[string]any) any { // an untyped nil encodes as null (a nil map would be {})
		if m == nil {
			return nil
		}
		return m
	}
	return conformance.Instance{Methods: map[string]conformance.Method{
		// ban(userId, input, actor) → admin view
		"ban": func(ctx context.Context, args []json.RawMessage) (any, error) {
			return b.Ban(ctx, argAny(args, 0), body(args, 1), actorFrom(argAny(args, 2)))
		},
		// unban(userId, input, actor) → admin view
		"unban": func(ctx context.Context, args []json.RawMessage) (any, error) {
			return b.Unban(ctx, argAny(args, 0), body(args, 1), actorFrom(argAny(args, 2)))
		},
		// history(userId) → {items}
		"history": func(ctx context.Context, args []json.RawMessage) (any, error) {
			return b.History(ctx, argAny(args, 0))
		},
		// view(userId) → GET /users/:id; list(query) → GET /users
		"view": func(ctx context.Context, args []json.RawMessage) (any, error) {
			return handlers["GET /users/:id"].Handle(&web.Context{Ctx: ctx, Params: map[string]string{"id": str(args, 0)}})
		},
		"list": func(ctx context.Context, args []json.RawMessage) (any, error) {
			query := map[string]string{}
			for k, v := range body(args, 0) {
				query[k], _ = v.(string)
			}
			return handlers["GET /users"].Handle(&web.Context{Ctx: ctx, Request: web.Request{Query: query}})
		},
		// activeBan(data) → ban | null at the subject clock; parseInstant(value) → ms | null
		"activeBan": func(_ context.Context, args []json.RawMessage) (any, error) {
			data, _ := argAny(args, 0).(map[string]any)
			return nilMap(users.ActiveBan(data, now.Now().UnixMilli())), nil
		},
		"parseInstant": func(_ context.Context, args []json.RawMessage) (any, error) {
			if ms, ok := users.ParseInstant(argAny(args, 0)); ok {
				return float64(ms), nil
			}
			return nil, nil
		},
		// The sign-in paths the ban gate covers.
		"login": func(ctx context.Context, args []json.RawMessage) (any, error) {
			return a.Login(ctx, str(args, 0), argAny(args, 1), str(args, 2))
		},
		"issue": func(ctx context.Context, args []json.RawMessage) (any, error) {
			return a.Issue(ctx, str(args, 0), str(args, 1), str(args, 2))
		},
		"consume": func(ctx context.Context, args []json.RawMessage) (any, error) {
			return a.Consume(ctx, str(args, 0), argAny(args, 1), str(args, 2), str(args, 3), argAny(args, 4))
		},
		"verifyMfa": func(ctx context.Context, args []json.RawMessage) (any, error) {
			return a.VerifyMFA(ctx, argAny(args, 0), argAny(args, 1), str(args, 2))
		},
		"refresh": func(ctx context.Context, args []json.RawMessage) (any, error) {
			return a.Refresh(ctx, argAny(args, 0), str(args, 1))
		},
		"actor": func(ctx context.Context, args []json.RawMessage) (any, error) {
			actor, err := a.Actor(ctx, str(args, 0))
			if actor == nil {
				return nil, err
			}
			return actor, err
		},
		"sessions": func(ctx context.Context, args []json.RawMessage) (any, error) {
			return a.Sessions(ctx, str(args, 0), "")
		},
		// Helpers.
		"mailbox": func(context.Context, []json.RawMessage) (any, error) {
			out := []map[string]string{}
			for _, m := range mailbox.Messages() {
				out = append(out, map[string]string{"email": m.Email, "code": m.Code, "purpose": m.Purpose})
			}
			return out, nil
		},
		"row": rowMethod(store),
		"endpoints": func(context.Context, []json.RawMessage) (any, error) {
			out := []map[string]any{}
			for _, e := range b.Feature().Endpoints {
				var tool any
				if e.Tool != nil {
					tool = e.Tool.Name
				}
				out = append(out, map[string]any{"method": e.Method, "path": e.Path, "access": e.Access, "resource": e.Resource, "tool": tool})
			}
			return out, nil
		},
		"setNow": now.setNow,
	}}, nil
}
