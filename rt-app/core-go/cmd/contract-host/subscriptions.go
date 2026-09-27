package main

// Subject: subscriptions (the Subscriptions service). Mirrors spec/hosts/node/subscriptions.mjs:
// a memory store (init.rows), a settable clock (init.now), LocalBilling when init.billing is
// "local", a fake catalog when init.catalog is true and a capturing notifier. See
// docs/polyglot/subscriptions.md.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"slices"
	"strings"

	"rt.local/core-go/apperr"
	"rt.local/core-go/conformance"
	"rt.local/core-go/internal/canonical"
	"rt.local/core-go/internal/js"
	"rt.local/core-go/subscriptions"
	"rt.local/core-go/web"
)

func init() {
	register("subscriptions", subscriptionsSubject)
}

// fakeCatalog returns deterministic ids; in "fail" mode publishing fails with 502.
type fakeCatalog struct {
	mode      string
	published []any
}

func (f *fakeCatalog) Publish(_ context.Context, plan subscriptions.Plan, namespace string, previous subscriptions.Plan) (subscriptions.CatalogIDs, error) {
	if f.mode == "fail" {
		return subscriptions.CatalogIDs{}, apperr.New(502, "Catalog unavailable")
	}
	var previousVersion any
	if previous != nil {
		previousVersion = previous["version"]
	}
	f.published = append(f.published, map[string]any{"planId": plan["id"], "version": plan["version"], "previousVersion": previousVersion, "namespace": "string"})
	version := "0.0.1"
	if plan["version"] != nil {
		version = js.String(plan["version"])
	}
	suffix := strings.ReplaceAll(js.String(plan["id"]), "-", "_") + "_" + strings.ReplaceAll(version, ".", "_")
	return subscriptions.CatalogIDs{StripePriceID: "price_" + suffix, StripeProductID: "prod_" + suffix}, nil
}

// userFrom reads a wire actor {id, email}.
func userFrom(v any) subscriptions.User {
	o, _ := v.(map[string]any)
	id, _ := o["id"].(string)
	email, _ := o["email"].(string)
	return subscriptions.User{ID: id, Email: email}
}

// stringMap converts a wire object of query values (String() of non-strings).
func stringMap(v any) map[string]string {
	out := map[string]string{}
	o, _ := v.(map[string]any)
	for k, item := range o {
		if s, ok := item.(string); ok {
			out[k] = s
		} else if item != nil {
			out[k] = js.String(item)
		}
	}
	return out
}

func objectOr(v any) map[string]any {
	if o, ok := v.(map[string]any); ok {
		return o
	}
	return map[string]any{}
}

