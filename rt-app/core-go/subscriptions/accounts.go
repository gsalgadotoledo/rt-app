package subscriptions

import (
	"context"
	"math"
	"strings"
	"time"

	"rt.local/core-go/apperr"
	"rt.local/core-go/internal/canonical"
	"rt.local/core-go/internal/js"
	"rt.local/core-go/nosql"
)

func (s *Subscriptions) account(ctx context.Context, userID string) (*nosql.Row, error) {
	return s.store.Get(ctx, "SUB_ACCOUNTS", userID)
}

// normalized applies lazy unpaid renewals and moves the day/week windows to now (a deep copy).
func (s *Subscriptions) normalized(data map[string]any) map[string]any {
	next := cloneMap(data)
	if next == nil {
		next = map[string]any{}
	}
	now := s.now()
	plan := obj(next["plan"])
	if next["mode"] == "none" && truthy(next["plan"]) && next["status"] == "active" && !truthy(next["cancelAtPeriodEnd"]) && now >= num(next["periodEnd"]) {
		step := num(plan["periodDays"]) * day
		periods := math.Floor((now - num(next["periodStart"])) / step)
		next["periodStart"] = num(next["periodStart"]) + periods*step
		next["periodEnd"] = num(next["periodStart"]) + step
		next["counters"] = map[string]any{}
	}
	for _, item := range list(plan["products"]) {
		p := obj(item)
		key := jsString(p["id"])
		counters := obj(next["counters"])
		c := obj(counters[key])
		if c == nil {
			if counters == nil {
				counters = map[string]any{}
				next["counters"] = counters
			}
			c = map[string]any{"period": 0.0, "day": 0.0, "week": 0.0, "dayStart": next["periodStart"], "weekStart": next["periodStart"]}
			counters[key] = c
		}
		for _, w := range []struct {
			window  string
			seconds float64
		}{{"day", num(p["daySeconds"])}, {"week", num(p["weekSeconds"])}} {
			field := w.window + "Start"
			if now >= num(c[field])+w.seconds*1000 {
				c[field] = num(c[field]) + math.Floor((now-num(c[field]))/(w.seconds*1000))*w.seconds*1000
				c[w.window] = 0.0
				resetRateWindow(c, w.window)
			}
		}
		// The short window starts with the first use after the previous one ended.
		if p["shortSeconds"] != nil && (c["shortStart"] == nil || now >= num(c["shortStart"])+num(p["shortSeconds"])*1000) {
			c["short"] = 0.0
			c["shortStart"] = now
			resetRateWindow(c, "short")
		}
	}
	if truthy(next["adminGrant"]) {
		next["adminGrant"] = s.normalized(obj(next["adminGrant"]))
	}
	return next
}

// effective is the active admin grant, else the account itself (admin reports which).
func (s *Subscriptions) effective(data map[string]any) (entitlement map[string]any, admin bool) {
	grant := obj(data["adminGrant"])
	if grant != nil && grant["status"] == "active" && s.now() < num(grant["periodEnd"]) {
		return grant, true
	}
	return data, false
}

func (s *Subscriptions) activeEntitlement(e map[string]any) bool {
	return truthy(e["plan"]) && e["status"] == "active" && !(s.now() >= num(e["periodEnd"]))
}

func findProduct(plan map[string]any, productID string) map[string]any {
	for _, p := range list(plan["products"]) {
		if obj(p)["id"] == productID {
			return obj(p)
		}
	}
	return nil
}

// allowanceLeft is the plan allowance usable now: the tightest of the day, week and period.
func (s *Subscriptions) allowanceLeft(data map[string]any, productID string) float64 {
	e, _ := s.effective(data)
	if !s.activeEntitlement(e) {
		return 0
	}
	product := findProduct(obj(e["plan"]), productID)
	c := obj(obj(e["counters"])[productID])
	if product == nil || c == nil {
		return 0
	}
	left := math.Min(math.Min(num(product["dailyLimit"])-num(c["day"]), num(product["weeklyLimit"])-num(c["week"])), num(product["credits"])-num(c["period"]))
	if product["shortSeconds"] != nil {
		left = math.Min(left, num(product["shortLimit"])-numOr(c["short"], 0))
	}
	return math.Max(0, left)
}

// resetRateWindow zeroes one window of every per-model counter (counters[product].rates).
func resetRateWindow(c map[string]any, window string) {
	for _, r := range obj(c["rates"]) {
		if m := obj(r); m != nil && m[window] != nil {
			m[window] = 0.0
		}
	}
}

// available is the allowance left plus the additional (non-expiring) credits, minus the
// credits held by active reservations (see free).
func (s *Subscriptions) available(data map[string]any, productID string) float64 {
	free := s.free(data, productID)
	return free.allowance + free.balance
}

// windows are the allowance windows of the active entitlement (nil without one).
func (s *Subscriptions) windows(data map[string]any) *CurrentWindow {
	e, admin := s.effective(data)
	if !s.activeEntitlement(e) {
		return nil
	}
	plan := obj(e["plan"])
	key := "own:"
	if admin {
		key = "admin:"
	}
	w := &CurrentWindow{Key: key + jsString(plan["id"]), PeriodStart: num(e["periodStart"]), PeriodMs: num(plan["periodDays"]) * day, Products: []CurrentProduct{}}
	for _, item := range list(plan["products"]) {
		p := obj(item)
		pid := jsString(p["id"])
		start := obj(obj(e["counters"])[pid])["weekStart"]
		if start == nil {
			start = e["periodStart"]
		}
		w.Products = append(w.Products, CurrentProduct{ID: pid, Name: str(p["name"]), WeeklyLimit: num(p["weeklyLimit"]), WeekSeconds: num(p["weekSeconds"]), Start: num(start)})
	}
	return w
}

