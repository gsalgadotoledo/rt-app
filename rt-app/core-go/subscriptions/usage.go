package subscriptions

import (
	"context"
	"math"
	"slices"

	"rt.local/core-go/apperr"
	"rt.local/core-go/internal/canonical"
	"rt.local/core-go/internal/js"
	"rt.local/core-go/nosql"
)

// Meta describes a consumption on the statement (all optional).
type Meta struct {
	Reason  string
	Kind    string
	Source  string
	ActorID string
	Details map[string]any
}

// Consume is the atomic pre-charge: the plan allowance first, then additional credits. A stable
// requestId never charges twice (the receipt then has replayed: true). 402 without an active
// entitlement, 429 when credits are insufficient.
func (s *Subscriptions) Consume(ctx context.Context, userID, productID string, credits any, requestID any, meta Meta) (map[string]any, error) {
	key, err := id(requestID)
	if err != nil {
		return nil, err
	}
	amount, err := integer(credits, 1, 1e9)
	if err != nil {
		return nil, err
	}
	return retry(func() (map[string]any, error) {
		op, err := s.store.Get(ctx, "SUB_USAGE#"+userID, key)
		if err != nil {
			return nil, err
		}
		if op != nil {
			if op.Data["productId"] != productID || op.Data["credits"] != amount {
				return nil, apperr.Conflict()
			}
			return spread(op.Data, map[string]any{"replayed": true}), nil
		}
		old, err := s.account(ctx, userID)
		if err != nil {
			return nil, err
		}
		data := s.normalized(rowData(old))
		entitlement, _ := s.effective(data)
		if !truthy(entitlement["plan"]) || entitlement["status"] != "active" || s.now() >= num(entitlement["periodEnd"]) {
			return nil, apperr.New(402, "Subscription is inactive or expired")
		}
		settings, err := s.Settings(ctx)
		if err != nil {
			return nil, err
		}
		if settings["values"].(map[string]any)["paymentRequired"] == true && entitlement["mode"] != "admin" && !js.Equal(entitlement["mode"], s.providerMode()) {
			return nil, apperr.New(402, "A paid subscription is required")
		}
		product := findProduct(obj(entitlement["plan"]), productID)
		if product == nil {
			return nil, apperr.New(403, "Product is not included in your plan")
		}
		settled := s.settle(userID, rowData(old), data)
		counter := obj(obj(entitlement["counters"])[productID])
		balance := numOr(obj(data["creditBalance"])[productID], 0)
		fromAllowance := math.Min(amount, s.allowanceLeft(data, productID))
		fromBalance := amount - fromAllowance
		if fromBalance > balance {
			window := "period"
			if num(counter["day"]) >= num(product["dailyLimit"]) {
				window = "day"
			} else if num(counter["week"]) >= num(product["weeklyLimit"]) {
				window = "week"
			}
			return nil, apperr.New(429, "Subscription "+window+" limit reached. Add credits or wait for the reset.")
		}
		creditBalance := obj(data["creditBalance"])
		if creditBalance == nil {
			creditBalance = map[string]any{}
			data["creditBalance"] = creditBalance
		}
		creditBalance[productID] = balance - fromBalance
		for _, f := range []string{"period", "day", "week"} {
			counter[f] = num(counter[f]) + fromAllowance
		}
		data["totalConsumed"] = numOr(data["totalConsumed"], 0) + amount
		at := s.now()
		receipt := map[string]any{"requestId": key, "productId": productID, "credits": amount, "fromAllowance": fromAllowance, "fromBalance": fromBalance, "at": at, "replayed": false}
		entry := map[string]any{
			"at": at, "kind": orString(meta.Kind, "usage"), "source": orString(meta.Source, "api"), "credits": -amount, "productId": productID,
			"reason": orString(meta.Reason, jsString(product["name"])+" usage"), "requestId": key, "fromAllowance": fromAllowance, "fromBalance": fromBalance,
		}
		if meta.ActorID != "" {
			entry["actorId"] = meta.ActorID
		}
		if meta.Details != nil {
			entry["details"] = meta.Details
		}
		ledger := s.ledgerEntry(userID, data, entry, "usage:"+key)
		writes := []nosql.Write{write(old, "SUB_ACCOUNTS", userID, data), write(nil, "SUB_USAGE#"+userID, key, receipt)}
		writes = append(writes, settled...)
		writes = append(writes, ledger)
		if err := s.store.Transact(ctx, writes); err != nil {
			return nil, err
		}
		return receipt, nil
	})
}

func orString(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}

// RecordOrder is the key order of the admin endpoint's input, the default order of the
// recordCredits fingerprint.
var RecordOrder = []string{"requestId", "productId", "credits", "kind", "reason", "amountMinor", "currency", "details", "source", "actorId"}

