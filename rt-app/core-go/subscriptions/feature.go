package subscriptions

import (
	"context"
	"slices"

	"rt.local/core-go/apperr"
	"rt.local/core-go/internal/js"
	"rt.local/core-go/nosql"
	"rt.local/core-go/web"
)

// WebhookMaxBodyBytes is the body limit of POST /subscriptions/webhook (256 KiB), as in the
// TypeScript framework.
const WebhookMaxBodyBytes = 262144

// Migration describes a module migration.
type Migration struct {
	ID          string `json:"id"`
	Checksum    string `json:"checksum"`
	Description string `json:"description"`
}

// Migrations of the module: the document schema is recorded once.
var Migrations = []Migration{{ID: "subscriptions:001", Checksum: "subscriptions-document-v1", Description: "Register the subscriptions document schema"}}

// Migrate runs the module migrations: SCHEMA/subscriptions {schemaVersion: 1} unless it exists.
func Migrate(ctx context.Context, store nosql.Store) error {
	existing, err := store.Get(ctx, "SCHEMA", "subscriptions")
	if err != nil || existing != nil {
		return err
	}
	return store.Transact(ctx, []nosql.Write{{Row: nosql.Row{PK: "SCHEMA", SK: "subscriptions", Version: 1, Data: map[string]any{"schemaVersion": 1}}}})
}

// Admin is the admin manifest of the module.
func Admin() map[string]any {
	return map[string]any{
		"id": "subscriptions", "title": "Subscriptions", "resource": "subscriptions.manage", "path": "/subscriptions/admin/accounts",
		"component": "subscriptions", "ownerOnly": true, "fields": []any{}, "actions": []any{},
	}
}

func actorUser(a *web.Actor) User {
	if a == nil {
		return User{}
	}
	return User{ID: a.ID, Email: a.Email}
}

func actorID(a *web.Actor) string {
	if a == nil {
		return ""
	}
	return a.ID
}