// pendingWindows are the allowance/expiry entries owed since the last write.
func (s *Subscriptions) pendingWindows(raw, data map[string]any) Rolled {
	var previous *WindowState
	if stored := obj(raw["ledgerWindows"]); stored != nil {
		var state WindowState
		if fromJSON(stored, &state) == nil {
			previous = &state
			// Go maps lose property order: the entitlement's product order stands for it.
			owner := raw
			if strings.HasPrefix(state.Key, "admin:") {
				owner = obj(raw["adminGrant"])
			}
			ids := make([]string, len(state.Products))
			byID := map[string]Window{}
			for i, w := range state.Products {
				ids[i] = w.ID
				byID[w.ID] = w
			}
			ordered := jsKeys(ids, productIDs(obj(owner["plan"])))
			for i, pid := range ordered {
				state.Products[i] = byID[pid]
			}
		}
	}
	counters := obj(raw["counters"])
	if previous != nil && strings.HasPrefix(previous.Key, "admin:") {
		counters = obj(obj(raw["adminGrant"])["counters"])
	}
	used := func(productID string, start float64) float64 {
		c := obj(counters[productID])
		if c != nil && num(c["weekStart"]) == start {
			return num(c["week"])
		}
		return 0
	}
	return Rollover(previous, s.windows(data), used, s.now())
}

// ledgerEntry appends one statement entry, folding it into the account totals.
func (s *Subscriptions) ledgerEntry(userID string, data, entry map[string]any, seed string) nosql.Write {
	sequence := numOr(data["ledgerSequence"], 0) + 1
	data["ledgerSequence"] = sequence
	full := spread(entry)
	if truthy(entry["productId"]) {
		full["available"] = s.available(data, jsString(entry["productId"]))
	}
	var e Entry
	if err := fromJSON(full, &e); err != nil {
		panic(err)
	}
	written, err := LedgerWrite(userID, e, seed, sequence)
	if err != nil {
		panic(err)
	}
	var totals *Totals
	if stored := data["ledgerTotals"]; stored != nil {
		totals = &Totals{}
		if err := fromJSON(stored, totals); err != nil {
			totals = nil
		}
	}
	data["ledgerTotals"] = toJSON(ApplyTotals(totals, written.Entry))
	return written.Write
}

// settle writes the window rollover before any other change of the same write.
func (s *Subscriptions) settle(userID string, raw, data map[string]any) []nosql.Write {
	rolled := s.pendingWindows(raw, data)
	if rolled.State == nil {
		data["ledgerWindows"] = nil
	} else {
		data["ledgerWindows"] = toJSON(rolled.State)
	}
	writes := make([]nosql.Write, 0, len(rolled.Entries))
	for _, p := range rolled.Entries {
		writes = append(writes, s.ledgerEntry(userID, data, pendingEntry(p, "system"), p.Seed))
	}
	return writes
}

func pendingEntry(p Pending, source string) map[string]any {
	entry := obj(toJSON(p))
	delete(entry, "seed")
	entry["source"] = source
	return entry
}

func dayKey(at float64) string {
	return time.UnixMilli(int64(at)).UTC().Format("2006-01-02")
}

func isoTime(at float64) string {
	return time.UnixMilli(int64(at)).UTC().Format("2006-01-02T15:04:05.000Z")
}

// statsWrite counts a new or canceled subscription for today (SUB_STATS day:<date>).
func (s *Subscriptions) statsWrite(ctx context.Context, event string) (nosql.Write, error) {
	key := "day:" + dayKey(s.now())
	row, err := s.store.Get(ctx, "SUB_STATS", key)
	if err != nil {
		return nosql.Write{}, err
	}
	data := spread(map[string]any{"new": 0.0, "canceled": 0.0}, rowData(row))
	data[event] = num(data[event]) + 1
	return write(row, "SUB_STATS", key, data), nil
}

func emailValue(email string) any {
	if email == "" {
		return nil
	}
	return email
}