// RecordCredits records a credit (+) or debit (−) on the statement, idempotent per requestId.
// input holds requestId, productId, credits, reason and optionally kind, source, actorId,
// amountMinor, currency and details; a key that is present (even null) counts as given, like
// JavaScript `!== undefined`. order is the key order of the caller's object, which the
// fingerprint JSON.stringify({...input, kind, source}) follows (RecordOrder when omitted).
func (s *Subscriptions) RecordCredits(ctx context.Context, userID string, input map[string]any, order ...string) (map[string]any, error) {
	key, err := id(input["requestId"])
	if err != nil {
		return nil, err
	}
	productID, err := id(input["productId"])
	if err != nil {
		return nil, err
	}
	reason := js.Trim(strOf(input["reason"], ""))
	if reason == "" || js.Len(reason) > 300 {
		return nil, apperr.BadRequest("A short reason is required")
	}
	kind := input["kind"]
	if kind == nil {
		if n, present := input["credits"]; js.Number(n, present) > 0 {
			kind = "adjustment"
		} else {
			kind = "usage"
		}
	}
	if kind != "purchase" && kind != "adjustment" && kind != "grant" && kind != "usage" {
		return nil, apperr.BadRequest("Invalid entry type")
	}
	credits, ok := safeInteger(input["credits"])
	if !ok || credits == 0 || math.Abs(credits) > 1e9 {
		return nil, apperr.BadRequest("Credits must be a non-zero integer")
	}
	source := orDefault(input["source"], "api")
	if source != "system" && source != "admin" && source != "billing" && source != "user" && source != "api" {
		return nil, apperr.BadRequest("Invalid source")
	}
	money := map[string]any{}
	_, hasAmount := input["amountMinor"]
	_, hasCurrency := input["currency"]
	if hasAmount || hasCurrency {
		currency := js.ToLower(strOf(input["currency"], ""))
		amount, err := integer(input["amountMinor"], 0, 1e9)
		if err != nil {
			return nil, err
		}
		if !ValidCurrency(currency) || !ValidMinorAmount(amount, currency) {
			return nil, apperr.BadRequest(msgAmount)
		}
		money = map[string]any{"amountMinor": amount, "currency": currency}
	}
	actorID := str(input["actorId"])
	details := obj(input["details"])
	if credits < 0 {
		return s.Consume(ctx, userID, productID, -credits, key, Meta{Reason: reason, Kind: kind.(string), Source: source.(string), ActorID: actorID, Details: details})
	}
	fingerprint := canonical.SHA256Hex(stringify(recordPairs(input, kind, source, order)))
	return retry(func() (map[string]any, error) {
		prior, err := s.store.Get(ctx, "SUB_LEDGER_OP#"+userID, key)
		if err != nil {
			return nil, err
		}
		if prior != nil {
			if prior.Data["fingerprint"] != fingerprint {
				return nil, apperr.Conflict()
			}
			return spread(obj(prior.Data["result"]), map[string]any{"replayed": true}), nil
		}
		settings, err := s.Settings(ctx)
		if err != nil {
			return nil, err
		}
		if !anyPlanHasProduct(list(settings["values"].(map[string]any)["plans"]), productID) {
			return nil, apperr.NotFound("Product not found")
		}
		old, err := s.account(ctx, userID)
		if err != nil {
			return nil, err
		}
		data := s.normalized(spread(rowData(old), map[string]any{"userId": userID}))
		settled := s.settle(userID, rowData(old), data)
		balance := obj(data["creditBalance"])
		if balance == nil {
			balance = map[string]any{}
			data["creditBalance"] = balance
		}
		next, err := integer(numOr(balance[productID], 0)+credits, 0, 1e9)
		if err != nil {
			return nil, err
		}
		balance[productID] = next
		at := s.now()
		entry := spread(map[string]any{"at": at, "kind": kind, "source": source, "credits": credits, "productId": productID, "reason": reason, "requestId": key}, money)
		if truthy(input["actorId"]) {
			entry["actorId"] = input["actorId"]
		}
		if truthy(input["details"]) {
			entry["details"] = input["details"]
		}
		ledger := s.ledgerEntry(userID, data, entry, "record:"+key)
		result := map[string]any{"requestId": key, "productId": productID, "credits": credits, "available": s.available(data, productID), "at": at}
		writes := []nosql.Write{write(old, "SUB_ACCOUNTS", userID, data), write(nil, "SUB_LEDGER_OP#"+userID, key, map[string]any{"fingerprint": fingerprint, "result": result})}
		writes = append(writes, settled...)
		writes = append(writes, ledger)
		if err := s.store.Transact(ctx, writes); err != nil {
			return nil, err
		}
		return spread(result, map[string]any{"replayed": false}), nil
	})
}

// recordPairs is {...input, kind, source} in the caller's key order.
func recordPairs(input map[string]any, kind, source any, order []string) []pair {
	if len(order) == 0 {
		order = RecordOrder
	}
	keys := slices.Clone(order)
	for _, k := range mapKeys(input, order) {
		if !slices.Contains(keys, k) {
			keys = append(keys, k)
		}
	}
	for _, k := range []string{"kind", "source"} {
		if !slices.Contains(keys, k) {
			keys = append(keys, k)
		}
	}
	pairs := make([]pair, 0, len(keys))
	for _, k := range keys {
		switch k {
		case "kind":
			pairs = append(pairs, pair{k, kind})
		case "source":
			pairs = append(pairs, pair{k, source})
		default:
			pairs = append(pairs, pair{k, input[k]})
		}
	}
	return pairs
}

