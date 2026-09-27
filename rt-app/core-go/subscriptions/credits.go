package subscriptions

import (
	"bytes"
	"encoding/json"
	"math"
	"regexp"
	"strings"

	"rt.local/core-go/apperr"
)

// Validation messages (status 400 unless noted).
const (
	msgCurrency  = "Invalid currency"
	msgNumeric   = "Invalid numeric setting"
	msgAmount    = "Invalid amount for currency"
	msgRateCount = "Use at most 50 credit rates"
	msgID        = "Invalid identifier"
	msgRate      = "Invalid credit rate"
	msgRates     = "Duplicate or unnamed credit rates"
	msgNoRate    = "Credit rate not found" // 404
)

// Pack is the price of a top-up pack; it is also the money value of one credit
// (AmountMinor / Credits).
type Pack struct {
	Credits     float64 `json:"credits"`
	AmountMinor float64 `json:"amountMinor"`
	Currency    string  `json:"currency"`
}

// CreditRate is what one model or function charges; decimals are allowed (0.25 credits per
// 1k tokens). Minimum is charged per request.
type CreditRate struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	InputPer1k  float64 `json:"inputPer1k"`
	OutputPer1k float64 `json:"outputPer1k"`
	Minimum     float64 `json:"minimum"`
	// CostInputPer1k and CostOutputPer1k are what the provider charges, in minor units of the
	// pack currency per 1k tokens (nil when the rate has no costs; both set when either is).
	CostInputPer1k  *float64 `json:"costInputPer1k,omitempty"`
	CostOutputPer1k *float64 `json:"costOutputPer1k,omitempty"`
}

type creditRateFields CreditRate

// MarshalJSON writes Name with a lone UTF-16 surrogate as \uXXXX, like JSON.stringify: a name
// cut to 80 code units can end in half a surrogate pair.
func (r CreditRate) MarshalJSON() ([]byte, error) {
	raw, err := json.Marshal(creditRateFields(r))
	if err != nil || !strings.Contains(r.Name, "\xED") {
		return raw, err
	}
	plain, err := json.Marshal(r.Name)
	if err != nil {
		return nil, err
	}
	name, err := marshalString(r.Name)
	if err != nil {
		return nil, err
	}
	return bytes.Replace(raw, append([]byte(`"name":`), plain...), append([]byte(`"name":`), name...), 1), nil
}

// CreditSettings are the credit pack and the rates.
type CreditSettings struct {
	Pack  Pack         `json:"pack"`
	Rates []CreditRate `json:"rates"`
}

// DefaultCredits returns the default settings (a fresh copy).
func DefaultCredits() CreditSettings {
	return CreditSettings{
		Pack: Pack{Credits: 1000, AmountMinor: 1000, Currency: "usd"},
		Rates: []CreditRate{
			{ID: "standard", Name: "Standard model", InputPer1k: 1, OutputPer1k: 3, Minimum: 1},
			{ID: "advanced", Name: "Advanced model", InputPer1k: 5, OutputPer1k: 15, Minimum: 1},
		},
	}
}