// Me is the account view of a user: entitlement, usage, plans and billing state.
func (s *Subscriptions) Me(ctx context.Context, userID string) (map[string]any, error) {
	row, err := s.account(ctx, userID)
	if err != nil {
		return nil, err
	}
	settings, err := s.Settings(ctx)
	if err != nil {
		return nil, err
	}
	values := settings["values"].(map[string]any)
	var data map[string]any
	if row != nil {
		data = s.normalized(row.Data)
	} else {
		data = map[string]any{"userId": userID, "status": "none", "counters": map[string]any{}, "notifications": true}
	}
	entitlement, admin := s.effective(data)
	safe := spread(data)
	billingOperation := safe["billingOperation"]
	delete(safe, "billingOperation")
	delete(safe, "adminGrant")
	view := safe
	if admin {
		view = spread(safe, entitlement)
	}
	view["userId"] = userID
	var pendingRequest any
	if truthy(billingOperation) {
		pending, err := s.store.Get(ctx, "SUB_BILLING_OP#"+userID, jsString(billingOperation))
		if err != nil {
			return nil, err
		}
		if pending != nil {
			input := obj(pending.Data["input"])
			pendingRequest = map[string]any{"requestId": billingOperation, "action": input["action"], "planId": input["planId"]}
		}
	}
	paymentRequired := values["paymentRequired"] == true
	active := entitlement["status"] == "active" && s.now() < num(entitlement["periodEnd"]) &&
		(!paymentRequired || entitlement["mode"] == "admin" || js.Equal(entitlement["mode"], s.providerMode()))
	plans := []any{}
	for _, p := range list(values["plans"]) {
		if truthy(obj(p)["enabled"]) {
			plans = append(plans, p)
		}
	}
	usage := []any{}
	for _, item := range list(obj(entitlement["plan"])["products"]) {
		p := obj(item)
		pid := jsString(p["id"])
		c := obj(obj(entitlement["counters"])[pid])
		item := spread(p, map[string]any{
			"used": c["period"], "remaining": s.available(data, pid), "allowanceLeft": s.allowanceLeft(data, pid),
			"extraCredits": numOr(obj(data["creditBalance"])[pid], 0), "dayUsed": c["day"], "weekUsed": c["week"],
			"dayResetAt": num(c["dayStart"]) + num(p["daySeconds"])*1000, "weekResetAt": num(c["weekStart"]) + num(p["weekSeconds"])*1000,
		})
		if p["shortSeconds"] != nil {
			item["shortUsed"] = c["short"]
			item["shortResetAt"] = num(c["shortStart"]) + num(p["shortSeconds"])*1000
		}
		usage = append(usage, item)
	}
	version := 0
	if row != nil {
		version = row.Version
	}
	var publishable any
	if s.provider != nil && s.provider.PublishableKey() != "" {
		publishable = s.provider.PublishableKey()
	}
	provider := any("none")
	if s.provider != nil {
		provider = s.provider.Mode()
	}
	return spread(view, map[string]any{
		"assignedByAdmin": admin, "pendingBillingRequest": pendingRequest, "active": active,
		"version": float64(version), "paymentRequired": paymentRequired, "provider": provider,
		"publishableKey": publishable, "plans": plans, "usage": usage,
	}), nil
}

// Preferences sets the user's notification preference (a boolean).
func (s *Subscriptions) Preferences(ctx context.Context, userID string, enabled any) (map[string]any, error) {
	if _, ok := enabled.(bool); !ok {
		return nil, apperr.BadRequest("Invalid notification preference")
	}
	return retry(func() (map[string]any, error) {
		row, err := s.account(ctx, userID)
		if err != nil {
			return nil, err
		}
		data := spread(rowData(row), map[string]any{"userId": userID, "notifications": enabled})
		if err := s.store.Transact(ctx, []nosql.Write{write(row, "SUB_ACCOUNTS", userID, data)}); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true}, nil
	})
}

// Change selects a plan: unpaid directly, paid through a billing operation.
func (s *Subscriptions) Change(ctx context.Context, user User, planID, key string) (any, error) {
	if _, err := id(key); err != nil {
		return nil, err
	}
	existing, err := s.account(ctx, user.ID)
	if err != nil {
		return nil, err
	}
	if existing != nil && truthy(existing.Data["adminGrant"]) {
		if _, admin := s.effective(existing.Data); admin {
			return nil, apperr.New(409, "An administrator-assigned plan is active. Contact your administrator to change it.")
		}
	}
	config, err := s.Settings(ctx)
	if err != nil {
		return nil, err
	}
	values := config["values"].(map[string]any)
	var plan map[string]any
	for _, p := range list(values["plans"]) {
		if obj(p)["id"] == planID && truthy(obj(p)["enabled"]) {
			plan = obj(p)
			break
		}
	}
	if plan == nil {
		return nil, apperr.NotFound("Plan not found")
	}
	paid := values["paymentRequired"] == true
	if paid {
		op, err := s.store.Get(ctx, "SUB_BILLING_OP#"+user.ID, key)
		if err != nil {
			return nil, err
		}
		if validator, ok := s.provider.(PlanValidator); ok && op == nil {
			account, err := s.account(ctx, user.ID)
			if err != nil {
				return nil, err
			}
			if err := validator.ValidatePlan(ctx, plan, str(rowData(account)["customerId"])); err != nil {
				return nil, err
			}
		}
		return s.billingOperation(ctx, user, key, []pair{{"action", "change"}, {"planId", planID}, {"plan", plan}}, func(data, request map[string]any) (map[string]any, error) {
			selected := obj(request["plan"])
			result, err := s.provider.Change(ctx, str(data["customerId"]), selected, str(data["subscriptionId"]), key)
			if err != nil {
				return nil, err
			}
			return spread(result, map[string]any{"requestedPlan": selected}), nil
		})
	}
	return retry(func() (any, error) {
		old, err := s.account(ctx, user.ID)
		if err != nil {
			return nil, err
		}
		op, err := s.store.Get(ctx, "SUB_OP#"+user.ID, key)
		if err != nil {
			return nil, err
		}
		if op != nil {
			if op.Data["planId"] != planID {
				return nil, apperr.Conflict()
			}
			return op.Data["result"], nil
		}
		previous := rowData(old)
		if truthy(previous["customerId"]) || truthy(previous["subscriptionId"]) {
			return nil, apperr.New(409, "Cancel and reconcile the paid subscription before switching to unpaid mode")
		}
		now := s.now()
		continuing := previous["status"] == "active" && now < num(previous["periodEnd"])
		if continuing && obj(previous["plan"])["id"] == planID {
			return nil, apperr.New(409, "Already subscribed to this plan")
		}
		fields := map[string]any{
			"userId": user.ID, "email": emailValue(user.Email), "plan": cloneMap(plan), "status": "active", "mode": "none",
			"cancelAtPeriodEnd": false, "periodStart": now, "periodEnd": now + num(plan["periodDays"])*day,
			"counters": map[string]any{}, "createdAt": orDefault(previous["createdAt"], now), "updatedAt": now,
		}
		if continuing {
			fields["periodStart"], fields["periodEnd"], fields["counters"] = previous["periodStart"], previous["periodEnd"], previous["counters"]
		}
		data := s.normalized(spread(previous, fields))
		result := map[string]any{"ok": true}
		settled := s.settle(user.ID, previous, data)
		reason := "Plan started: "
		if continuing {
			reason = "Plan changed to "
		}
		planEntry := s.ledgerEntry(user.ID, data, map[string]any{"at": now, "kind": "plan", "source": "user", "credits": 0.0, "planId": planID, "reason": reason + jsString(plan["name"]), "requestId": key}, "plan:"+key)
		writes := []nosql.Write{write(old, "SUB_ACCOUNTS", user.ID, data), write(nil, "SUB_OP#"+user.ID, key, map[string]any{"planId": planID, "result": result}), planEntry}
		writes = append(writes, settled...)
		if !continuing {
			stats, err := s.statsWrite(ctx, "new")
			if err != nil {
				return nil, err
			}
			writes = append(writes, stats)
		}
		writes = append(writes, s.audit(map[string]any{"userId": user.ID, "action": "plan-change", "planId": planID, "at": now}))
		if err := s.store.Transact(ctx, writes); err != nil {
			return nil, err
		}
		return result, nil
	})
}

