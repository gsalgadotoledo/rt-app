package subscriptions

// Credit reservations (port of reservations.ts and the reservation methods of index.ts): a
// reservation holds credits of one product until it is settled (the real usage is charged),
// released, or expires. Holds live on the account row (`reservations`, an array in creation
// order: Go maps lose key order) and as receipts SUB_RESERVATION#<userId>/<key>; every change is
// a ledger entry in the same transaction. Contract:
// spec/contracts/subscriptions-reservations.contract.yaml; design:
// docs/polyglot/subscriptions-reservations.md.

import (
	"context"
	"math"
	"regexp"

	"rt.local/core-go/apperr"
	"rt.local/core-go/internal/js"
	"rt.local/core-go/nosql"
)

// Reservation limits.
const (
	// ReservationTTL is the default hold time in milliseconds (15 minutes).
	ReservationTTL = 15 * 60000.0
	// MinReservationTTL and MaxReservationTTL bound ttlMs (1 s to 24 h).
	MinReservationTTL = 1000.0
	MaxReservationTTL = 86400000.0
	// MaxActiveReservations bounds the account row and the release transaction.
	MaxActiveReservations = 25
)

// Ledger entry kinds of reservations.
const (
	KindReservation Kind = "reservation" // credits held for a call (0 credits; held > 0)
	KindSettlement  Kind = "settlement"  // real usage of a reservation charged; its hold removed
	KindRelease     Kind = "release"     // hold removed without a charge (released or expired)
)

// ReservationMeta says who acts: Source "user" (personal endpoints: only the user's own
// reservations) or "api" (the default); ActorID is recorded on the entries.
type ReservationMeta struct {
	Source  string
	ActorID string
}

