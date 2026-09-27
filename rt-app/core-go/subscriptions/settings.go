package subscriptions

import (
	"errors"
	"regexp"
	"strconv"
	"strings"

	"golang.org/x/text/unicode/norm"

	"rt.local/core-go/apperr"
	"rt.local/core-go/internal/js"
)

// Plan is a plan snapshot as stored: {id, family, name, description, metadata, amount,
// currency, periodDays, enabled, archived, stripePriceId?, stripeProductId?, stripeManaged,
// version, products: [{id, name, credits, dailyLimit, weeklyLimit, daySeconds, weekSeconds}]}.
type Plan = map[string]any

// Defaults returns a fresh copy of the default settings (the TypeScript `defaults`): no payment
// requirement, notifications on, 3 reminder days, the default credits and the Starter, Pro and
// Max plans.
func Defaults() map[string]any {
	product := func(credits, daily, weekly float64) map[string]any {
		return map[string]any{"id": "api", "name": "API credits", "credits": credits, "dailyLimit": daily, "weeklyLimit": weekly, "daySeconds": 86400.0, "weekSeconds": 604800.0}
	}
	return map[string]any{
		"paymentRequired": false,
		"notifications":   true,
		"reminderDays":    3.0,
		"credits":         toJSON(DefaultCredits()),
		"plans": []any{
			map[string]any{"id": "starter", "name": "Starter", "amount": 0.0, "currency": "usd", "periodDays": 30.0, "enabled": true, "products": []any{product(1000, 100, 500)}},
			map[string]any{"id": "pro", "name": "Pro", "amount": 2000.0, "currency": "usd", "periodDays": 30.0, "enabled": true, "products": []any{product(10000, 1000, 5000)}},
			map[string]any{"id": "max", "family": "max", "version": "0.0.1", "name": "Max", "description": "For growing teams with higher usage", "amount": 5000.0, "currency": "usd", "periodDays": 30.0, "enabled": true, "products": []any{product(50000, 5000, 25000)}},
		},
	}
}