// billingOperation persists the request before calling the provider, so it can be retried
// with the same key without charging twice. input is ordered: the fingerprint is
// sha256hex(JSON.stringify(input without plan)).
func (s *Subscriptions) billingOperation(ctx context.Context, user User, key string, input []pair, run func(data, request map[string]any) (map[string]any, error)) (any, error) {
	if s.provider == nil {
		return nil, apperr.New(503, "Payments are not configured")
	}
	if _, err := id(key); err != nil {
		return nil, err
	}
	var fields []pair
	stored := map[string]any{}
	for _, p := range input {
		stored[p.key] = p.value
		if p.key != "plan" {
			fields = append(fields, p)
		}
	}
	fingerprint := canonical.SHA256Hex(stringify(fields))
	opPK := "SUB_BILLING_OP#" + user.ID
	old, err := s.account(ctx, user.ID)
	if err != nil {
		return nil, err
	}
	operation, err := s.store.Get(ctx, opPK, key)
	if err != nil {
		return nil, err
	}
	if operation != nil && operation.Data["fingerprint"] != fingerprint {
		return nil, apperr.Conflict()
	}
	if operation != nil && truthy(operation.Data["result"]) {
		return operation.Data["result"], nil
	}
	if pending := rowData(old)["billingOperation"]; truthy(pending) && pending != key {
		return nil, apperr.New(409, "Another billing operation is pending. Retry it before starting a new one.")
	}
	if operation == nil {
		err := s.store.Transact(ctx, []nosql.Write{
			write(nil, opPK, key, map[string]any{"fingerprint": fingerprint, "input": stored, "started": s.now()}),
			write(old, "SUB_ACCOUNTS", user.ID, spread(rowData(old), map[string]any{"userId": user.ID, "email": emailValue(user.Email), "billingOperation": key})),
		})
		if err != nil {
			return nil, err
		}
	} else if s.now()-num(operation.Data["started"]) > 23*3600000 {
		return nil, apperr.New(409, "Billing operation needs reconciliation; do not create another payment")
	}
	if old, err = s.account(ctx, user.ID); err != nil {
		return nil, err
	}
	if !truthy(rowData(old)["customerId"]) {
		customerID, err := s.provider.Customer(ctx, user, "customer-"+user.ID)
		if err != nil {
			return nil, err
		}
		_, err = retry(func() (any, error) {
			row, err := s.account(ctx, user.ID)
			if err != nil {
				return nil, err
			}
			mapping, err := s.store.Get(ctx, "SUB_CUSTOMERS", customerID)
			if err != nil {
				return nil, err
			}
			writes := []nosql.Write{write(row, "SUB_ACCOUNTS", user.ID, spread(rowData(row), map[string]any{"customerId": customerID}))}
			if mapping == nil {
				writes = append(writes, write(nil, "SUB_CUSTOMERS", customerID, map[string]any{"userId": user.ID}))
			}
			return nil, s.store.Transact(ctx, writes)
		})
		if err != nil {
			return nil, err
		}
	}
	account, err := s.account(ctx, user.ID)
	if err != nil {
		return nil, err
	}
	op, err := s.store.Get(ctx, opPK, key)
	if err != nil {
		return nil, err
	}
	result, err := run(account.Data, obj(op.Data["input"]))
	if err != nil {
		return nil, err
	}
	_, err = retry(func() (any, error) {
		row, err := s.account(ctx, user.ID)
		if err != nil {
			return nil, err
		}
		op, err := s.store.Get(ctx, opPK, key)
		if err != nil {
			return nil, err
		}
		if truthy(op.Data["result"]) {
			return nil, nil
		}
		if row.Data["billingOperation"] != key {
			return nil, apperr.Conflict()
		}
		data := spread(row.Data, map[string]any{"billingOperation": nil})
		if truthy(result["subscriptionId"]) {
			data["subscriptionId"] = result["subscriptionId"]
		}
		if truthy(result["requestedPlan"]) {
			data["pendingPlan"] = result["requestedPlan"]
		}
		return nil, s.store.Transact(ctx, []nosql.Write{write(row, "SUB_ACCOUNTS", user.ID, data), write(op, op.PK, op.SK, spread(op.Data, map[string]any{"result": result}))})
	})
	if err != nil {
		return nil, err
	}
	if err := s.Sync(ctx, user.ID); err != nil {
		return nil, err
	}
	return result, nil
}

