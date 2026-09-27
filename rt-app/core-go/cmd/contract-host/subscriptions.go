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
	"sync"

	"rt.local/core-go/apperr"
	"rt.local/core-go/conformance"
	"rt.local/core-go/internal/canonical"
	"rt.local/core-go/internal/js"
	"rt.local/core-go/nosql"
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

// failingStore makes the next transactions fail with 503 "Injected store failure", "before"
// committing (nothing written) or "after" (written, the reply is lost): failWrites.
type failingStore struct {
	*nosql.MemoryStore
	mu       sync.Mutex
	injected []string
}

func (f *failingStore) Transact(ctx context.Context, writes []nosql.Write) error {
	f.mu.Lock()
	mode := ""
	if len(f.injected) > 0 {
		mode, f.injected = f.injected[0], f.injected[1:]
	}
	f.mu.Unlock()
	if mode == "before" {
		return apperr.New(503, "Injected store failure")
	}
	if err := f.MemoryStore.Transact(ctx, writes); err != nil {
		return err
	}
	if mode == "after" {
		return apperr.New(503, "Injected store failure")
	}
	return nil
}

// outcome is a call's result for race and batch: nil on success, else {status, message}.
func outcome(err error) map[string]any {
	if err == nil {
		return nil
	}
	if e, ok := apperr.As(err); ok {
		return map[string]any{"status": e.Status, "message": e.Message}
	}
	return map[string]any{"status": nil, "message": err.Error()}
}

// outcomes summarizes race and batch results: {fulfilled, rejected (sorted by message)}.
func outcomes(results []map[string]any) map[string]any {
	rejected := []any{}
	var sorted []map[string]any
	for _, r := range results {
		if r != nil {
			sorted = append(sorted, r)
		}
	}
	slices.SortStableFunc(sorted, func(a, b map[string]any) int { return strings.Compare(a["message"].(string), b["message"].(string)) })
	for _, r := range sorted {
		rejected = append(rejected, r)
	}
	return map[string]any{"fulfilled": float64(len(results) - len(sorted)), "rejected": rejected}
}