// Feature is the module's HTTP surface (the TypeScript feature(), same order and metadata).
func (s *Subscriptions) Feature() web.Feature {
	const manage = "subscriptions.manage"
	var endpoints []web.Endpoint
	for _, action := range []string{"create", "update", "archive", "unarchive", "version"} {
		endpoints = append(endpoints, web.Endpoint{
			Method: "POST", Path: "/subscriptions/admin/plans/actions/" + action, Resource: manage, Access: web.Owner,
			Tool: &web.Tool{
				Name:        "subscriptions_plan_" + action,
				Description: action + " a plan. Read settings first; body.version is its concurrency revision. Body.id selects an existing plan. Create/update accept body.plan (name, amount, currency, periodDays, products). Product entries define id, name, credits, dailyLimit, weeklyLimit, daySeconds, weekSeconds. Create generates ID and starts disabled. Archive/unarchive leave disabled. Version snapshots even unchanged content. Publish separately to synchronize Stripe.",
				Example:     map[string]any{"body": map[string]any{"version": 0, "id": "pro"}},
			},
			Handle: func(c *web.Context) (any, error) { return s.EditPlan(c.Ctx, action, c.Request.Body, actorID(c.Actor)) },
		})
	}
	me := func(c *web.Context) (any, error) { return s.Me(c.Ctx, actorID(c.Actor)) }
	endpoints = append(endpoints,
		web.Endpoint{Method: "GET", Path: "/subscriptions/me", Resource: "subscriptions.me", Access: web.Authenticated, Handle: me},
		web.Endpoint{Method: "GET", Path: "/subscriptions/billing", Resource: "subscriptions.me", Access: web.Authenticated, Handle: func(c *web.Context) (any, error) {
			return s.Billing(c.Ctx, actorID(c.Actor))
		}},
		web.Endpoint{Method: "POST", Path: "/subscriptions/change", Resource: "subscriptions.me", Access: web.Authenticated, Handle: func(c *web.Context) (any, error) {
			_, present := c.Request.Body["planId"]
			planID := js.String(c.Request.Body["planId"])
			if present && c.Request.Body["planId"] == nil {
				planID = "null"
			}
			key, err := id(c.Request.Body["requestId"])
			if err != nil {
				return nil, err
			}
			return s.Change(c.Ctx, actorUser(c.Actor), planID, key)
		}},
		web.Endpoint{Method: "POST", Path: "/subscriptions/payment/setup", Resource: "subscriptions.me", Access: web.Authenticated, Handle: func(c *web.Context) (any, error) {
			key, err := id(c.Request.Body["requestId"])
			if err != nil {
				return nil, err
			}
			return s.SetupPayment(c.Ctx, actorUser(c.Actor), key)
		}},
		web.Endpoint{Method: "POST", Path: "/subscriptions/payment/save", Resource: "subscriptions.me", Access: web.Authenticated, Handle: func(c *web.Context) (any, error) {
			setup, err := id(c.Request.Body["setupId"])
			if err != nil {
				return nil, err
			}
			return s.SetPayment(c.Ctx, actorUser(c.Actor), setup)
		}},
		web.Endpoint{Method: "POST", Path: "/subscriptions/cancel", Resource: "subscriptions.me", Access: web.Authenticated, Handle: func(c *web.Context) (any, error) {
			key, err := id(c.Request.Body["requestId"])
			if err != nil {
				return nil, err
			}
			return s.Cancel(c.Ctx, actorUser(c.Actor), key)
		}},
		web.Endpoint{Method: "POST", Path: "/subscriptions/sync", Resource: "subscriptions.me", Access: web.Authenticated, Handle: func(c *web.Context) (any, error) {
			if err := s.Sync(c.Ctx, actorID(c.Actor)); err != nil {
				return nil, err
			}
			return s.Me(c.Ctx, actorID(c.Actor))
		}},
		web.Endpoint{Method: "PUT", Path: "/subscriptions/preferences", Resource: "subscriptions.me", Access: web.Authenticated, Handle: func(c *web.Context) (any, error) {
			return s.Preferences(c.Ctx, actorID(c.Actor), c.Request.Body["notifications"])
		}},
		web.Endpoint{Method: "POST", Path: "/subscriptions/webhook", Resource: "subscriptions.webhook", Access: web.Guest, MaxBodyBytes: WebhookMaxBodyBytes, Handle: func(c *web.Context) (any, error) {
			return s.Webhook(c.Ctx, string(c.Request.Raw), c.Request.Headers.Get("stripe-signature"))
		}},
		web.Endpoint{Method: "GET", Path: "/subscriptions/admin/settings", Resource: manage, Access: web.Owner,
			Tool:   &web.Tool{Name: "subscriptions_settings_get", Description: "Read settings and optimistic concurrency version. Read before editing plans.", Example: map[string]any{}},
			Handle: func(c *web.Context) (any, error) { return s.Settings(c.Ctx) }},
		web.Endpoint{Method: "PUT", Path: "/subscriptions/admin/settings", Resource: manage, Access: web.Owner,
			Tool:   &web.Tool{Name: "subscriptions_settings_save", Description: "Save complete settings with version. Add plans, edit products/prices/limits, or set archived:true and enabled:false. Changed plan content creates a version; preserve all existing plan IDs.", Example: map[string]any{"body": map[string]any{"version": 0, "values": map[string]any{}}}},
			Handle: func(c *web.Context) (any, error) { return s.SaveSettings(c.Ctx, c.Request.Body, actorID(c.Actor), nil) }},
		web.Endpoint{Method: "POST", Path: "/subscriptions/admin/plans/:id/publish", Resource: manage, Access: web.Owner,
			Tool: &web.Tool{Name: "subscriptions_plan_publish", Description: "Synchronize a saved plan to Stripe. Creates paid catalog resources; requires configured Stripe credentials. Body: version.", Example: map[string]any{"params": map[string]any{"id": "pro"}, "body": map[string]any{"version": 1}}},
			Handle: func(c *web.Context) (any, error) {
				return s.PublishPlan(c.Ctx, c.Params["id"], c.Request.Body, actorID(c.Actor))
			}},
		web.Endpoint{Method: "POST", Path: "/subscriptions/admin/plans/:id/restore", Resource: manage, Access: web.Owner,
			Tool: &web.Tool{Name: "subscriptions_plan_restore", Description: "Restore history as a new version. Body: version (settings revision), fromVersion (plan version).", Example: map[string]any{"params": map[string]any{"id": "pro"}, "body": map[string]any{"version": 1, "fromVersion": "0.0.1"}}},
			Handle: func(c *web.Context) (any, error) {
				return s.RestorePlan(c.Ctx, c.Params["id"], c.Request.Body, actorID(c.Actor))
			}},
		web.Endpoint{Method: "GET", Path: "/subscriptions/admin/plans/:id/history", Resource: manage, Access: web.Owner,
			Tool: &web.Tool{Name: "subscriptions_plan_history", Description: "Read paginated plan history; optional query.cursor.", Example: map[string]any{"params": map[string]any{"id": "pro"}}},
			Handle: func(c *web.Context) (any, error) {
				return s.store.List(c.Ctx, "SUB_PLAN_HISTORY#"+c.Params["id"], c.Request.Query["cursor"])
			}},
		web.Endpoint{Method: "GET", Path: "/subscriptions/admin/accounts", Resource: manage, Access: web.Owner,
			Tool:   &web.Tool{Name: "subscriptions_accounts_list", Description: "Search users one page at a time; optional query.q and query.cursor.", Example: map[string]any{}},
			Handle: func(c *web.Context) (any, error) { return s.ListUsers(c.Ctx, c.Request.Query) }},
		web.Endpoint{Method: "GET", Path: "/subscriptions/admin/accounts/:id", Resource: manage, Access: web.Owner,
			Tool:   &web.Tool{Name: "subscriptions_account_get", Description: "Read account, invoices, grants and usage. params.id identifies the user.", Example: map[string]any{"params": map[string]any{"id": "USER_ID"}}},
			Handle: func(c *web.Context) (any, error) { return s.AccountView(c.Ctx, c.Params["id"], c.Request.Query) }},
		web.Endpoint{Method: "GET", Path: "/subscriptions/admin/overview", Resource: manage, Access: web.Owner,
			Tool: &web.Tool{Name: "subscriptions_overview", Description: "Customers, paying customers, projected monthly revenue per currency (minor units), new and canceled subscriptions today, this month and per month. query.months (1-36, default 12).", Example: map[string]any{"query": map[string]any{"months": "12"}}},
			Handle: func(c *web.Context) (any, error) {
				months := any(12.0)
				if m := c.Request.Query["months"]; m != "" {
					months = js.Number(m, true)
				}
				return s.Overview(c.Ctx, months)
			}},
		web.Endpoint{Method: "GET", Path: "/subscriptions/admin/economics", Resource: manage, Access: web.Owner,
			Tool: &web.Tool{Name: "subscriptions_economics", Description: "Unit economics: provider cost (settlements priced with the rates' costs), revenue (money paid) and margin per currency, per plan and for the users with the highest cost. query.limit (1-200, default 50). Never writes.", Example: map[string]any{"query": map[string]any{"limit": "50"}}},
			Handle: func(c *web.Context) (any, error) {
				limit := any(50.0)
				if l := c.Request.Query["limit"]; l != "" {
					limit = js.Number(l, true)
				}
				return s.Economics(c.Ctx, limit)
			}},
		web.Endpoint{Method: "GET", Path: "/subscriptions/admin/accounts/:id/ledger", Resource: manage, Access: web.Owner,
			Tool:   &web.Tool{Name: "subscriptions_account_ledger", Description: "Chronological credit statement (allowances, usage, expiries, grants, purchases, plans), balances and totals. params.id user; query.cursor continues.", Example: map[string]any{"params": map[string]any{"id": "USER_ID"}}},
			Handle: func(c *web.Context) (any, error) { return s.Ledger(c.Ctx, c.Params["id"], c.Request.Query["cursor"]) }},
		web.Endpoint{Method: "POST", Path: "/subscriptions/admin/accounts/:id/ledger", Resource: manage, Access: web.Owner,
			Tool: &web.Tool{Name: "subscriptions_account_record", Description: "Record a credit (+) or debit (−) on the user's statement. Body: requestId, productId, credits (non-zero integer), kind (purchase|adjustment|grant|usage), reason, optional amountMinor+currency for money paid, details. Debits use the plan allowance first. Reuse requestId for retries.",
				Example: map[string]any{"params": map[string]any{"id": "USER_ID"}, "body": map[string]any{"requestId": "unique-request-id", "productId": "api", "credits": 1000, "kind": "purchase", "reason": "Top-up", "amountMinor": 1000, "currency": "usd"}}},
			Handle: func(c *web.Context) (any, error) {
				return s.RecordFromBody(c.Ctx, c.Params["id"], c.Request.Body, actorID(c.Actor))
			}},
		web.Endpoint{Method: "POST", Path: "/subscriptions/admin/credits/estimate", Resource: manage, Access: web.Owner,
			Tool:   &web.Tool{Name: "subscriptions_credits_estimate", Description: "Credit sandbox: price a request by rate (model) and tokens; with userId shows how it would be charged. Body: rateId, inputTokens, outputTokens, optional userId, productId. Never writes.", Example: map[string]any{"body": map[string]any{"rateId": "standard", "inputTokens": 1000, "outputTokens": 500}}},
			Handle: func(c *web.Context) (any, error) { return s.Estimate(c.Ctx, c.Request.Body) }},
		web.Endpoint{Method: "POST", Path: "/subscriptions/admin/accounts/:id/grant", Resource: manage, Access: web.Owner,
			Tool: &web.Tool{Name: "subscriptions_account_grant", Description: "Assign plan or credits without charging a card. Body: requestId,kind(plan|credits),planId or productId,credits,valueMinor,currency,reason. Reuse requestId for retries.",
				Example: map[string]any{"params": map[string]any{"id": "USER_ID"}, "body": map[string]any{"kind": "credits", "productId": "api", "credits": 100, "valueMinor": 100, "currency": "usd", "reason": "Courtesy", "requestId": "unique-request-id"}}},
			Handle: func(c *web.Context) (any, error) {
				return s.Grant(c.Ctx, c.Params["id"], c.Request.Body, actorID(c.Actor))
			}},
		web.Endpoint{Method: "POST", Path: "/subscriptions/admin/accounts/:id/reset", Resource: manage, Access: web.Owner,
			Tool: &web.Tool{Name: "subscriptions_account_reset", Description: "Reset usage window. Body: requestId,scope(day|week|period|all),reason.",
				Example: map[string]any{"params": map[string]any{"id": "USER_ID"}, "body": map[string]any{"requestId": "unique-request-id", "scope": "day", "reason": "Courtesy"}}},
			Handle: func(c *web.Context) (any, error) {
				return s.Reset(c.Ctx, c.Params["id"], c.Request.Body, actorID(c.Actor))
			}},
		web.Endpoint{Method: "POST", Path: "/subscriptions/admin/accounts/:id/simulate", Resource: manage, Access: web.Owner,
			Tool: &web.Tool{Name: "subscriptions_account_simulate", Description: "Local billing only: simulate payment status. params.id and body.status required."},
			Handle: func(c *web.Context) (any, error) {
				return s.SimulateStatus(c.Ctx, c.Params["id"], c.Request.Body["status"])
			}},
		web.Endpoint{Method: "POST", Path: "/subscriptions/admin/maintenance", Resource: manage, Access: web.Owner,
			Tool:   &web.Tool{Name: "subscriptions_maintenance", Description: "Run subscription maintenance and configured notifications.", Example: map[string]any{}},
			Handle: func(c *web.Context) (any, error) { return s.Maintenance(c.Ctx) }},
	)
	// Credit reservations. Personal endpoints act on the signed-in user's own reservations
	// (source "user"); a backend that meters model calls uses the owner endpoints (admin token),
	// whose reservations the user cannot settle or release.
	asUser := func(c *web.Context) ReservationMeta {
		return ReservationMeta{Source: string(SourceUser), ActorID: actorID(c.Actor)}
	}
	asAPI := func(c *web.Context) ReservationMeta {
		return ReservationMeta{Source: string(SourceAPI), ActorID: actorID(c.Actor)}
	}
	endpoints = append(endpoints,
		web.Endpoint{Method: "GET", Path: "/subscriptions/credits/usage", Resource: "subscriptions.me", Access: web.Authenticated, Handle: func(c *web.Context) (any, error) {
			return s.UsageSummary(c.Ctx, actorID(c.Actor))
		}},
		web.Endpoint{Method: "POST", Path: "/subscriptions/credits/preflight", Resource: "subscriptions.me", Access: web.Authenticated, Handle: func(c *web.Context) (any, error) {
			return s.Preflight(c.Ctx, actorID(c.Actor), c.Request.Body["productId"], amountBody(c.Request.Body))
		}},
		web.Endpoint{Method: "POST", Path: "/subscriptions/credits/reservations", Resource: "subscriptions.me", Access: web.Authenticated, Handle: func(c *web.Context) (any, error) {
			return s.Reserve(c.Ctx, actorID(c.Actor), c.Request.Body["productId"], reservationBody(c.Request.Body), asUser(c))
		}},
		web.Endpoint{Method: "POST", Path: "/subscriptions/credits/reservations/:key/settle", Resource: "subscriptions.me", Access: web.Authenticated, Handle: func(c *web.Context) (any, error) {
			return s.Settle(c.Ctx, actorID(c.Actor), c.Params["key"], usageBody(c.Request.Body), asUser(c))
		}},
		web.Endpoint{Method: "POST", Path: "/subscriptions/credits/reservations/:key/release", Resource: "subscriptions.me", Access: web.Authenticated, Handle: func(c *web.Context) (any, error) {
			return s.Release(c.Ctx, actorID(c.Actor), c.Params["key"], asUser(c))
		}},
		web.Endpoint{Method: "GET", Path: "/subscriptions/admin/accounts/:id/usage", Resource: manage, Access: web.Owner,
			Tool:   &web.Tool{Name: "subscriptions_credits_usage", Description: "Usage against limits for a user: per product the day/week/period windows (used, reserved, limit, percent, threshold 0|80|95|100), active reservations, alerts at 80% or more and the credit pack for a top-up. params.id user. Never writes.", Example: map[string]any{"params": map[string]any{"id": "USER_ID"}}},
			Handle: func(c *web.Context) (any, error) { return s.UsageSummary(c.Ctx, c.Params["id"]) }},
		web.Endpoint{Method: "POST", Path: "/subscriptions/admin/accounts/:id/preflight", Resource: manage, Access: web.Owner,
			Tool: &web.Tool{Name: "subscriptions_credits_preflight", Description: "Check whether a batch fits before running it. Body: productId and credits, or estimate {rateId, inputTokens, maxOutputTokens}. Returns fits, reason (inactive|payment|product|credits), available, missing, windows and a topUp offer. Never writes.",
				Example: map[string]any{"params": map[string]any{"id": "USER_ID"}, "body": map[string]any{"productId": "api", "estimate": map[string]any{"rateId": "standard", "inputTokens": 1200, "maxOutputTokens": 800}}}},
			Handle: func(c *web.Context) (any, error) {
				return s.Preflight(c.Ctx, c.Params["id"], c.Request.Body["productId"], amountBody(c.Request.Body))
			}},
		web.Endpoint{Method: "POST", Path: "/subscriptions/admin/accounts/:id/reservations", Resource: manage, Access: web.Owner,
			Tool: &web.Tool{Name: "subscriptions_credits_reserve", Description: "Hold credits before a model call. Body: key (stable, e.g. turnId:step), productId, credits or estimate {rateId, inputTokens, maxOutputTokens}, optional ttlMs (default 900000) and reason. Reuse the key for retries; the same key with another amount fails with 409.",
				Example: map[string]any{"params": map[string]any{"id": "USER_ID"}, "body": map[string]any{"key": "turn-1:0", "productId": "api", "estimate": map[string]any{"rateId": "standard", "inputTokens": 1200, "maxOutputTokens": 800}}}},
			Handle: func(c *web.Context) (any, error) {
				return s.Reserve(c.Ctx, c.Params["id"], c.Request.Body["productId"], reservationBody(c.Request.Body), asAPI(c))
			}},
		web.Endpoint{Method: "POST", Path: "/subscriptions/admin/accounts/:id/reservations/:key/settle", Resource: manage, Access: web.Owner,
			Tool: &web.Tool{Name: "subscriptions_credits_settle", Description: "Charge the real usage of a reservation and release the rest. Body: inputTokens and outputTokens (priced with the reserved rate) or credits. Works after the reservation expired; returns uncovered credits it could not charge. Idempotent per key.",
				Example: map[string]any{"params": map[string]any{"id": "USER_ID", "key": "turn-1:0"}, "body": map[string]any{"inputTokens": 1200, "outputTokens": 150}}},
			Handle: func(c *web.Context) (any, error) {
				return s.Settle(c.Ctx, c.Params["id"], c.Params["key"], usageBody(c.Request.Body), asAPI(c))
			}},
		web.Endpoint{Method: "POST", Path: "/subscriptions/admin/accounts/:id/reservations/:key/release", Resource: manage, Access: web.Owner,
			Tool: &web.Tool{Name: "subscriptions_credits_release", Description: "Release a reservation without charging it (the call did not run). Idempotent per key.",
				Example: map[string]any{"params": map[string]any{"id": "USER_ID", "key": "turn-1:0"}}},
			Handle: func(c *web.Context) (any, error) { return s.Release(c.Ctx, c.Params["id"], c.Params["key"], asAPI(c)) }},
	)
	// Metering for backends with a scoped service key (resource "subscriptions.meter"): the owner
	// calls on the account in the path, source "api" and actorId "service:<key id>".
	endpoints = append(endpoints, s.meterEndpoints(asAPI)...)
	return web.Feature{ID: "subscriptions", Endpoints: endpoints}
}