// SetupPayment starts a payment method setup (a billing operation).
func (s *Subscriptions) SetupPayment(ctx context.Context, user User, key string) (any, error) {
	return s.billingOperation(ctx, user, key, []pair{{"action", "setup"}}, func(data, _ map[string]any) (map[string]any, error) {
		return s.provider.Setup(ctx, str(data["customerId"]), key)
	})
}

// SetPayment saves a payment method set up by the provider.
func (s *Subscriptions) SetPayment(ctx context.Context, user User, setupID any) (map[string]any, error) {
	row, err := s.account(ctx, user.ID)
	if err != nil {
		return nil, err
	}
	if !truthy(rowData(row)["customerId"]) || s.provider == nil {
		return nil, apperr.BadRequest("No billing customer")
	}
	setup, err := id(setupID)
	if err != nil {
		return nil, err
	}
	if err := s.provider.SetPaymentMethod(ctx, str(row.Data["customerId"]), setup, str(row.Data["subscriptionId"])); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true}, nil
}

// Cancel ends the subscription with its period (a billing operation for paid subscriptions).
func (s *Subscriptions) Cancel(ctx context.Context, user User, key string) (any, error) {
	row, err := s.account(ctx, user.ID)
	if err != nil {
		return nil, err
	}
	if truthy(rowData(row)["subscriptionId"]) && s.provider != nil {
		return s.billingOperation(ctx, user, key, []pair{{"action", "cancel"}}, func(data, _ map[string]any) (map[string]any, error) {
			return s.provider.Cancel(ctx, str(data["customerId"]), str(data["subscriptionId"]), key)
		})
	}
	return retry(func() (any, error) {
		row, err := s.account(ctx, user.ID)
		if err != nil {
			return nil, err
		}
		if row == nil {
			return nil, apperr.NotFound("No subscription")
		}
		if e, _ := s.effective(row.Data); !truthy(e["plan"]) {
			return nil, apperr.NotFound("No subscription")
		}
		if truthy(row.Data["cancelAtPeriodEnd"]) {
			return map[string]any{"ok": true}, nil
		}
		data := spread(row.Data, map[string]any{"cancelAtPeriodEnd": true})
		account := write(row, "SUB_ACCOUNTS", user.ID, data)
		entry := s.ledgerEntry(user.ID, data, map[string]any{"at": s.now(), "kind": "plan", "source": "user", "credits": 0.0, "planId": obj(row.Data["plan"])["id"], "reason": "Subscription canceled; access continues until the period ends", "requestId": key}, "cancel:"+key)
		stats, err := s.statsWrite(ctx, "canceled")
		if err != nil {
			return nil, err
		}
		if err := s.store.Transact(ctx, []nosql.Write{account, entry, stats}); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true}, nil
	})
}

