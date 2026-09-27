package subscriptions

// Finance limits (port of the finance-limit helpers of index.ts): per-model caps, provider
// costs, the margin rule and unit economics. Caps and the margin cap are read live from the
// settings (the plan with the entitlement's plan id); the windows keep the plan as subscribed.
// Contracts: spec/contracts/subscriptions-limits.contract.yaml and subscriptions-economics.

import (
	"context"
	"math"
	"slices"
	"sort"
	"strings"

	"rt.local/core-go/apperr"
)

// Meter is the scope of the metering endpoints a service key may call.
const Meter = "subscriptions.meter"

// active returns the active entitlement or nil.
func (s *Subscriptions) active(data map[string]any) map[string]any {
	e, _ := s.effective(data)
	if e != nil && s.activeEntitlement(e) {
		return e
	}
	return nil
}

// livePlan is the entitlement's plan as currently configured (else the subscribed one).
func livePlan(values map[string]any, entitlement map[string]any) map[string]any {
	plan := obj(entitlement["plan"])
	for _, p := range list(values["plans"]) {
		if obj(p)["id"] == plan["id"] {
			return obj(p)
		}
	}
	return plan
}

// rateCaps are the caps of a product of the active entitlement, from the current settings.
func (s *Subscriptions) rateCaps(data, values map[string]any, productID string) []map[string]any {
	e := s.active(data)
	if e == nil {
		return nil
	}
	var out []map[string]any
	for _, c := range list(findProduct(livePlan(values, e), productID)["rateCaps"]) {
		if m := obj(c); m != nil {
			out = append(out, m)
		}
	}
	return out
}

// rateCap is the cap of one rate ("" never matches).
func (s *Subscriptions) rateCap(data, values map[string]any, productID, rateID string) map[string]any {
	if rateID == "" {
		return nil
	}
	for _, c := range s.rateCaps(data, values, productID) {
		if c["rateId"] == rateID {
			return c
		}
	}
	return nil
}

// rateWindows is the usage of a capped rate per window of the cap (short only when the
// subscribed product has a short window), with the active holds of that rate as reserved.
func (s *Subscriptions) rateWindows(data map[string]any, productID string, cap map[string]any) []any {
	if cap == nil {
		return []any{}
	}
	e := s.active(data)
	if e == nil {
		return []any{}
	}
	product := findProduct(obj(e["plan"]), productID)
	c := obj(obj(e["counters"])[productID])
	if product == nil || c == nil {
		return []any{}
	}
	used := obj(obj(c["rates"])[jsString(cap["rateId"])])
	now, reserved := s.now(), 0.0
	for _, h := range holdsOf(data) {
		if h["productId"] == productID && h["rateId"] == cap["rateId"] && now < num(h["expiresAt"]) {
			reserved += num(h["credits"])
		}
	}
	resetAt := map[string]float64{
		"short":  num(c["shortStart"]) + numOr(product["shortSeconds"], 0)*1000,
		"day":    num(c["dayStart"]) + num(product["daySeconds"])*1000,
		"week":   num(c["weekStart"]) + num(product["weekSeconds"])*1000,
		"period": num(e["periodEnd"]),
	}
	out := []any{}
	for _, w := range CapWindows {
		if cap[w] == nil || (w == "short" && product["shortSeconds"] == nil) {
			continue
		}
		out = append(out, WindowUsage(w, numOr(used[w], 0), reserved, num(cap[w]), resetAt[w]))
	}
	return out
}

// exceededWindow is the first window a charge of credits would overflow ("" when none).
func exceededWindow(windows []any, credits float64) string {
	for _, w := range windows {
		m := obj(w)
		if num(m["used"])+num(m["reserved"])+credits > num(m["limit"]) {
			return jsString(m["kind"])
		}
	}
	return ""
}

func modelLimit(rateName, window string) error {
	return apperr.New(429, "Model limit reached: "+rateName+" "+window+" limit. Use another model or wait for the reset.")
}