var (
	metadataKey = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,40}$`)
	reserved    = []string{"B_version", "State", "family", "rtAppPlanId", "rtAppCatalog"}
)

// typeError is the JavaScript TypeError of reading a property of null (a 500, not a 400).
var typeError = errors.New("Cannot read properties of null")

func validateMetadata(value any) (map[string]any, error) {
	m, ok := value.(map[string]any)
	if !truthy(value) || !ok || len(m) > 20 {
		return nil, apperr.BadRequest("Use at most 20 metadata entries")
	}
	out := map[string]any{}
	for key, item := range m {
		s, isString := item.(string)
		if !metadataKey.MatchString(key) || !isString || js.Len(s) > 500 || contains(reserved, key) {
			return nil, apperr.BadRequest("Invalid or reserved metadata key")
		}
		out[key] = s
	}
	return out, nil
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// validateSettings normalizes the settings values (see the subscriptions-settings contract
// for the rules and their order).
func validateSettings(input any) (map[string]any, error) {
	in := obj(input)
	if _, ok := in["paymentRequired"].(bool); !ok {
		return nil, apperr.BadRequest("Invalid subscription settings")
	}
	if _, ok := in["notifications"].(bool); !ok {
		return nil, apperr.BadRequest("Invalid subscription settings")
	}
	raw, ok := in["plans"].([]any)
	if !ok || len(raw) < 1 || len(raw) > 20 {
		return nil, apperr.BadRequest("Invalid subscription settings")
	}
	plans := make([]any, 0, len(raw))
	for _, item := range raw {
		plan, err := validatePlan(item)
		if err != nil {
			return nil, err
		}
		plans = append(plans, plan)
	}
	ids, prices := map[string]bool{}, map[string]bool{}
	priced := 0
	bad := false
	for _, item := range plans {
		p := item.(map[string]any)
		if ids[p["id"].(string)] {
			bad = true
		}
		ids[p["id"].(string)] = true
		if price, has := p["stripePriceId"].(string); has {
			priced++
			prices[price] = true
		}
		if p["name"] == "" || !ValidMinorAmount(num(p["amount"]), p["currency"].(string)) {
			bad = true
		}
		products := map[string]bool{}
		for _, x := range p["products"].([]any) {
			product := x.(map[string]any)
			if products[product["id"].(string)] || product["name"] == "" {
				bad = true
			}
			products[product["id"].(string)] = true
		}
	}
	if bad || len(prices) != priced {
		return nil, apperr.BadRequest("Duplicate or unnamed plans/products")
	}
	reminderDays, err := integer(in["reminderDays"], 0, 30)
	if err != nil {
		return nil, err
	}
	credits := in["credits"]
	if credits == nil {
		credits = Defaults()["credits"]
	}
	validated, err := ValidateCredits(credits)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"paymentRequired": in["paymentRequired"],
		"notifications":   in["notifications"],
		"reminderDays":    reminderDays,
		"plans":           plans,
		"credits":         toJSON(validated),
	}, nil
}

func validatePlan(item any) (map[string]any, error) {
	if item == nil {
		return nil, typeError
	}
	p := obj(item)
	planID, err := id(p["id"])
	if err != nil {
		return nil, err
	}
	family, err := id(orDefault(p["family"], p["id"]))
	if err != nil {
		return nil, err
	}
	description := cutUTF16(strOf(p["description"], ""), 500)
	metadata, err := validateMetadata(orDefault(p["metadata"], map[string]any{}))
	if err != nil {
		return nil, err
	}
	name := cutUTF16(strOf(p["name"], ""), 80)
	amount, err := integer(p["amount"], 0, 1e9)
	if err != nil {
		return nil, err
	}
	currency, ok := p["currency"].(string)
	if !ok || !ValidCurrency(currency) {
		return nil, apperr.BadRequest(msgCurrency)
	}
	periodDays, err := integer(p["periodDays"], 1, 366)
	if err != nil {
		return nil, err
	}
	out := map[string]any{
		"id": planID, "family": family, "description": description, "metadata": metadata, "name": name,
		"amount": amount, "currency": currency, "periodDays": periodDays,
		"enabled": p["enabled"] == true && p["archived"] != true, "archived": p["archived"] == true,
	}
	if truthy(p["stripePriceId"]) {
		price, err := id(p["stripePriceId"])
		if err != nil {
			return nil, err
		}
		out["stripePriceId"] = price
	}
	raw, ok := p["products"].([]any)
	if !ok || len(raw) == 0 || len(raw) > 20 {
		return nil, apperr.BadRequest("A plan needs products")
	}
	products := make([]any, 0, len(raw))
	for _, x := range raw {
		if x == nil {
			return nil, typeError
		}
		product, err := validateProduct(obj(x))
		if err != nil {
			return nil, err
		}
		products = append(products, product)
	}
	out["products"] = products
	return out, nil
}

func validateProduct(x map[string]any) (map[string]any, error) {
	productID, err := id(x["id"])
	if err != nil {
		return nil, err
	}
	out := map[string]any{"id": productID, "name": cutUTF16(strOf(x["name"], ""), 80)}
	for _, f := range []struct {
		name      string
		low, high float64
	}{{"credits", 0, 1e9}, {"dailyLimit", 0, 1e9}, {"weeklyLimit", 0, 1e9}, {"daySeconds", 60, 86400 * 31}, {"weekSeconds", 60, 86400 * 366}} {
		n, err := integer(x[f.name], f.low, f.high)
		if err != nil {
			return nil, err
		}
		out[f.name] = n
	}
	return out, nil
}

// planContent is what makes a new plan version when it changes.
func planContent(p map[string]any) map[string]any {
	return map[string]any{
		"id": p["id"], "family": orDefault(p["family"], p["id"]), "name": p["name"],
		"description": orDefault(p["description"], ""), "amount": p["amount"], "currency": p["currency"],
		"periodDays": p["periodDays"], "products": p["products"], "metadata": orDefault(p["metadata"], map[string]any{}),
	}
}

var lastNumber = regexp.MustCompile(`(\d+)$`)

// bumpVersion increments the trailing number: "0.0.9" → "0.0.10".
func bumpVersion(version string) string {
	return lastNumber.ReplaceAllStringFunc(version, func(n string) string {
		f, _ := strconv.ParseFloat(n, 64)
		return NumberString(f + 1)
	})
}

var (
	nonAlnum = regexp.MustCompile(`[^a-z0-9]+`)
	marks    = regexp.MustCompile(`[\x{0300}-\x{036f}]`)
)

// PlanIDFromName returns a stable, URL-safe id for a new plan: NFKD, combining marks removed,
// JavaScript lowercase, runs of other characters as "-", at most 80 characters, "new-plan"
// when empty, and "-2", "-3"… to avoid existing ids.
func PlanIDFromName(name string, existing []string) string {
	base := js.ToLower(marks.ReplaceAllString(norm.NFKD.String(name), ""))
	base = nonAlnum.ReplaceAllString(base, "-")
	base = strings.TrimPrefix(base, "-")
	base = strings.TrimSuffix(base, "-")
	if len(base) > 80 {
		base = base[:80]
	}
	base = strings.TrimSuffix(base, "-")
	if base == "" {
		base = "new-plan"
	}
	ids := map[string]bool{}
	for _, e := range existing {
		ids[e] = true
	}
	value := base
	for suffix := 2; ids[value]; suffix++ {
		value = base + "-" + strconv.Itoa(suffix)
	}
	return value
}