// Sync reads the provider's state of the user's subscription into the account.
func (s *Subscriptions) Sync(ctx context.Context, userID string) error {
	if s.provider == nil {
		return nil
	}
	old, err := s.account(ctx, userID)
	if err != nil || old == nil || !truthy(old.Data["customerId"]) {
		return err
	}
	snapshot, err := s.provider.Snapshot(ctx, str(old.Data["customerId"]), str(old.Data["subscriptionId"]))
	if err != nil {
		return err
	}
	if !truthy(snapshot["subscriptionId"]) {
		return nil
	}
	config, err := s.Settings(ctx)
	if err != nil {
		return err
	}
	var plan map[string]any
	if s.provider.Mode() == "local" {
		plan = obj(orDefault(old.Data["pendingPlan"], old.Data["plan"]))
	} else {
		priceID := jsString(snapshot["priceId"])
		mapped, err := s.store.Get(ctx, "SUB_PLAN_PRICES", priceID)
		if err != nil {
			return err
		}
		plan = obj(rowData(mapped)["plan"])
		if plan == nil {
			for _, p := range list(config["values"].(map[string]any)["plans"]) {
				if js.Equal(obj(p)["stripePriceId"], snapshot["priceId"]) {
					plan = obj(p)
					break
				}
			}
		}
		if own := obj(old.Data["plan"]); plan == nil && own != nil && js.Equal(own["stripePriceId"], snapshot["priceId"]) {
			plan = own
		}
	}
	if plan == nil {
		return apperr.New(409, "Stripe price is not mapped to a configured plan")
	}
	renewed := !js.Equal(old.Data["periodStart"], snapshot["periodStart"])
	counters := old.Data["counters"]
	if renewed {
		counters = map[string]any{}
	}
	data := s.normalized(spread(old.Data, snapshot, map[string]any{
		"plan": plan, "mode": s.provider.Mode(), "counters": counters, "updatedAt": s.now(), "createdAt": orDefault(old.Data["createdAt"], s.now()),
	}))
	now := s.now()
	was := old.Data
	wasActive := was["status"] == "active" && truthy(was["plan"]) && now < num(was["periodEnd"])
	isActive := data["status"] == "active" && now < num(data["periodEnd"])
	wasSubscribed := truthy(was["plan"]) && was["status"] != "canceled" && now < num(was["periodEnd"])
	writes := s.settle(userID, was, data)
	planID := jsString(plan["id"])
	if isActive && (renewed || !js.Equal(obj(was["plan"])["id"], plan["id"])) {
		reason := "Plan started: "
		if wasActive {
			reason = "Plan changed to "
			if renewed {
				reason = "Plan renewed: "
			}
		}
		writes = append(writes, s.ledgerEntry(userID, data, map[string]any{
			"at": now, "kind": "plan", "source": "billing", "credits": 0.0, "planId": plan["id"], "reason": reason + jsString(plan["name"]),
			"amountMinor": plan["amount"], "currency": plan["currency"],
		}, "billing:"+planID+":"+jsString(data["periodStart"])+":"+s.newID()))
	}
	if isActive && !wasSubscribed {
		stats, err := s.statsWrite(ctx, "new")
		if err != nil {
			return err
		}
		writes = append(writes, stats)
	}
	canceled := (truthy(data["cancelAtPeriodEnd"]) && !truthy(was["cancelAtPeriodEnd"])) ||
		(data["status"] == "canceled" && was["status"] != "canceled" && !truthy(was["cancelAtPeriodEnd"]))
	if canceled {
		writes = append(writes, s.ledgerEntry(userID, data, map[string]any{"at": now, "kind": "plan", "source": "billing", "credits": 0.0, "planId": plan["id"], "reason": "Subscription canceled: " + jsString(plan["name"])}, "billing-cancel:"+planID+":"+s.newID()))
		stats, err := s.statsWrite(ctx, "canceled")
		if err != nil {
			return err
		}
		writes = append(writes, stats)
	}
	return s.store.Transact(ctx, append([]nosql.Write{write(old, "SUB_ACCOUNTS", userID, data)}, writes...))
}

// Billing is the provider's billing snapshot of the user (empty without a customer).
func (s *Subscriptions) Billing(ctx context.Context, userID string) (map[string]any, error) {
	row, err := s.account(ctx, userID)
	if err != nil {
		return nil, err
	}
	if truthy(rowData(row)["customerId"]) && s.provider != nil {
		return s.provider.Snapshot(ctx, str(row.Data["customerId"]), str(row.Data["subscriptionId"]))
	}
	return map[string]any{"invoices": []any{}, "paymentMethods": []any{}, "amountDue": 0.0, "totalPaid": 0.0, "currency": nil}, nil
}