// meterEndpoints are the web.Service endpoints of the subscriptions.meter scope.
func (s *Subscriptions) meterEndpoints(asAPI func(*web.Context) ReservationMeta) []web.Endpoint {
	const base = "/service/subscriptions/accounts/:id"
	account := func(c *web.Context) (string, error) { return id(c.Params["id"]) }
	endpoint := func(method, path string, handle func(c *web.Context, userID string) (any, error)) web.Endpoint {
		return web.Endpoint{Method: method, Path: base + path, Resource: Meter, Access: web.Service, Handle: func(c *web.Context) (any, error) {
			userID, err := account(c)
			if err != nil {
				return nil, err
			}
			return handle(c, userID)
		}}
	}
	return []web.Endpoint{
		endpoint("GET", "/usage", func(c *web.Context, u string) (any, error) { return s.UsageSummary(c.Ctx, u) }),
		endpoint("POST", "/preflight", func(c *web.Context, u string) (any, error) {
			return s.Preflight(c.Ctx, u, c.Request.Body["productId"], amountBody(c.Request.Body))
		}),
		endpoint("POST", "/reservations", func(c *web.Context, u string) (any, error) {
			return s.Reserve(c.Ctx, u, c.Request.Body["productId"], reservationBody(c.Request.Body), asAPI(c))
		}),
		endpoint("POST", "/reservations/:key/settle", func(c *web.Context, u string) (any, error) {
			return s.Settle(c.Ctx, u, c.Params["key"], usageBody(c.Request.Body), asAPI(c))
		}),
		endpoint("POST", "/reservations/:key/release", func(c *web.Context, u string) (any, error) {
			return s.Release(c.Ctx, u, c.Params["key"], asAPI(c))
		}),
		// Debits only: a metering key charges usage; adding credits stays with the owner.
		endpoint("POST", "/ledger", func(c *web.Context, u string) (any, error) {
			body := c.Request.Body
			if n, ok := body["credits"].(float64); ok && n > 0 {
				return nil, apperr.New(403, "Service keys can only record debits")
			}
			input := map[string]any{}
			for _, k := range []string{"requestId", "productId", "credits", "kind", "reason"} {
				if v, ok := body[k]; ok {
					input[k] = v
				}
			}
			if details := ledgerDetails(body["details"]); details != nil {
				input["details"] = details
			}
			input["source"], input["actorId"] = "api", actorID(c.Actor)
			return s.RecordCredits(c.Ctx, u, input, RecordOrder...)
		}),
	}
}