// route finds the endpoint of method and path with the framework rules (literal routes first).
func route(feature web.Feature, method, path string) (web.Endpoint, map[string]string, error) {
	endpoints := slices.Clone(feature.Endpoints)
	slices.SortStableFunc(endpoints, func(a, b web.Endpoint) int {
		return boolInt(strings.Contains(a.Path, ":")) - boolInt(strings.Contains(b.Path, ":"))
	})
	parts := strings.Split(strings.TrimSuffix(path, "/"), "/")
	for _, e := range endpoints {
		segments := strings.Split(e.Path, "/")
		if e.Method != method || len(segments) != len(parts) {
			continue
		}
		params := map[string]string{}
		ok := true
		for i, segment := range segments {
			if name, isParam := strings.CutPrefix(segment, ":"); isParam && parts[i] != "" {
				params[name] = parts[i]
			} else if segment != parts[i] {
				ok = false
				break
			}
		}
		if ok {
			return e, params, nil
		}
	}
	return web.Endpoint{}, nil, apperr.NotFound("Endpoint not found")
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func subscriptionsSubject(ctx context.Context, init json.RawMessage) (conformance.Instance, error) {
	var config struct {
		Now     *string `json:"now"`
		Billing any     `json:"billing"`
		Catalog any     `json:"catalog"`
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
	clock := func() float64 { return now }
	store, err := memoryStore(ctx, init)
	if err != nil {
		return conformance.Instance{}, err
	}
	var sent []any
	catalog := &fakeCatalog{mode: "ok"}
	options := []subscriptions.Option{
		subscriptions.WithClock(clock),
		subscriptions.WithNotifier(func(_ context.Context, m subscriptions.Mail) error {
			sent = append(sent, m)
			return nil
		}),
	}
	if config.Billing == "local" {
		billing, err := subscriptions.NewLocalBilling(store, clock)
		if err != nil {
			return conformance.Instance{}, err
		}
		options = append(options, subscriptions.WithProvider(billing))
	}
	if config.Catalog == true {
		options = append(options, subscriptions.WithCatalog(func(string) subscriptions.CatalogPublisher { return catalog }))
	}
	s := subscriptions.New(store, options...)
	feature := s.Feature()
	m := func(fn func(ctx context.Context, args []json.RawMessage) (any, error)) conformance.Method { return fn }
	return conformance.Instance{Methods: map[string]conformance.Method{
		"settings": m(func(ctx context.Context, _ []json.RawMessage) (any, error) { return s.Settings(ctx) }),
		"saveSettings": m(func(ctx context.Context, a []json.RawMessage) (any, error) {
			return s.SaveSettings(ctx, argAny(a, 0), argString(a, 1), nil)
		}),
		"editPlan": m(func(ctx context.Context, a []json.RawMessage) (any, error) {
			return s.EditPlan(ctx, argString(a, 0), argAny(a, 1), argString(a, 2))
		}),
		"restorePlan": m(func(ctx context.Context, a []json.RawMessage) (any, error) {
			return s.RestorePlan(ctx, argString(a, 0), argAny(a, 1), argString(a, 2))
		}),
		"publishPlan": m(func(ctx context.Context, a []json.RawMessage) (any, error) {
			return s.PublishPlan(ctx, argString(a, 0), objectOr(argAny(a, 1)), argString(a, 2))
		}),
		"linkStripePrices": m(func(ctx context.Context, a []json.RawMessage) (any, error) {
			raw := arg(a, 0)
			links := objectOr(decodeAny(raw))
			var list []subscriptions.PriceLink
			for _, planID := range subscriptions.OrderedKeys(raw) {
				ids, _ := links[planID].(map[string]any)
				list = append(list, subscriptions.PriceLink{PlanID: planID, ProductID: js.String(ids["productId"]), PriceID: js.String(ids["priceId"])})
			}
			return s.LinkStripePrices(ctx, list, argString(a, 1))
		}),
		"me": m(func(ctx context.Context, a []json.RawMessage) (any, error) { return s.Me(ctx, argString(a, 0)) }),
		"preferences": m(func(ctx context.Context, a []json.RawMessage) (any, error) {
			return s.Preferences(ctx, argString(a, 0), argAny(a, 1))
		}),
		"change": m(func(ctx context.Context, a []json.RawMessage) (any, error) {
			return s.Change(ctx, userFrom(argAny(a, 0)), argString(a, 1), argString(a, 2))
		}),
		"setupPayment": m(func(ctx context.Context, a []json.RawMessage) (any, error) {
			return s.SetupPayment(ctx, userFrom(argAny(a, 0)), argString(a, 1))
		}),
		"setPayment": m(func(ctx context.Context, a []json.RawMessage) (any, error) {
			return s.SetPayment(ctx, userFrom(argAny(a, 0)), argAny(a, 1))
		}),
		"cancel": m(func(ctx context.Context, a []json.RawMessage) (any, error) {
			return s.Cancel(ctx, userFrom(argAny(a, 0)), argString(a, 1))
		}),
		"sync":    m(func(ctx context.Context, a []json.RawMessage) (any, error) { return nil, s.Sync(ctx, argString(a, 0)) }),
		"billing": m(func(ctx context.Context, a []json.RawMessage) (any, error) { return s.Billing(ctx, argString(a, 0)) }),
		"grant": m(func(ctx context.Context, a []json.RawMessage) (any, error) {
			return s.Grant(ctx, argString(a, 0), argAny(a, 1), argString(a, 2))
		}),
		"reset": m(func(ctx context.Context, a []json.RawMessage) (any, error) {
			return s.Reset(ctx, argString(a, 0), argAny(a, 1), argString(a, 2))
		}),
		"listUsers": m(func(ctx context.Context, a []json.RawMessage) (any, error) {
			return s.ListUsers(ctx, stringMap(argAny(a, 0)))
		}),
		"webhook": m(func(ctx context.Context, a []json.RawMessage) (any, error) {
			return s.Webhook(ctx, argString(a, 0), argString(a, 1))
		}),
		"consume": m(func(ctx context.Context, a []json.RawMessage) (any, error) {
			meta := objectOr(argAny(a, 4))
			str := func(k string) string { v, _ := meta[k].(string); return v }
			details, _ := meta["details"].(map[string]any)
			return s.Consume(ctx, argString(a, 0), argString(a, 1), argAny(a, 2), argAny(a, 3), subscriptions.Meta{Reason: str("reason"), Kind: str("kind"), Source: str("source"), ActorID: str("actorId"), Details: details})
		}),
		"recordCredits": m(func(ctx context.Context, a []json.RawMessage) (any, error) {
			return s.RecordCredits(ctx, argString(a, 0), objectOr(argAny(a, 1)), subscriptions.OrderedKeys(arg(a, 1))...)
		}),
		"estimate": m(func(ctx context.Context, a []json.RawMessage) (any, error) {
			return s.Estimate(ctx, objectOr(argAny(a, 0)))
		}),
		"consumeUsage": m(func(ctx context.Context, a []json.RawMessage) (any, error) {
			return s.ConsumeUsage(ctx, argString(a, 0), argString(a, 1), objectOr(argAny(a, 2)), argAny(a, 3))
		}),
		"ledger": m(func(ctx context.Context, a []json.RawMessage) (any, error) {
			return s.Ledger(ctx, argString(a, 0), argString(a, 1))
		}),
		"overview":    m(func(ctx context.Context, a []json.RawMessage) (any, error) { return s.Overview(ctx, argAny(a, 0)) }),
		"maintenance": m(func(ctx context.Context, _ []json.RawMessage) (any, error) { return s.Maintenance(ctx) }),
		"endpoints": m(func(context.Context, []json.RawMessage) (any, error) {
			out := make([]any, len(feature.Endpoints))
			for i, e := range feature.Endpoints {
				item := map[string]any{"method": e.Method, "path": e.Path, "access": e.Access, "resource": e.Resource}
				if e.Tool != nil {
					item["tool"] = e.Tool.Name
				}
				if e.Path == "/subscriptions/webhook" {
					item["maxBodyBytes"] = subscriptions.WebhookMaxBodyBytes
				}
				out[i] = item
			}
			return out, nil
		}),
		"call": m(func(ctx context.Context, a []json.RawMessage) (any, error) {
			method, path := argString(a, 0), argString(a, 1)
			e, params, err := route(feature, method, path)
			if err != nil {
				return nil, err
			}
			for name, value := range params {
				if params[name], err = decodeURIComponentJS(value); err != nil {
					return nil, err
				}
			}
			request := objectOr(argAny(a, 2))
			headers := http.Header{}
			for k, v := range stringMap(request["headers"]) {
				headers.Set(k, v)
			}
			raw, _ := request["raw"].(string)
			var actor *web.Actor
			if o, ok := argAny(a, 3).(map[string]any); ok {
				actor = actorFrom(o)
				actor.Email, _ = o["email"].(string)
			}
			return e.Handle(&web.Context{Ctx: ctx, Request: web.Request{Method: method, Path: path, Body: objectOr(request["body"]), Query: stringMap(request["query"]), Headers: headers, Raw: []byte(raw)}, Params: params, Actor: actor})
		}),
		"admin": m(func(context.Context, []json.RawMessage) (any, error) { return subscriptions.Admin(), nil }),
		"migrations": m(func(context.Context, []json.RawMessage) (any, error) {
			return subscriptions.Migrations, nil
		}),
		"setNow": m(func(_ context.Context, a []json.RawMessage) (any, error) {
			t, err := parseISO(argString(a, 0))
			if err != nil {
				return nil, errors.New("setNow needs an ISO 8601 date")
			}
			now = float64(t.UnixMilli())
			return nil, nil
		}),
		"setCatalog": m(func(_ context.Context, a []json.RawMessage) (any, error) {
			catalog.mode = argString(a, 0)
			return nil, nil
		}),
		"published": m(func(context.Context, []json.RawMessage) (any, error) { return nonNil(catalog.published), nil }),
		"sent":      m(func(context.Context, []json.RawMessage) (any, error) { return nonNil(sent), nil }),
		"row":       rowMethod(store),
		"list": m(func(ctx context.Context, a []json.RawMessage) (any, error) {
			return store.List(ctx, argString(a, 0), argString(a, 1))
		}),
		"audit": m(func(ctx context.Context, _ []json.RawMessage) (any, error) {
			var rows []map[string]any
			cursor := ""
			for {
				page, err := store.List(ctx, "SUB_AUDIT", cursor)
				if err != nil {
					return nil, err
				}
				for _, r := range page.Items {
					rows = append(rows, r.Data)
				}
				if cursor = page.Cursor; cursor == "" {
					break
				}
			}
			text := func(v map[string]any) string {
				s, _ := canonical.Marshal(v, func(canonical.Kind) error { return errors.New("not JSON") })
				return s
			}
			slices.SortStableFunc(rows, func(x, y map[string]any) int { return canonical.Less(text(x), text(y)) })
			out := make([]any, len(rows))
			for i, r := range rows {
				out[i] = r
			}
			return out, nil
		}),
	}}, nil
}

func nonNil(items []any) []any {
	if items == nil {
		return []any{}
	}
	return items
}

// decodeURIComponentJS decodes a path parameter (400 "Invalid URL" on bad escapes).
func decodeURIComponentJS(s string) (string, error) {
	decoded, err := url.PathUnescape(s)
	if err != nil {
		return "", apperr.BadRequest("Invalid URL")
	}
	return decoded, nil
}