// Estimate prices a request ({rateId, inputTokens, outputTokens?}) with the stored credit
// settings; with userId it previews how the charge would split for that user. Never writes.
func (s *Subscriptions) Estimate(ctx context.Context, input map[string]any) (map[string]any, error) {
	settings, err := s.Settings(ctx)
	if err != nil {
		return nil, err
	}
	var config CreditSettings
	if err := fromJSON(settings["values"].(map[string]any)["credits"], &config); err != nil {
		return nil, err
	}
	rateID, _ := input["rateId"].(string)
	outputs := 0.0
	if input["outputTokens"] != nil {
		outputs = num(input["outputTokens"])
	}
	// A rate id that is not a string never matches (the lookup comes first).
	if _, ok := input["rateId"].(string); !ok {
		rateID = "\x00"
	}
	estimate, err := config.Estimate(rateID, num(input["inputTokens"]), outputs)
	if err != nil {
		return nil, err
	}
	result := obj(toJSON(estimate))
	if truthy(input["userId"]) {
		productID, err := id(orDefault(input["productId"], "api"))
		if err != nil {
			return nil, err
		}
		userID, err := id(input["userId"])
		if err != nil {
			return nil, err
		}
		row, err := s.account(ctx, userID)
		if err != nil {
			return nil, err
		}
		data := s.normalized(rowData(row))
		allowance := s.allowanceLeft(data, productID)
		balance := numOr(obj(data["creditBalance"])[productID], 0)
		credits := estimate.Credits
		fromAllowance := math.Min(credits, allowance)
		fromBalance := credits - fromAllowance
		result["account"] = map[string]any{
			"userId": input["userId"], "productId": productID, "allowanceLeft": allowance, "additionalCredits": balance,
			"available": allowance + balance, "fromAllowance": fromAllowance, "fromBalance": fromBalance,
			"allowed": fromBalance <= balance && credits > 0, "availableAfter": math.Max(0, allowance+balance-credits),
		}
	}
	return result, nil
}

// ConsumeUsage prices a model request and charges it atomically.
func (s *Subscriptions) ConsumeUsage(ctx context.Context, userID, productID string, usage map[string]any, requestID any) (map[string]any, error) {
	estimate, err := s.Estimate(ctx, usage)
	if err != nil {
		return nil, err
	}
	rate := obj(estimate["rate"])
	receipt, err := s.Consume(ctx, userID, productID, estimate["credits"], requestID, Meta{
		Reason:  jsString(rate["name"]) + " request",
		Details: map[string]any{"rateId": rate["id"], "inputTokens": estimate["inputTokens"], "outputTokens": estimate["outputTokens"]},
	})
	if err != nil {
		return nil, err
	}
	return spread(receipt, map[string]any{"valueMinor": estimate["valueMinor"], "currency": estimate["currency"]}), nil
}

// Ledger is the chronological statement of a user (one page), with the entries owed by
// closed windows as pending (first page only), totals and balances.
func (s *Subscriptions) Ledger(ctx context.Context, userID, cursor string) (map[string]any, error) {
	row, err := s.account(ctx, userID)
	if err != nil {
		return nil, err
	}
	data := s.normalized(rowData(row))
	page, err := s.store.List(ctx, Ledger(userID), cursor)
	if err != nil {
		return nil, err
	}
	pending := []any{}
	if cursor == "" {
		for _, p := range s.pendingWindows(rowData(row), data).Entries {
			pending = append(pending, spread(pendingEntry(p, "system"), map[string]any{"pending": true}))
		}
	}
	entitlement, _ := s.effective(data)
	products := productIDs(obj(entitlement["plan"]))
	for _, pid := range mapKeys(obj(data["creditBalance"]), products) {
		if !contains(products, pid) {
			products = append(products, pid)
		}
	}
	entries := make([]any, len(page.Items))
	for i, r := range page.Items {
		entries[i] = r.Data
	}
	balances := make([]any, 0, len(products))
	for _, pid := range products {
		balances = append(balances, map[string]any{"productId": pid, "allowanceLeft": s.allowanceLeft(data, pid), "additionalCredits": numOr(obj(data["creditBalance"])[pid], 0), "available": s.available(data, pid)})
	}
	var next any
	if page.Cursor != "" {
		next = page.Cursor
	}
	totals := spread(obj(toJSON(EmptyTotals())), obj(data["ledgerTotals"]), map[string]any{"consumed": numOr(data["totalConsumed"], 0)})
	return map[string]any{"entries": entries, "cursor": next, "pending": pending, "totals": totals, "balances": balances}, nil
}