// Grant assigns a plan or additional credits without charging
// ({requestId, kind, planId|productId, credits, valueMinor, currency, reason}).
func (s *Subscriptions) Grant(ctx context.Context, userID string, input any, actorID string) (map[string]any, error) {
	in := obj(input)
	key, err := id(in["requestId"])
	if err != nil {
		return nil, err
	}
	kind := in["kind"]
	if kind != "plan" && kind != "credits" {
		return nil, apperr.BadRequest("Invalid assignment type")
	}
	reason := js.Trim(strOf(in["reason"], ""))
	if reason == "" || js.Len(reason) > 300 {
		return nil, apperr.BadRequest("A short reason is required")
	}
	currency := js.ToLower(strOf(in["currency"], ""))
	if !ValidCurrency(currency) {
		return nil, apperr.BadRequest(msgCurrency)
	}
	valueMinor, err := integer(in["valueMinor"], 0, 1e9)
	if err != nil {
		return nil, err
	}
	if !ValidMinorAmount(valueMinor, currency) {
		return nil, apperr.BadRequest(msgAmount)
	}
	targetValue := in["productId"]
	if kind == "plan" {
		targetValue = in["planId"]
	}
	target, err := id(targetValue)
	if err != nil {
		return nil, err
	}
	credits := 0.0
	if kind == "credits" {
		if credits, err = integer(in["credits"], 1, 1e9); err != nil {
			return nil, err
		}
	}
	fingerprint := stringify([]pair{{"kind", kind}, {"target", target}, {"credits", credits}, {"valueMinor", valueMinor}, {"currency", currency}, {"reason", reason}, {"actorId", actorID}})
	return retry(func() (map[string]any, error) {
		prior, err := s.store.Get(ctx, "SUB_GRANTS#"+userID, key)
		if err != nil {
			return nil, err
		}
		if prior != nil {
			if prior.Data["fingerprint"] != fingerprint {
				return nil, apperr.Conflict()
			}
			return map[string]any{"ok": true}, nil
		}
		user, err := s.store.Get(ctx, "USERS", userID)
		if err != nil {
			return nil, err
		}
		if user == nil || truthy(user.Data["deletedAt"]) {
			return nil, apperr.NotFound("User not found")
		}
		settings, err := s.Settings(ctx)
		if err != nil {
			return nil, err
		}
		plans := list(settings["values"].(map[string]any)["plans"])
		var plan map[string]any
		for _, p := range plans {
			if obj(p)["id"] == target {
				plan = obj(p)
				break
			}
		}
		if kind == "plan" && plan == nil {
			return nil, apperr.NotFound("Plan not found")
		}
		if kind == "credits" && !anyPlanHasProduct(plans, target) {
			return nil, apperr.NotFound("Product not found")
		}
		row, err := s.account(ctx, userID)
		if err != nil {
			return nil, err
		}
		data := s.normalized(spread(rowData(row), map[string]any{"userId": userID, "email": user.Data["email"]}))
		at := s.now()
		if kind == "plan" {
			data["adminGrant"] = map[string]any{
				"plan": plan, "mode": "admin", "status": "active", "periodStart": at, "periodEnd": at + num(plan["periodDays"])*day,
				"counters": map[string]any{}, "actorId": actorID, "reason": reason, "valueMinor": valueMinor, "currency": currency,
			}
		}
		if truthy(data["adminGrant"]) {
			data["adminGrant"] = s.normalized(obj(data["adminGrant"]))
		}
		if kind != "plan" {
			balance := obj(data["creditBalance"])
			if balance == nil {
				balance = map[string]any{}
				data["creditBalance"] = balance
			}
			next, err := integer(numOr(balance[target], 0)+credits, 0, 1e9)
			if err != nil {
				return nil, err
			}
			balance[target] = next
		}
		audit := map[string]any{"kind": kind, "target": target, "credits": credits, "valueMinor": valueMinor, "currency": currency, "reason": reason, "actorId": actorID, "userId": userID, "at": at, "source": "admin", "fingerprint": fingerprint}
		wasActive := s.windows(s.normalized(spread(rowData(row)))) != nil
		settled := s.settle(userID, rowData(row), data)
		entry := map[string]any{"at": at, "kind": "grant", "source": "admin", "credits": credits, "actorId": actorID, "requestId": key}
		if kind == "plan" {
			entry["kind"], entry["planId"] = "plan", target
			entry["reason"] = "Plan assigned by administrator: " + jsString(plan["name"]) + " · " + reason
		} else {
			entry["productId"] = target
			entry["reason"] = "Credits assigned by administrator · " + reason
		}
		if valueMinor != 0 {
			entry["amountMinor"], entry["currency"] = valueMinor, currency
		}
		ledger := s.ledgerEntry(userID, data, entry, "grant:"+key)
		writes := []nosql.Write{write(row, "SUB_ACCOUNTS", userID, data), write(nil, "SUB_GRANTS#"+userID, key, audit), ledger}
		writes = append(writes, settled...)
		if kind == "plan" && !wasActive {
			stats, err := s.statsWrite(ctx, "new")
			if err != nil {
				return nil, err
			}
			writes = append(writes, stats)
		}
		if err := s.store.Transact(ctx, writes); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true}, nil
	})
}

func anyPlanHasProduct(plans []any, productID string) bool {
	for _, p := range plans {
		if findProduct(obj(p), productID) != nil {
			return true
		}
	}
	return false
}

// Reset is a courtesy reset of usage windows ({requestId, scope: day|week|period|all, reason}).
func (s *Subscriptions) Reset(ctx context.Context, userID string, input any, actorID string) (map[string]any, error) {
	in := obj(input)
	key, err := id(in["requestId"])
	if err != nil {
		return nil, err
	}
	scope := in["scope"]
	if scope != "short" && scope != "day" && scope != "week" && scope != "period" && scope != "all" {
		return nil, apperr.BadRequest("Invalid reset scope")
	}
	reason := js.Trim(strOf(in["reason"], ""))
	if reason == "" || js.Len(reason) > 300 {
		return nil, apperr.BadRequest("A short courtesy reason is required")
	}
	return retry(func() (map[string]any, error) {
		op, err := s.store.Get(ctx, "SUB_RESET#"+userID, key)
		if err != nil {
			return nil, err
		}
		if op != nil {
			if op.Data["scope"] != scope || op.Data["reason"] != reason {
				return nil, apperr.Conflict()
			}
			return map[string]any{"ok": true}, nil
		}
		row, err := s.account(ctx, userID)
		if err != nil {
			return nil, err
		}
		if row == nil {
			return nil, apperr.NotFound("No subscription")
		}
		if e, _ := s.effective(s.normalized(row.Data)); !truthy(e["plan"]) {
			return nil, apperr.NotFound("No subscription")
		}
		data := s.normalized(row.Data)
		settled := s.settle(userID, row.Data, data)
		var entries []nosql.Write
		e, _ := s.effective(data)
		counters := obj(e["counters"])
		for _, pid := range mapKeys(counters, productIDs(obj(e["plan"]))) {
			c := obj(counters[pid])
			before := s.allowanceLeft(data, pid)
			for _, f := range []string{"short", "day", "week", "period"} {
				if (scope == "all" || scope == f) && (f != "short" || c["short"] != nil) {
					c[f] = 0.0
					resetRateWindow(c, f)
				}
			}
			restored := s.allowanceLeft(data, pid) - before
			entries = append(entries, s.ledgerEntry(userID, data, map[string]any{
				"at": s.now(), "kind": "reset", "source": "admin", "credits": restored, "productId": pid,
				"reason": "Courtesy reset (" + jsString(scope) + ") · " + reason, "actorId": actorID, "requestId": key,
			}, "reset:"+key+":"+pid))
		}
		audit := map[string]any{"userId": userID, "actorId": actorID, "scope": scope, "reason": reason, "at": s.now()}
		writes := append(settled, entries...)
		writes = append(writes,
			write(row, "SUB_ACCOUNTS", userID, spread(data, map[string]any{"courtesyResets": numOr(data["courtesyResets"], 0) + 1})),
			write(nil, "SUB_RESET#"+userID, key, audit),
			s.audit(spread(audit, map[string]any{"action": "courtesy-reset"})),
		)
		if err := s.store.Transact(ctx, writes); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true}, nil
	})
}