// countRate counts credits used at a capped rate on every window of the product.
func (s *Subscriptions) countRate(data map[string]any, productID string, cap map[string]any, credits float64) {
	if cap == nil || !(credits > 0) {
		return
	}
	e := s.active(data)
	if e == nil {
		return
	}
	product := findProduct(obj(e["plan"]), productID)
	c := obj(obj(e["counters"])[productID])
	if product == nil || c == nil {
		return
	}
	rates := obj(c["rates"])
	if rates == nil {
		rates = map[string]any{}
		c["rates"] = rates
	}
	key := jsString(cap["rateId"])
	r := obj(rates[key])
	if r == nil {
		r = map[string]any{}
		rates[key] = r
	}
	for _, w := range CapWindows {
		if w != "short" || product["shortSeconds"] != nil {
			r[w] = numOr(r[w], 0) + credits
		}
	}
}

// addCost adds provider cost to the account: all time per currency and this period.
func (s *Subscriptions) addCost(data map[string]any, cost float64, ok bool, currency string) {
	if !ok || !(cost > 0) {
		return
	}
	e, _ := s.effective(data)
	start := e["periodStart"]
	c := obj(data["providerCost"])
	if c == nil {
		c = map[string]any{"totalMinor": map[string]any{}, "periodStart": start, "periodMinor": 0.0}
		data["providerCost"] = c
	}
	if !sameNumber(c["periodStart"], start) {
		c["periodStart"] = start
		c["periodMinor"] = 0.0
	}
	c["periodMinor"] = round4(num(c["periodMinor"]) + cost)
	total := obj(c["totalMinor"])
	if total == nil {
		total = map[string]any{}
		c["totalMinor"] = total
	}
	total[currency] = round4(numOr(total[currency], 0) + cost)
}

// sameNumber is JavaScript === for numbers or null/undefined.
func sameNumber(a, b any) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return num(a) == num(b)
}

// periodCost is the provider cost of the current entitlement period (0 when none).
func (s *Subscriptions) periodCost(data map[string]any) float64 {
	c := obj(data["providerCost"])
	e, _ := s.effective(data)
	if c != nil && sameNumber(c["periodStart"], e["periodStart"]) {
		return num(c["periodMinor"])
	}
	return 0
}

// margin is the margin rule of the active entitlement (nil without one).
func (s *Subscriptions) margin(data, values map[string]any) map[string]any {
	e := s.active(data)
	if e == nil {
		return nil
	}
	capValue := livePlan(values, e)["maxProviderCostMinor"]
	if capValue == nil {
		return nil
	}
	cap, cost := num(capValue), s.periodCost(data)
	percent := 100.0
	if cap > 0 {
		percent = math.Floor(cost * 100 / cap)
	}
	return map[string]any{
		"currency": obj(obj(values["credits"])["pack"])["currency"], "costMinor": cost, "capMinor": cap,
		"remainingMinor": round4(math.Max(0, cap-cost)), "percent": percent, "threshold": ThresholdOf(percent), "resetAt": e["periodEnd"],
	}
}

// creditSettings decodes the settings credits.
func creditSettings(values map[string]any) CreditSettings {
	var config CreditSettings
	_ = fromJSON(values["credits"], &config)
	return config
}

// degrade is a cheaper rate for the same step: among the other rates, those strictly cheaper by
// (cost, credits) that fit the available credits, their caps and the margin left; the least
// degradation (highest (cost, credits), first on ties) wins. nil when none fits.
func (s *Subscriptions) degrade(data, values map[string]any, productID string, current CreditRate, inputTokens, outputTokens, available float64, margin map[string]any) any {
	type option struct {
		rate          CreditRate
		credits, cost float64
		hasCost       bool
	}
	price := func(r CreditRate) option {
		_, credits := RateCredits(r, inputTokens, outputTokens)
		cost, ok := ProviderCost(r, inputTokens, outputTokens)
		return option{r, credits, cost, ok}
	}
	cheaper := func(a, b option) bool { return a.cost < b.cost || (a.cost == b.cost && a.credits < b.credits) }
	base := price(current)
	var best *option
	for _, r := range creditSettings(values).Rates {
		if r.ID == current.ID {
			continue
		}
		o := price(r)
		if !cheaper(o, base) || o.credits > available {
			continue
		}
		if cap := s.rateCap(data, values, productID, r.ID); cap != nil && exceededWindow(s.rateWindows(data, productID, cap), o.credits) != "" {
			continue
		}
		if margin != nil && round4(num(margin["costMinor"])+o.cost) > num(margin["capMinor"]) {
			continue
		}
		if best == nil || cheaper(*best, o) {
			b := o
			best = &b
		}
	}
	if best == nil {
		return nil
	}
	var cost any
	if best.hasCost {
		cost = best.cost
	}
	return map[string]any{"rateId": best.rate.ID, "name": best.rate.Name, "credits": best.credits, "costMinor": cost}
}