var identifier = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,100}$`)

// ValidateCredits validates raw credit settings (a decoded JSON value: map[string]any,
// []any, float64, string, bool or nil) and returns them normalized; unknown fields are
// dropped. Checks run in this order, each failing with a 400 *apperr.HTTPError:
//
//  1. pack.currency, lowercased, is in the catalog: "Invalid currency"
//  2. pack.amountMinor is a safe integer 0..1e9: "Invalid numeric setting";
//     and valid for the currency: "Invalid amount for currency"
//  3. rates is a list of at most 50: "Use at most 50 credit rates"
//  4. per rate, in order: id ^[a-zA-Z0-9_-]{1,100}$ ("Invalid identifier"); name is String(name),
//     trimmed and cut to 80 UTF-16 code units; inputPer1k and outputPer1k are numbers
//     0..1e6 with at most 4 decimals ("Invalid credit rate"); minimum (default 0) is a safe
//     integer 0..1e9 ("Invalid numeric setting")
//  5. no empty name and no repeated id: "Duplicate or unnamed credit rates"
//  6. pack.credits is a safe integer 1..1e9: "Invalid numeric setting"
func ValidateCredits(input any) (CreditSettings, error) {
	pack := field(input, "pack")
	currency := strings.ToLower(jsString(orDefault(field(pack, "currency"), "")))
	if !ValidCurrency(currency) {
		return CreditSettings{}, apperr.BadRequest(msgCurrency)
	}
	amountMinor, err := integer(field(pack, "amountMinor"), 0, 1e9)
	if err != nil {
		return CreditSettings{}, err
	}
	if !ValidMinorAmount(amountMinor, currency) {
		return CreditSettings{}, apperr.BadRequest(msgAmount)
	}
	list, ok := field(input, "rates").([]any)
	if !ok || len(list) > 50 {
		return CreditSettings{}, apperr.BadRequest(msgRateCount)
	}
	rates := make([]CreditRate, 0, len(list))
	for _, raw := range list {
		r, err := validateRate(raw)
		if err != nil {
			return CreditSettings{}, err
		}
		rates = append(rates, r)
	}
	seen := make(map[string]bool, len(rates))
	for _, r := range rates {
		if r.Name == "" || seen[r.ID] {
			return CreditSettings{}, apperr.BadRequest(msgRates)
		}
		seen[r.ID] = true
	}
	credits, err := integer(field(pack, "credits"), 1, 1e9)
	if err != nil {
		return CreditSettings{}, err
	}
	return CreditSettings{Pack: Pack{Credits: credits, AmountMinor: amountMinor, Currency: currency}, Rates: rates}, nil
}

// validateRate checks one rate's fields in declaration order.
func validateRate(raw any) (CreditRate, error) {
	id, ok := field(raw, "id").(string)
	if !ok || !identifier.MatchString(id) {
		return CreditRate{}, apperr.BadRequest(msgID)
	}
	name := cutUTF16(strings.TrimFunc(jsString(orDefault(field(raw, "name"), "")), jsSpace), 80)
	input, err := rate(field(raw, "inputPer1k"))
	if err != nil {
		return CreditRate{}, err
	}
	output, err := rate(field(raw, "outputPer1k"))
	if err != nil {
		return CreditRate{}, err
	}
	minimum, err := integer(orDefault(field(raw, "minimum"), 0.0), 0, 1e9)
	if err != nil {
		return CreditRate{}, err
	}
	r := CreditRate{ID: id, Name: name, InputPer1k: input, OutputPer1k: output, Minimum: minimum}
	if field(raw, "costInputPer1k") != nil || field(raw, "costOutputPer1k") != nil {
		in, err := rate(orDefault(field(raw, "costInputPer1k"), 0.0))
		if err != nil {
			return CreditRate{}, err
		}
		out, err := rate(orDefault(field(raw, "costOutputPer1k"), 0.0))
		if err != nil {
			return CreditRate{}, err
		}
		r.CostInputPer1k, r.CostOutputPer1k = &in, &out
	}
	return r, nil
}

// rate accepts a number 0..1e6 with at most 4 decimals. The decimal check tolerates float64
// noise: 0.57 * 1e4 is 5699.999999999999, and 0.57 is a valid rate; 0.12345 is not.
func rate(v any) (float64, error) {
	n, ok := v.(float64)
	if !ok || math.IsNaN(n) || math.IsInf(n, 0) || n < 0 || n > 1e6 || math.Abs(n*1e4-jsRound(n*1e4)) > 1e-6 {
		return 0, apperr.BadRequest(msgRate)
	}
	return n, nil
}

// integer accepts a safe integer min..max.
func integer(v any, low, high float64) (float64, error) {
	n, ok := safeInteger(v)
	if !ok || n < low || n > high {
		return 0, apperr.BadRequest(msgNumeric)
	}
	return n, nil
}

// field is JavaScript value?.[name] for a decoded JSON value (nil when v is not an object).
func field(v any, name string) any {
	if m, ok := v.(map[string]any); ok {
		return m[name]
	}
	return nil
}

// orDefault is JavaScript v ?? fallback.
func orDefault(v, fallback any) any {
	if v == nil {
		return fallback
	}
	return v
}

// Estimate is the price of a model request.
type Estimate struct {
	Rate         CreditRate `json:"rate"`
	InputTokens  float64    `json:"inputTokens"`
	OutputTokens float64    `json:"outputTokens"`
	// ExactCredits is the unrounded price, at 4 decimals.
	ExactCredits float64 `json:"exactCredits"`
	// Credits is what the request charges: whole credits, at least the rate's minimum.
	Credits float64 `json:"credits"`
	// ValueMinor is the money value of Credits at the pack price, in minor units of Currency.
	ValueMinor float64 `json:"valueMinor"`
	Currency   string  `json:"currency"`
}

// Estimate prices a request with rate rateID. The rate is looked up first (404 "Credit rate
// not found"); then both token counts must be safe integers 0..1e10 (400 "Invalid numeric
// setting"; pass NaN for a missing or non-numeric count and 0 for an omitted output count).
//
//	exact = (inputTokens/1000)*inputPer1k + (outputTokens/1000)*outputPer1k
//	credits = max(minimum, ceil(round(exact*1e6)/1e6))
//	valueMinor = round(credits*pack.amountMinor/pack.credits)
//
// round is JavaScript Math.round (halves up), so 27.5 minor units charge 28.
//
// Example: standard rate (1 and 3 per 1k), 1000 input and 500 output tokens →
// exactCredits 2.5, credits 3, valueMinor 3 with the default pack.
func (c CreditSettings) Estimate(rateID string, inputTokens, outputTokens float64) (Estimate, error) {
	var selected *CreditRate
	for i := range c.Rates {
		if c.Rates[i].ID == rateID {
			selected = &c.Rates[i]
			break
		}
	}
	if selected == nil {
		return Estimate{}, apperr.NotFound(msgNoRate)
	}
	for _, tokens := range []float64{inputTokens, outputTokens} {
		if _, err := integer(tokens, 0, 1e10); err != nil {
			return Estimate{}, err
		}
	}
	// Round up to whole credits (tolerating float noise) and apply the per-request minimum.
	exact, credits := RateCredits(*selected, inputTokens, outputTokens)
	return Estimate{
		Rate:         *selected,
		InputTokens:  inputTokens,
		OutputTokens: outputTokens,
		ExactCredits: jsRound(exact*1e4) / 1e4,
		Credits:      credits,
		ValueMinor:   jsRound(credits * c.Pack.AmountMinor / c.Pack.Credits),
		Currency:     c.Pack.Currency,
	}, nil
}

// RateCredits prices token usage at a rate: exact = (in/1000)*inputPer1k + (out/1000)*outputPer1k,
// credits = max(minimum, ceil(round(exact*1e6)/1e6)).
func RateCredits(r CreditRate, inputTokens, outputTokens float64) (exact, credits float64) {
	exact = (inputTokens/1000)*r.InputPer1k + (outputTokens/1000)*r.OutputPer1k
	return exact, math.Max(r.Minimum, math.Ceil(jsRound(exact*1e6)/1e6))
}

// round4 is Math.round(x*1e4)/1e4 without negative zero.
func round4(x float64) float64 {
	return jsRound(x*1e4)/1e4 + 0
}

// ProviderCost is the provider cost of token usage at a rate (minor units, 4 decimals); ok is
// false when the rate has no costs.
func ProviderCost(r CreditRate, inputTokens, outputTokens float64) (cost float64, ok bool) {
	if r.CostInputPer1k == nil {
		return 0, false
	}
	out := 0.0
	if r.CostOutputPer1k != nil {
		out = *r.CostOutputPer1k
	}
	return round4((inputTokens/1000)*(*r.CostInputPer1k) + (outputTokens/1000)*out), true
}