// ledgerDetails sanitizes request details: 20 entries, keys cut to 40 and strings to 200
// UTF-16 units (nil when not an object).
func ledgerDetails(v any) map[string]any {
	details := obj(v)
	if details == nil {
		return nil
	}
	clean := map[string]any{}
	for i, k := range mapKeys(details, nil) {
		if i >= 20 {
			break
		}
		value := details[k]
		switch value.(type) {
		case float64, bool:
		default:
			value = cutUTF16(jsString(value), 200)
		}
		clean[cutUTF16(k, 40)] = value
	}
	return clean
}

// AccountView is GET /subscriptions/admin/accounts/:id: the account (with the USERS email),
// billing, grants (query.historyCursor) and usage receipts (query.cursor).
func (s *Subscriptions) AccountView(ctx context.Context, userID string, query map[string]string) (map[string]any, error) {
	me, err := s.Me(ctx, userID)
	if err != nil {
		return nil, err
	}
	user, err := s.store.Get(ctx, "USERS", userID)
	if err != nil {
		return nil, err
	}
	me["email"] = rowData(user)["email"]
	billing, err := s.Billing(ctx, userID)
	if err != nil {
		return nil, err
	}
	grants, err := s.store.List(ctx, "SUB_GRANTS#"+userID, query["historyCursor"])
	if err != nil {
		return nil, err
	}
	usage, err := s.store.List(ctx, "SUB_USAGE#"+userID, query["cursor"])
	if err != nil {
		return nil, err
	}
	return map[string]any{"account": me, "billing": billing, "grants": grants, "usage": usage}, nil
}