// meta reads a wire ReservationMeta {source, actorId} (null: the defaults).
func metaFrom(v any) subscriptions.ReservationMeta {
	o, _ := v.(map[string]any)
	source, _ := o["source"].(string)
	actor, _ := o["actorId"].(string)
	return subscriptions.ReservationMeta{Source: source, ActorID: actor}
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
	memory, err := memoryStore(ctx, init)
	if err != nil {
		return conformance.Instance{}, err
	}
	store := &failingStore{MemoryStore: memory}
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
	type call struct {
		Call string            `json:"call"`
		Args []json.RawMessage `json:"args"`
	}
	var methods map[string]conformance.Method
	run := func(ctx context.Context, c call) map[string]any {
		method, ok := methods[c.Call]
		if !ok {
			return map[string]any{"status": nil, "message": "unknown method " + c.Call}
		}
		_, err := method(ctx, c.Args)
		return outcome(err)
	}
	methods = map[string]conformance.Method{
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
		"reserve": m(func(ctx context.Context, a []json.RawMessage) (any, error) {
			return s.Reserve(ctx, argString(a, 0), argAny(a, 1), objectOr(argAny(a, 2)), metaFrom(argAny(a, 3)))
		}),
		"settle": m(func(ctx context.Context, a []json.RawMessage) (any, error) {
			return s.Settle(ctx, argString(a, 0), argAny(a, 1), objectOr(argAny(a, 2)), metaFrom(argAny(a, 3)))
		}),
		"release": m(func(ctx context.Context, a []json.RawMessage) (any, error) {
			return s.Release(ctx, argString(a, 0), argAny(a, 1), metaFrom(argAny(a, 2)))
		}),
		"preflight": m(func(ctx context.Context, a []json.RawMessage) (any, error) {
			return s.Preflight(ctx, argString(a, 0), argAny(a, 1), objectOr(argAny(a, 2)))
		}),
		"usageSummary": m(func(ctx context.Context, a []json.RawMessage) (any, error) {
			return s.UsageSummary(ctx, argString(a, 0))
		}),
		// failWrites(count, mode): the next count transactions fail ("before" or "after" commit).
		"failWrites": m(func(_ context.Context, a []json.RawMessage) (any, error) {
			mode := argString(a, 1)
			if mode != "before" && mode != "after" {
				return nil, errors.New(`failWrites mode is "before" or "after"`)
			}
			count, _ := argAny(a, 0).(float64)
			store.mu.Lock()
			for i := 0; i < int(count); i++ {
				store.injected = append(store.injected, mode)
			}
			store.mu.Unlock()
			return nil, nil
		}),
		// race([{call, args}]): the calls at once, one goroutine each.
		"race": m(func(ctx context.Context, a []json.RawMessage) (any, error) {
			var calls []call
			if err := json.Unmarshal(arg(a, 0), &calls); err != nil {
				return nil, err
			}
			results := make([]map[string]any, len(calls))
			var start, done sync.WaitGroup
			start.Add(1)
			for i, c := range calls {
				done.Add(1)
				go func() {
					defer done.Done()
					start.Wait()
					results[i] = run(ctx, c)
				}()
			}
			start.Done()
			done.Wait()
			return outcomes(results), nil
		}),
		// batch([{call, args}]): the calls one after the other.
		"batch": m(func(ctx context.Context, a []json.RawMessage) (any, error) {
			var calls []call
			if err := json.Unmarshal(arg(a, 0), &calls); err != nil {
				return nil, err
			}
			results := make([]map[string]any, len(calls))
			for i, c := range calls {
				results[i] = run(ctx, c)
			}
			return outcomes(results), nil
		}),
		// ledgerCheck(userId): statement invariants (docs/polyglot/subscriptions-reservations.md).
		"ledgerCheck": m(func(ctx context.Context, a []json.RawMessage) (any, error) {
			userID := argString(a, 0)
			var entries []map[string]any
			cursor := ""
			for {
				page, err := store.List(ctx, "SUB_LEDGER#"+userID, cursor)
				if err != nil {
					return nil, err
				}
				for _, r := range page.Items {
					entries = append(entries, r.Data)
				}
				if cursor = page.Cursor; cursor == "" {
					break
				}
			}
			row, err := store.Get(ctx, "SUB_ACCOUNTS", userID)
			if err != nil {
				return nil, err
			}
			account := map[string]any{}
			if row != nil {
				account = row.Data
			}
			n := func(v any) float64 { f, _ := v.(float64); return f }
			windows, _ := account["ledgerWindows"].(map[string]any)
			counters, _ := account["counters"].(map[string]any)
			if key, _ := windows["key"].(string); strings.HasPrefix(key, "admin:") {
				grant, _ := account["adminGrant"].(map[string]any)
				counters, _ = grant["counters"].(map[string]any)
			}
			credits, held, reserved, allowance, additional := 0.0, 0.0, 0.0, 0.0, 0.0
			negative := false
			for _, e := range entries {
				credits += n(e["credits"])
				held += n(e["held"])
				if v, ok := e["available"].(float64); ok && v < 0 {
					negative = true
				}
			}
			holds, _ := account["reservations"].([]any)
			for _, h := range holds {
				hold, _ := h.(map[string]any)
				reserved += n(hold["credits"])
			}
			products, _ := windows["products"].(map[string]any)
			for productID, w := range products {
				window, _ := w.(map[string]any)
				counter, _ := counters[productID].(map[string]any)
				used := 0.0
				if counter != nil && n(counter["weekStart"]) == n(window["start"]) {
					used = n(counter["week"])
				}
				allowance += n(window["allowance"]) - used
			}
			balances, _ := account["creditBalance"].(map[string]any)
			for _, v := range balances {
				additional += n(v)
				negative = negative || n(v) < 0
			}
			return map[string]any{
				"entries": float64(len(entries)), "credits": credits, "held": held, "reserved": reserved, "allowance": allowance,
				"additional": additional, "balanced": credits == allowance+additional && held == reserved, "negative": negative,
			}, nil
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
	}
	return conformance.Instance{Methods: methods}, nil
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