// ListUsers searches one USERS page ({q?, cursor?}) with each user's subscription summary.
func (s *Subscriptions) ListUsers(ctx context.Context, query map[string]string) (map[string]any, error) {
	q := js.ToLower(js.Trim(query["q"]))
	if js.Len(q) > 200 {
		return nil, apperr.BadRequest("Search is too long")
	}
	page, err := s.store.List(ctx, "USERS", query["cursor"])
	if err != nil {
		return nil, err
	}
	items := []any{}
	for _, r := range page.Items {
		if truthy(r.Data["deletedAt"]) {
			continue
		}
		if q != "" {
			match := false
			for _, v := range []any{r.SK, r.Data["email"], r.Data["name"]} {
				if strings.Contains(js.ToLower(strOf(v, "")), q) {
					match = true
				}
			}
			if !match {
				continue
			}
		}
		row, err := s.account(ctx, r.SK)
		if err != nil {
			return nil, err
		}
		base := s.normalized(rowData(row))
		data, _ := s.effective(base)
		products := productIDs(obj(data["plan"]))
		for _, pid := range mapKeys(obj(base["creditBalance"]), products) {
			if !contains(products, pid) {
				products = append(products, pid)
			}
		}
		total := 0.0
		for _, pid := range products {
			total += s.available(base, pid)
		}
		items = append(items, map[string]any{
			"creditsAvailable": total, "userId": r.SK, "email": r.Data["email"], "name": r.Data["name"],
			"plan": obj(data["plan"])["name"], "status": orDefault(data["status"], "none"), "source": data["mode"],
			"totalConsumed": numOr(rowData(row)["totalConsumed"], 0), "courtesyResets": numOr(rowData(row)["courtesyResets"], 0),
		})
	}
	var cursor any
	if page.Cursor != "" {
		cursor = page.Cursor
	}
	return map[string]any{"items": items, "cursor": cursor}, nil
}

var webhookEvents = []string{"invoice.payment_failed", "invoice.paid", "invoice.upcoming", "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted", "customer.subscription.trial_will_end"}
var notifiedEvents = []string{"invoice.payment_failed", "invoice.paid", "invoice.upcoming", "customer.subscription.deleted", "customer.subscription.trial_will_end"}

// Webhook handles a signed provider event: deduplicated, synchronized, optionally notified.
func (s *Subscriptions) Webhook(ctx context.Context, raw, signature string) (map[string]any, error) {
	if s.provider == nil {
		return nil, apperr.New(503, "Payments not configured")
	}
	event, err := s.provider.Verify(raw, signature)
	if err != nil {
		return nil, apperr.BadRequest("Invalid webhook signature")
	}
	ok := map[string]any{"ok": true}
	if event.Customer == "" || !contains(webhookEvents, event.Type) {
		return ok, nil
	}
	seen, err := s.store.Get(ctx, "SUB_EVENTS", event.ID)
	if err != nil || seen != nil {
		return ok, err
	}
	mapping, err := s.store.Get(ctx, "SUB_CUSTOMERS", event.Customer)
	if err != nil {
		return nil, err
	}
	if mapping == nil {
		return nil, apperr.New(409, "Customer mapping not ready")
	}
	userID := jsString(mapping.Data["userId"])
	if err := s.Sync(ctx, userID); err != nil {
		return nil, err
	}
	row, err := s.account(ctx, userID)
	if err != nil {
		return nil, err
	}
	settings, err := s.Settings(ctx)
	if err != nil {
		return nil, err
	}
	notify := settings["values"].(map[string]any)["notifications"] == true && rowData(row)["notifications"] != false && contains(notifiedEvents, event.Type)
	writes := []nosql.Write{write(nil, "SUB_EVENTS", event.ID, map[string]any{"type": event.Type, "at": s.now()})}
	if notify {
		writes = append(writes, write(nil, "SUB_MAIL", event.ID, map[string]any{"userId": userID, "to": rowData(row)["email"], "subject": "Subscription update", "text": strings.ReplaceAll(event.Type, ".", " · "), "sent": false}))
	}
	if err := s.store.Transact(ctx, writes); err != nil {
		if !isConflict(err) {
			return nil, err
		}
		if again, gerr := s.store.Get(ctx, "SUB_EVENTS", event.ID); gerr != nil || again == nil {
			return nil, err
		}
	}
	return ok, nil
}