// SimulateStatus is POST /subscriptions/admin/accounts/:id/simulate (local billing only).
func (s *Subscriptions) SimulateStatus(ctx context.Context, userID string, status any) (map[string]any, error) {
	simulator, ok := s.provider.(Simulator)
	if !ok {
		return nil, notFound("Simulation unavailable")
	}
	row, err := s.account(ctx, userID)
	if err != nil {
		return nil, err
	}
	if !truthy(rowData(row)["customerId"]) {
		return nil, notFound("No simulated customer")
	}
	value, _ := status.(string)
	if !slices.Contains([]string{"active", "past_due", "canceled"}, value) {
		value = "\x00" // not a state: rejected like any non-string
	}
	if err := simulator.Simulate(ctx, str(row.Data["customerId"]), value); err != nil {
		return nil, err
	}
	if err := s.Sync(ctx, userID); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true}, nil
}

// RecordFromBody is POST /subscriptions/admin/accounts/:id/ledger: the body fields, details
// sanitized (20 entries, keys cut to 40 and strings to 200 UTF-16 units), source "admin" and
// the admin as actor.
func (s *Subscriptions) RecordFromBody(ctx context.Context, userID string, body map[string]any, actor string) (map[string]any, error) {
	input := map[string]any{}
	for _, k := range []string{"requestId", "productId", "credits", "kind", "reason", "amountMinor", "currency"} {
		if v, ok := body[k]; ok {
			input[k] = v
		}
	}
	if details := ledgerDetails(body["details"]); details != nil {
		input["details"] = details
	}
	input["source"], input["actorId"] = "admin", actor
	return s.RecordCredits(ctx, userID, input, RecordOrder...)
}