var reservationKeyPattern = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,128}$`)

// Reservations is the row partition of reservation receipts.
func Reservations(userID string) string { return "SUB_RESERVATION#" + userID }

// ReservationKey checks a key: letters, digits and `_ - . :`, 1 to 128 characters.
func ReservationKey(v any) (string, error) {
	s, ok := v.(string)
	if !ok || !reservationKeyPattern.MatchString(s) {
		return "", apperr.BadRequest("Invalid reservation key")
	}
	return s, nil
}

// reservationTTL is ttlMs ?? 15 min, a safe integer between 1 s and 24 h.
func reservationTTL(v any) (float64, error) {
	if v == nil {
		return ReservationTTL, nil
	}
	n, ok := safeInteger(v)
	if !ok || n < MinReservationTTL || n > MaxReservationTTL {
		return 0, apperr.BadRequest("Invalid reservation TTL")
	}
	return n, nil
}

// reservationReason is the optional statement text: String(v).trim(), 1 to 300 UTF-16 units.
func reservationReason(v any) (string, bool, error) {
	if v == nil {
		return "", false, nil
	}
	reason := js.Trim(jsString(v))
	if reason == "" || js.Len(reason) > 300 {
		return "", false, apperr.BadRequest("A short reason is required")
	}
	return reason, true, nil
}

// ThresholdOf is the highest threshold a usage percentage reached: 0, 80, 95 or 100.
func ThresholdOf(percent float64) float64 {
	switch {
	case percent >= 100:
		return 100
	case percent >= 95:
		return 95
	case percent >= 80:
		return 80
	}
	return 0
}

// WindowUsage is one usage window with the part of the holds on the plan allowance:
// percent = floor((used + reserved) * 100 / limit), 100 when the limit is 0.
func WindowUsage(kind string, used, reserved, limit, resetAt float64) map[string]any {
	percent := 100.0
	if limit > 0 {
		percent = math.Floor((used + reserved) * 100 / limit)
	}
	return map[string]any{
		"kind": kind, "used": used, "reserved": reserved, "limit": limit, "remaining": math.Max(0, limit-used-reserved),
		"percent": percent, "threshold": ThresholdOf(percent), "resetAt": resetAt,
	}
}

// settleUsage normalizes settle usage: {credits} or {inputTokens, outputTokens}.
func settleUsage(usage map[string]any) (map[string]any, error) {
	integer := func(v any, high float64) (float64, error) {
		n, ok := safeInteger(v)
		if !ok || n < 0 || n > high {
			return 0, apperr.BadRequest(msgNumeric)
		}
		return n, nil
	}
	if usage["credits"] != nil {
		n, err := integer(usage["credits"], 1e9)
		if err != nil {
			return nil, err
		}
		return map[string]any{"credits": n}, nil
	}
	if usage["inputTokens"] != nil {
		in, err := integer(usage["inputTokens"], 1e10)
		if err != nil {
			return nil, err
		}
		out := 0.0
		if usage["outputTokens"] != nil {
			if out, err = integer(usage["outputTokens"], 1e10); err != nil {
				return nil, err
			}
		}
		return map[string]any{"inputTokens": in, "outputTokens": out}, nil
	}
	return nil, apperr.BadRequest("Give credits or token usage")
}

// sameUsage reports a replay of the same settle usage.
func sameUsage(a, b map[string]any) bool {
	for _, f := range []string{"credits", "inputTokens", "outputTokens"} {
		if !js.Equal(a[f], b[f]) {
			return false
		}
	}
	return true
}

// holdsOf returns the account's holds (nil when there are none).
func holdsOf(data map[string]any) []map[string]any {
	var out []map[string]any
	for _, h := range list(data["reservations"]) {
		if m := obj(h); m != nil {
			out = append(out, m)
		}
	}
	return out
}

// setHolds writes the holds back as a JSON array ([] when empty, never null).
func setHolds(data map[string]any, holds []map[string]any) {
	out := make([]any, len(holds))
	for i, h := range holds {
		out[i] = h
	}
	data["reservations"] = out
}

// held is the credits of the active (unexpired) holds of a product.
func (s *Subscriptions) held(data map[string]any, productID string) float64 {
	now, total := s.now(), 0.0
	for _, h := range holdsOf(data) {
		if h["productId"] == productID && now < num(h["expiresAt"]) {
			total += num(h["credits"])
		}
	}
	return total
}

// freeCredits is what a new charge can use, net of active holds.
type freeCredits struct {
	allowance, balance, held, rawAllowance, rawBalance float64
}

// free: spendable = max(0, allowance + balance − held), taken from the plan allowance first.
// Holds never push a charge onto additional credits (which do not expire) while the allowance
// can pay it and every hold stays covered.
func (s *Subscriptions) free(data map[string]any, productID string) freeCredits {
	allowance := s.allowanceLeft(data, productID)
	balance := numOr(obj(data["creditBalance"])[productID], 0)
	held := s.held(data, productID)
	spendable := math.Max(0, allowance+balance-held)
	fromAllowance := math.Min(allowance, spendable)
	return freeCredits{allowance: fromAllowance, balance: spendable - fromAllowance, held: held, rawAllowance: allowance, rawBalance: balance}
}

// blocked says why the account cannot be charged for a product now: "inactive", "payment",
// "product" (skipped when productID is ""), or "".
func (s *Subscriptions) blocked(data map[string]any, productID string, paymentRequired bool) string {
	e, _ := s.effective(data)
	if !s.activeEntitlement(e) {
		return "inactive"
	}
	if paymentRequired && e["mode"] != "admin" && !js.Equal(e["mode"], s.providerMode()) {
		return "payment"
	}
	if productID != "" && findProduct(obj(e["plan"]), productID) == nil {
		return "product"
	}
	return ""
}

// paymentRequired reads the settings flag.
func (s *Subscriptions) paymentRequired(ctx context.Context) (bool, error) {
	settings, err := s.Settings(ctx)
	if err != nil {
		return false, err
	}
	return settings["values"].(map[string]any)["paymentRequired"] == true, nil
}

// chargeable returns the entitlement and product a charge uses: 402 inactive or unpaid, 403
// when the plan lacks the product.
func (s *Subscriptions) chargeable(ctx context.Context, data map[string]any, productID string) (map[string]any, map[string]any, error) {
	required, err := s.paymentRequired(ctx)
	if err != nil {
		return nil, nil, err
	}
	switch s.blocked(data, productID, required) {
	case "inactive":
		return nil, nil, apperr.New(402, "Subscription is inactive or expired")
	case "payment":
		return nil, nil, apperr.New(402, "A paid subscription is required")
	case "product":
		return nil, nil, apperr.New(403, "Product is not included in your plan")
	}
	e, _ := s.effective(data)
	return e, findProduct(obj(e["plan"]), productID), nil
}

// reservationAmount is the credits of {credits} or {estimate} (priced at its maximum).
type reservationAmount struct {
	credits  float64
	estimate map[string]any
	rateName string
}

func (s *Subscriptions) amountOf(ctx context.Context, input map[string]any) (reservationAmount, error) {
	credits, estimate := input["credits"], input["estimate"]
	_, isObject := estimate.(map[string]any)
	if (credits != nil) == (estimate != nil) || (estimate != nil && !isObject) {
		return reservationAmount{}, apperr.BadRequest("Give credits or an estimate")
	}
	if credits != nil {
		n, err := integer(credits, 1, 1e9)
		return reservationAmount{credits: n}, err
	}
	e := obj(estimate)
	output := e["maxOutputTokens"]
	if output == nil {
		output = 0.0
	}
	priced, err := s.Estimate(ctx, map[string]any{"rateId": e["rateId"], "inputTokens": e["inputTokens"], "outputTokens": output})
	if err != nil {
		return reservationAmount{}, err
	}
	rate := obj(priced["rate"])
	return reservationAmount{
		credits:  num(priced["credits"]),
		estimate: map[string]any{"rateId": rate["id"], "inputTokens": priced["inputTokens"], "maxOutputTokens": priced["outputTokens"]},
		rateName: jsString(rate["name"]),
	}, nil
}

// sweepHolds records the release of expired holds: a "release" entry at expiresAt (source
// system) and the receipt marked "expired". It mutates data; the receipt of skip is left to
// the caller, which writes that row itself.
func (s *Subscriptions) sweepHolds(ctx context.Context, userID string, data map[string]any, skip string) ([]nosql.Write, error) {
	now := s.now()
	var kept, expired []map[string]any
	for _, h := range holdsOf(data) {
		if now >= num(h["expiresAt"]) {
			expired = append(expired, h)
		} else {
			kept = append(kept, h)
		}
	}
	if len(expired) == 0 {
		return nil, nil
	}
	setHolds(data, kept)
	var writes []nosql.Write
	for _, h := range expired {
		key := jsString(h["key"])
		row, err := s.store.Get(ctx, Reservations(userID), key)
		if err != nil {
			return nil, err
		}
		if row != nil && key != skip && row.Data["status"] == "active" {
			r := row
			writes = append(writes, write(r, row.PK, row.SK, spread(row.Data, map[string]any{"status": "expired", "releasedAt": h["expiresAt"]})))
		}
		reason := key
		if row != nil && row.Data["reason"] != nil {
			reason = jsString(row.Data["reason"])
		}
		writes = append(writes, s.ledgerEntry(userID, data, map[string]any{
			"at": h["expiresAt"], "kind": string(KindRelease), "source": string(SourceSystem), "credits": 0.0, "productId": h["productId"],
			"reason": "Reservation expired · " + reason, "requestId": key, "held": -num(h["credits"]),
		}, "expire:"+key))
	}
	return writes, nil
}

// reservationView is what Reserve returns; an active receipt past its TTL reads as "expired".
func (s *Subscriptions) reservationView(record map[string]any, replayed bool) map[string]any {
	status := record["status"]
	if status == "active" && s.now() >= num(record["expiresAt"]) {
		status = "expired"
	}
	return map[string]any{
		"key": record["key"], "productId": record["productId"], "credits": record["credits"], "status": status,
		"at": record["at"], "expiresAt": record["expiresAt"], "available": record["available"], "replayed": replayed,
	}
}

// Reserve holds credits for a call before running it: input {key, credits | estimate:
// {rateId, inputTokens, maxOutputTokens}, ttlMs?, reason?}. Nothing is charged until Settle,
// Release or expiresAt (ttlMs, default 15 minutes). Idempotent per key (same product and
// amount: replayed; else 409). Fails like Consume (402, 403) and with 429 when the credits do
// not fit or 25 reservations are active.
func (s *Subscriptions) Reserve(ctx context.Context, userID string, productID any, input map[string]any, meta ReservationMeta) (map[string]any, error) {
	key, err := ReservationKey(input["key"])
	if err != nil {
		return nil, err
	}
	product, err := id(productID)
	if err != nil {
		return nil, err
	}
	amount, err := s.amountOf(ctx, input)
	if err != nil {
		return nil, err
	}
	ttl, err := reservationTTL(input["ttlMs"])
	if err != nil {
		return nil, err
	}
	reason, hasReason, err := reservationReason(input["reason"])
	if err != nil {
		return nil, err
	}
	source := orString(meta.Source, string(SourceAPI))
	return retry(func() (map[string]any, error) {
		prior, err := s.store.Get(ctx, Reservations(userID), key)
		if err != nil {
			return nil, err
		}
		if prior != nil {
			if prior.Data["productId"] != product || num(prior.Data["credits"]) != amount.credits {
				return nil, apperr.New(409, "Reservation key already used with different amounts")
			}
			return s.reservationView(prior.Data, true), nil
		}
		old, err := s.account(ctx, userID)
		if err != nil {
			return nil, err
		}
		data := s.normalized(rowData(old))
		_, plan, err := s.chargeable(ctx, data, product)
		if err != nil {
			return nil, err
		}
		settled := s.settle(userID, rowData(old), data)
		swept, err := s.sweepHolds(ctx, userID, data, "")
		if err != nil {
			return nil, err
		}
		holds := holdsOf(data)
		if len(holds) >= MaxActiveReservations {
			return nil, apperr.New(429, "Too many active reservations")
		}
		available := s.available(data, product)
		if amount.credits > available {
			return nil, apperr.New(429, "Not enough credits: "+NumberString(amount.credits-available)+" missing. Add credits or wait for the reset.")
		}
		settings, err := s.Settings(ctx)
		if err != nil {
			return nil, err
		}
		cap := s.rateCap(data, settings["values"].(map[string]any), product, str(amount.estimate["rateId"]))
		if cap != nil {
			if w := exceededWindow(s.rateWindows(data, product, cap), amount.credits); w != "" {
				return nil, modelLimit(amount.rateName, w)
			}
		}
		at := s.now()
		hold := map[string]any{"key": key, "productId": product, "credits": amount.credits, "at": at, "expiresAt": at + ttl}
		if cap != nil {
			hold["rateId"] = cap["rateId"]
		}
		setHolds(data, append(holds, hold))
		text := reason
		if !hasReason {
			if amount.estimate != nil {
				text = amount.rateName + " request"
			} else {
				text = jsString(plan["name"]) + " usage"
			}
		}
		entry := map[string]any{
			"at": at, "kind": string(KindReservation), "source": source, "credits": 0.0, "productId": product,
			"reason": "Reserved · " + text, "requestId": key, "held": amount.credits, "expiresAt": at + ttl,
		}
		if meta.ActorID != "" {
			entry["actorId"] = meta.ActorID
		}
		ledger := s.ledgerEntry(userID, data, entry, "reserve:"+key)
		record := spread(hold, map[string]any{"status": "active", "available": s.available(data, product), "reason": text, "source": source})
		if meta.ActorID != "" {
			record["actorId"] = meta.ActorID
		}
		if amount.estimate != nil {
			record["estimate"] = amount.estimate
		}
		writes := []nosql.Write{write(old, "SUB_ACCOUNTS", userID, data), write(nil, Reservations(userID), key, record)}
		writes = append(append(append(writes, settled...), swept...), ledger)
		if err := s.store.Transact(ctx, writes); err != nil {
			return nil, err
		}
		return s.reservationView(record, false), nil
	})
}

// reservationRow reads a receipt: 404 when missing or, for source "user", made by another source.
func (s *Subscriptions) reservationRow(ctx context.Context, userID, key string, meta ReservationMeta) (*nosql.Row, error) {
	row, err := s.store.Get(ctx, Reservations(userID), key)
	if err != nil {
		return nil, err
	}
	if row == nil || (meta.Source == string(SourceUser) && row.Data["source"] != string(SourceUser)) {
		return nil, apperr.NotFound("Reservation not found")
	}
	return row, nil
}

// Settle charges the real usage of a reservation and removes its hold (the rest is never
// charged). usage is {credits} or {inputTokens, outputTokens} priced with the reserved rate; an
// expired reservation is settled too. Usage the account cannot cover is returned as uncovered
// and never charged. Idempotent per key (same usage: replayed; else 409); 409 once released;
// 404 for an unknown key.
func (s *Subscriptions) Settle(ctx context.Context, userID string, key any, usage map[string]any, meta ReservationMeta) (map[string]any, error) {
	k, err := ReservationKey(key)
	if err != nil {
		return nil, err
	}
	reported, err := settleUsage(usage)
	if err != nil {
		return nil, err
	}
	return retry(func() (map[string]any, error) {
		row, err := s.reservationRow(ctx, userID, k, meta)
		if err != nil {
			return nil, err
		}
		record := row.Data
		switch record["status"] {
		case "settled":
			settlement := obj(record["settlement"])
			if !sameUsage(obj(settlement["usage"]), reported) {
				return nil, apperr.New(409, "Reservation already settled with different usage")
			}
			return spread(settlement, map[string]any{"replayed": true}), nil
		case "released":
			return nil, apperr.New(409, "Reservation was released")
		}
		_, byCredits := reported["credits"]
		estimate := obj(record["estimate"])
		if !byCredits && estimate == nil {
			return nil, apperr.BadRequest("Settle this reservation with credits")
		}
		settings, err := s.Settings(ctx)
		if err != nil {
			return nil, err
		}
		var priced map[string]any
		used := num(reported["credits"])
		if !byCredits {
			if priced, err = s.Estimate(ctx, map[string]any{"rateId": estimate["rateId"], "inputTokens": reported["inputTokens"], "outputTokens": reported["outputTokens"]}); err != nil {
				return nil, err
			}
			used = num(priced["credits"])
		}
		old, err := s.account(ctx, userID)
		if err != nil {
			return nil, err
		}
		data := s.normalized(rowData(old))
		settled := s.settle(userID, rowData(old), data)
		swept, err := s.sweepHolds(ctx, userID, data, k)
		if err != nil {
			return nil, err
		}
		var hold map[string]any
		var others []map[string]any
		for _, h := range holdsOf(data) {
			if hold == nil && h["key"] == k {
				hold = h
			} else {
				others = append(others, h)
			}
		}
		if hold != nil {
			setHolds(data, others)
		}
		// Charge like Consume (allowance first) from what the other holds leave free.
		productID := jsString(record["productId"])
		free := s.free(data, productID)
		fromAllowance := math.Min(used, free.allowance)
		fromBalance := math.Min(used-fromAllowance, free.balance)
		charged := fromAllowance + fromBalance
		uncovered := used - charged
		if fromAllowance > 0 {
			e, _ := s.effective(data)
			counter := obj(obj(e["counters"])[productID])
			for _, f := range []string{"period", "day", "week"} {
				counter[f] = num(counter[f]) + fromAllowance
			}
			if p := findProduct(obj(e["plan"]), productID); p != nil && p["shortSeconds"] != nil {
				counter["short"] = num(counter["short"]) + fromAllowance
			}
		}
		values := settings["values"].(map[string]any)
		// Model caps count what was used (uncovered included); provider cost is the full usage.
		s.countRate(data, productID, s.rateCap(data, values, productID, str(estimate["rateId"])), used)
		cost, hasCost := 0.0, false
		if priced != nil {
			var r CreditRate
			if err := fromJSON(priced["rate"], &r); err != nil {
				return nil, err
			}
			cost, hasCost = ProviderCost(r, num(priced["inputTokens"]), num(priced["outputTokens"]))
		}
		balances := obj(data["creditBalance"])
		if balances == nil {
			balances = map[string]any{}
			data["creditBalance"] = balances
		}
		balances[productID] = free.rawBalance - fromBalance
		data["totalConsumed"] = numOr(data["totalConsumed"], 0) + charged
		at := s.now()
		pack := obj(obj(values["credits"])["pack"])
		s.addCost(data, cost, hasCost, jsString(pack["currency"]))
		details := map[string]any{"reserved": record["credits"], "used": used, "uncovered": uncovered}
		if priced != nil {
			details["rateId"] = obj(priced["rate"])["id"]
			details["inputTokens"] = priced["inputTokens"]
			details["outputTokens"] = priced["outputTokens"]
		}
		if hasCost {
			details["costMinor"] = cost
		}
		heldChange := 0.0
		if hold != nil {
			heldChange = -num(hold["credits"])
		}
		credits := 0.0 // never -0: JSON would print "-0"
		if charged > 0 {
			credits = -charged
		}
		entry := map[string]any{
			"at": at, "kind": string(KindSettlement), "source": orString(meta.Source, string(SourceAPI)), "credits": credits, "productId": productID,
			"reason": record["reason"], "requestId": k, "fromAllowance": fromAllowance, "fromBalance": fromBalance, "held": heldChange, "details": details,
		}
		if meta.ActorID != "" {
			entry["actorId"] = meta.ActorID
		}
		ledger := s.ledgerEntry(userID, data, entry, "settle:"+k)
		settlement := map[string]any{
			"key": k, "productId": productID, "reserved": record["credits"], "used": used, "credits": charged, "fromAllowance": fromAllowance,
			"fromBalance": fromBalance, "uncovered": uncovered, "expired": hold == nil, "status": "settled", "at": at,
			"available":  s.available(data, productID),
			"valueMinor": jsRound(charged * num(pack["amountMinor"]) / num(pack["credits"])), "currency": pack["currency"], "usage": reported,
		}
		if hasCost {
			settlement["costMinor"] = cost
		}
		writes := []nosql.Write{write(old, "SUB_ACCOUNTS", userID, data), write(row, row.PK, row.SK, spread(record, map[string]any{"status": "settled", "settlement": settlement}))}
		writes = append(append(append(writes, settled...), swept...), ledger)
		if err := s.store.Transact(ctx, writes); err != nil {
			return nil, err
		}
		return spread(settlement, map[string]any{"replayed": false}), nil
	})
}

// releaseView is what Release returns.
func releaseView(record map[string]any, replayed bool) map[string]any {
	return map[string]any{
		"key": record["key"], "productId": record["productId"], "credits": record["credits"], "status": record["status"],
		"releasedAt": record["releasedAt"], "replayed": replayed,
	}
}

// Release removes a reservation's hold without charging it. Idempotent (released or expired:
// replayed); 409 once settled; 404 for an unknown key. An active receipt past its TTL is
// recorded as "expired".
func (s *Subscriptions) Release(ctx context.Context, userID string, key any, meta ReservationMeta) (map[string]any, error) {
	k, err := ReservationKey(key)
	if err != nil {
		return nil, err
	}
	return retry(func() (map[string]any, error) {
		row, err := s.reservationRow(ctx, userID, k, meta)
		if err != nil {
			return nil, err
		}
		record := row.Data
		if record["status"] == "settled" {
			return nil, apperr.New(409, "Reservation already settled")
		}
		if record["status"] != "active" {
			return releaseView(record, true), nil
		}
		old, err := s.account(ctx, userID)
		if err != nil {
			return nil, err
		}
		data := s.normalized(rowData(old))
		writes := s.settle(userID, rowData(old), data)
		swept, err := s.sweepHolds(ctx, userID, data, k)
		if err != nil {
			return nil, err
		}
		writes = append(writes, swept...)
		var hold map[string]any
		var others []map[string]any
		for _, h := range holdsOf(data) {
			if hold == nil && h["key"] == k {
				hold = h
			} else {
				others = append(others, h)
			}
		}
		var next map[string]any
		if hold != nil {
			setHolds(data, others)
			at := s.now()
			entry := map[string]any{
				"at": at, "kind": string(KindRelease), "source": orString(meta.Source, string(SourceAPI)), "credits": 0.0, "productId": record["productId"],
				"reason": "Released · " + jsString(record["reason"]), "requestId": k, "held": -num(hold["credits"]),
			}
			if meta.ActorID != "" {
				entry["actorId"] = meta.ActorID
			}
			writes = append(writes, s.ledgerEntry(userID, data, entry, "release:"+k))
			next = spread(record, map[string]any{"status": "released", "releasedAt": at})
		} else {
			next = spread(record, map[string]any{"status": "expired", "releasedAt": record["expiresAt"]})
		}
		all := append([]nosql.Write{write(old, "SUB_ACCOUNTS", userID, data), write(row, row.PK, row.SK, next)}, writes...)
		if err := s.store.Transact(ctx, all); err != nil {
			return nil, err
		}
		return releaseView(next, false), nil
	})
}

// usageWindows is the day, week and period usage of a product, holds included ([] without an
// active entitlement that has the product).
func (s *Subscriptions) usageWindows(data map[string]any, productID string) []any {
	e, _ := s.effective(data)
	if !s.activeEntitlement(e) {
		return []any{}
	}
	product := findProduct(obj(e["plan"]), productID)
	c := obj(obj(e["counters"])[productID])
	if product == nil || c == nil {
		return []any{}
	}
	// Holds sit on the allowance first: that part counts on every window once settled.
	reserved := math.Min(s.held(data, productID), s.allowanceLeft(data, productID))
	var out []any
	if product["shortSeconds"] != nil {
		out = append(out, WindowUsage("short", num(c["short"]), reserved, num(product["shortLimit"]), num(c["shortStart"])+num(product["shortSeconds"])*1000))
	}
	return append(out,
		WindowUsage("day", num(c["day"]), reserved, num(product["dailyLimit"]), num(c["dayStart"])+num(product["daySeconds"])*1000),
		WindowUsage("week", num(c["week"]), reserved, num(product["weeklyLimit"]), num(c["weekStart"])+num(product["weekSeconds"])*1000),
		WindowUsage("period", num(c["period"]), reserved, num(product["credits"]), num(e["periodEnd"])),
	)
}

// Preflight says whether {credits} or {estimate} fits in what the user can spend now, what is
// missing, the window usage and a top-up offer priced with the credit pack. Never writes.
func (s *Subscriptions) Preflight(ctx context.Context, userID string, productID any, input map[string]any) (map[string]any, error) {
	product, err := id(productID)
	if err != nil {
		return nil, err
	}
	amount, err := s.amountOf(ctx, input)
	if err != nil {
		return nil, err
	}
	settings, err := s.Settings(ctx)
	if err != nil {
		return nil, err
	}
	values := settings["values"].(map[string]any)
	row, err := s.account(ctx, userID)
	if err != nil {
		return nil, err
	}
	data := s.normalized(rowData(row))
	blocked := s.blocked(data, product, values["paymentRequired"] == true)
	free := s.free(data, product)
	available := 0.0
	if blocked == "" {
		available = free.allowance + free.balance
	}
	missing := math.Max(0, amount.credits-available)
	var cap map[string]any
	if blocked == "" {
		cap = s.rateCap(data, values, product, str(amount.estimate["rateId"]))
	}
	models := s.rateWindows(data, product, cap)
	capped := ""
	if cap != nil {
		capped = exceededWindow(models, amount.credits)
	}
	fits := blocked == "" && missing == 0 && capped == ""
	var reason, topUp any
	if !fits {
		switch {
		case blocked != "":
			reason = blocked
		case missing > 0:
			reason = "credits"
		default:
			reason = "model"
		}
	}
	var rate *CreditRate
	if amount.estimate != nil {
		for _, r := range creditSettings(values).Rates {
			if r.ID == str(amount.estimate["rateId"]) {
				rate = &r
				break
			}
		}
	}
	var costMinor any
	step, hasStep := 0.0, false
	if rate != nil {
		if step, hasStep = ProviderCost(*rate, num(amount.estimate["inputTokens"]), num(amount.estimate["maxOutputTokens"])); hasStep {
			costMinor = step
		}
	}
	var margin map[string]any
	if blocked == "" {
		margin = s.margin(data, values)
	}
	exceeded := margin != nil && round4(num(margin["costMinor"])+step) > num(margin["capMinor"])
	var model, marginView, degrade any
	if cap != nil {
		var over any
		if capped != "" {
			over = capped
		}
		model = map[string]any{"rateId": cap["rateId"], "windows": models, "exceeded": over}
	}
	if margin != nil {
		marginView = spread(margin, map[string]any{"stepMinor": step, "exceeded": exceeded})
	}
	if rate != nil && blocked == "" && (missing > 0 || capped != "" || exceeded) {
		degrade = s.degrade(data, values, product, *rate, num(amount.estimate["inputTokens"]), num(amount.estimate["maxOutputTokens"]), available, margin)
	}
	if blocked == "" && missing > 0 {
		pack := obj(obj(values["credits"])["pack"])
		packs := math.Ceil(missing / num(pack["credits"]))
		topUp = map[string]any{
			"credits": missing, "packs": packs, "amountMinor": packs * num(pack["amountMinor"]),
			"valueMinor": jsRound(missing * num(pack["amountMinor"]) / num(pack["credits"])), "currency": pack["currency"],
		}
	}
	return map[string]any{
		"productId": product, "credits": amount.credits, "fits": fits, "reason": reason, "available": available, "missing": missing,
		"allowanceLeft": free.rawAllowance, "additionalCredits": free.rawBalance, "reserved": free.held,
		"windows": s.usageWindows(data, product), "topUp": topUp,
		"costMinor": costMinor, "model": model, "margin": marginView, "degrade": degrade,
	}, nil
}

// UsageSummary reports usage against limits for each product of the user (the effective plan's,
// then other additional-credit balances): windows with thresholds, active reservations,
// alerts for windows at 80 % or more and the credit pack. Never writes.
func (s *Subscriptions) UsageSummary(ctx context.Context, userID string) (map[string]any, error) {
	settings, err := s.Settings(ctx)
	if err != nil {
		return nil, err
	}
	values := settings["values"].(map[string]any)
	row, err := s.account(ctx, userID)
	if err != nil {
		return nil, err
	}
	data := s.normalized(rowData(row))
	e, _ := s.effective(data)
	plan := obj(e["plan"])
	products := productIDs(plan)
	for _, pid := range mapKeys(obj(data["creditBalance"]), products) {
		if !contains(products, pid) {
			products = append(products, pid)
		}
	}
	items, alerts := []any{}, []any{}
	for _, pid := range products {
		free := s.free(data, pid)
		windows := s.usageWindows(data, pid)
		threshold := 0.0
		for _, w := range windows {
			window := obj(w)
			threshold = math.Max(threshold, num(window["threshold"]))
			if num(window["threshold"]) >= 80 {
				alerts = append(alerts, map[string]any{"productId": pid, "window": window["kind"], "percent": window["percent"], "threshold": window["threshold"]})
			}
		}
		var models []any
		rates := creditSettings(values).Rates
		for _, cap := range s.rateCaps(data, values, pid) {
			var rateName any
			for _, r := range rates {
				if r.ID == cap["rateId"] {
					rateName = r.Name
					break
				}
			}
			modelWindows := s.rateWindows(data, pid, cap)
			for _, w := range modelWindows {
				window := obj(w)
				if num(window["threshold"]) >= 80 {
					alerts = append(alerts, map[string]any{"productId": pid, "window": window["kind"], "percent": window["percent"], "threshold": window["threshold"], "rateId": cap["rateId"]})
				}
			}
			models = append(models, map[string]any{"rateId": cap["rateId"], "name": rateName, "windows": modelWindows})
		}
		var name any
		if p := findProduct(plan, pid); p != nil {
			name = p["name"]
		}
		item := map[string]any{
			"productId": pid, "name": name, "allowanceLeft": free.rawAllowance, "additionalCredits": free.rawBalance,
			"reserved": free.held, "available": free.allowance + free.balance, "threshold": threshold, "windows": windows,
		}
		if len(models) > 0 {
			item["models"] = models
		}
		items = append(items, item)
	}
	reservations := []any{}
	now := s.now()
	for _, h := range holdsOf(data) {
		if now < num(h["expiresAt"]) {
			reservations = append(reservations, map[string]any{"key": h["key"], "productId": h["productId"], "credits": h["credits"], "at": h["at"], "expiresAt": h["expiresAt"]})
		}
	}
	return map[string]any{
		"userId": userID, "active": s.blocked(data, "", values["paymentRequired"] == true) == "", "products": items,
		"reservations": reservations, "alerts": alerts, "pack": obj(values["credits"])["pack"],
		"margin": orNil(s.margin(data, values)),
	}, nil
}

// reservationBody picks the documented fields of a reservation request body.
func reservationBody(body map[string]any) map[string]any {
	return map[string]any{"key": body["key"], "credits": body["credits"], "estimate": body["estimate"], "ttlMs": body["ttlMs"], "reason": body["reason"]}
}

// amountBody picks {credits, estimate}.
func amountBody(body map[string]any) map[string]any {
	return map[string]any{"credits": body["credits"], "estimate": body["estimate"]}
}

// usageBody picks {credits, inputTokens, outputTokens}.
func usageBody(body map[string]any) map[string]any {
	return map[string]any{"credits": body["credits"], "inputTokens": body["inputTokens"], "outputTokens": body["outputTokens"]}
}