// addMoney adds source into target per currency (sign ±1), with round4 after every addition.
func addMoney(target, source map[string]any, sign float64) {
	for _, code := range mapKeys(source, nil) {
		target[code] = round4(numOr(target[code], 0) + sign*num(source[code]))
	}
}

// Economics is unit economics per user and per plan: provider cost, revenue (money paid) and
// margin per currency. limit (1..200, default 50) users with the highest cost. Never writes.
func (s *Subscriptions) Economics(ctx context.Context, limit any) (map[string]any, error) {
	if limit == nil {
		limit = 50.0
	}
	n, err := integer(limit, 1, 200)
	if err != nil {
		return nil, err
	}
	settings, err := s.Settings(ctx)
	if err != nil {
		return nil, err
	}
	values := settings["values"].(map[string]any)
	currency := jsString(obj(obj(values["credits"])["pack"])["currency"])
	totals := map[string]any{"users": 0.0, "costMinor": map[string]any{}, "revenueMinor": map[string]any{}, "marginMinor": map[string]any{}}
	plans := map[string]map[string]any{}
	var users []map[string]any
	cursor := ""
	for {
		page, err := s.store.List(ctx, "SUB_ACCOUNTS", cursor)
		if err != nil {
			return nil, err
		}
		for _, row := range page.Items {
			data := s.normalized(row.Data)
			e := s.active(data)
			cost := obj(obj(data["providerCost"])["totalMinor"])
			if cost == nil {
				cost = map[string]any{}
			}
			revenue := obj(obj(data["ledgerTotals"])["paidMinor"])
			if revenue == nil {
				revenue = map[string]any{}
			}
			if e == nil && len(cost) == 0 && len(revenue) == 0 {
				continue
			}
			margin := map[string]any{}
			addMoney(margin, revenue, 1)
			addMoney(margin, cost, -1)
			var planID, name, capMinor any
			key := "none"
			if e != nil {
				live := livePlan(values, e)
				planID, name, capMinor, key = live["id"], live["name"], live["maxProviderCostMinor"], jsString(live["id"])
			}
			users = append(users, map[string]any{
				"userId": row.SK, "planId": planID, "costMinor": cost, "revenueMinor": revenue, "marginMinor": margin,
				"periodCostMinor": s.periodCost(data), "capMinor": capMinor,
			})
			group := plans[key]
			if group == nil {
				group = map[string]any{"planId": key, "name": name, "users": 0.0, "costMinor": map[string]any{}, "revenueMinor": map[string]any{}, "marginMinor": map[string]any{}}
				plans[key] = group
			}
			for _, target := range []map[string]any{group, totals} {
				target["users"] = num(target["users"]) + 1
				addMoney(obj(target["costMinor"]), cost, 1)
				addMoney(obj(target["revenueMinor"]), revenue, 1)
				addMoney(obj(target["marginMinor"]), margin, 1)
			}
		}
		cursor = page.Cursor
		if cursor == "" {
			break
		}
	}
	sort.SliceStable(users, func(i, j int) bool {
		a, b := numOr(obj(users[i]["costMinor"])[currency], 0), numOr(obj(users[j]["costMinor"])[currency], 0)
		if a != b {
			return a > b
		}
		return strings.Compare(users[i]["userId"].(string), users[j]["userId"].(string)) < 0
	})
	if len(users) > int(n) {
		users = users[:int(n)]
	}
	keys := make([]string, 0, len(plans))
	for k := range plans {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	planList := make([]any, 0, len(keys))
	for _, k := range keys {
		planList = append(planList, plans[k])
	}
	userList := make([]any, 0, len(users))
	for _, u := range users {
		userList = append(userList, u)
	}
	return map[string]any{"asOf": s.now(), "currency": currency, "totals": totals, "plans": planList, "users": userList}, nil
}

// orNil is m, or an untyped nil (JSON null) for a nil map.
func orNil(m map[string]any) any {
	if m == nil {
		return nil
	}
	return m
}
