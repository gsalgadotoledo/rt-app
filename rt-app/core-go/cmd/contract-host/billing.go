package main

// Subjects: subscriptions-ledger, subscriptions-credits (mirrors spec/hosts/node/billing.mjs).
// Wire null means "not given": optional arguments take their default.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"

	"rt.local/core-go/conformance"
	"rt.local/core-go/subscriptions"
)

func init() {
	register("subscriptions-ledger", ledgerSubject)
	register("subscriptions-credits", creditsSubject)
}

// ledgerSubject is a stateless object over the ledger functions; init is ignored.
func ledgerSubject(context.Context, json.RawMessage) (conformance.Instance, error) {
	return conformance.Instance{Methods: map[string]conformance.Method{
		// emptyTotals() → totals
		"emptyTotals": func(context.Context, []json.RawMessage) (any, error) {
			return subscriptions.EmptyTotals(), nil
		},
		// LEDGER(userId) → partition key
		"LEDGER": func(_ context.Context, args []json.RawMessage) (any, error) {
			var userID string
			if err := decodeArgs(args, &userID); err != nil {
				return nil, err
			}
			return subscriptions.Ledger(userID), nil
		},
		// ledgerKey(at, seed, sequence?) → sort key
		"ledgerKey": func(_ context.Context, args []json.RawMessage) (any, error) {
			var at, sequence float64
			var seed string
			if err := decodeArgs(args, &at, &seed, &sequence); err != nil {
				return nil, err
			}
			return subscriptions.LedgerKey(at, seed, sequence), nil
		},
		// ledgerWrite(userId, entry, seed, sequence?) → {entry, write}
		"ledgerWrite": func(_ context.Context, args []json.RawMessage) (any, error) {
			var userID, seed string
			var entry subscriptions.Entry
			var sequence float64
			if err := decodeArgs(args, &userID, &entry, &seed, &sequence); err != nil {
				return nil, err
			}
			return subscriptions.LedgerWrite(userID, entry, seed, sequence)
		},
		// applyTotals(totals?, entry) → totals
		"applyTotals": func(_ context.Context, args []json.RawMessage) (any, error) {
			var totals *subscriptions.Totals
			var entry subscriptions.Entry
			if err := decodeArgs(args, &totals, &entry); err != nil {
				return nil, err
			}
			return subscriptions.ApplyTotals(totals, entry), nil
		},
		// rollover(previous?, current?, used, now) → {entries, state}
		"rollover": func(_ context.Context, args []json.RawMessage) (any, error) {
			var previous *subscriptions.WindowState
			var current *subscriptions.CurrentWindow
			var used map[string]map[string]any
			var now float64
			if err := decodeArgs(args, &previous, &current, &used, &now); err != nil {
				return nil, err
			}
			return subscriptions.Rollover(previous, current, usedFrom(used), now), nil
		},
	}}, nil
}

// usedFrom reads `used` from its wire table {productId: {"<start>": credits}}; missing
// entries are 0. Starts are rendered with JavaScript Number → String, like String(start).
func usedFrom(table map[string]map[string]any) subscriptions.UsedFunc {
	return func(productID string, start float64) float64 {
		value, _ := table[productID][subscriptions.NumberString(start)].(float64)
		return value
	}
}

// creditsSubject is built from init.credits (validated; creation fails when invalid) or the
// defaults.
func creditsSubject(_ context.Context, init json.RawMessage) (conformance.Instance, error) {
	var config struct {
		Credits json.RawMessage `json:"credits"`
	}
	if err := json.Unmarshal(init, &config); err != nil {
		return conformance.Instance{}, fmt.Errorf("init: %w", err)
	}
	settings := subscriptions.DefaultCredits()
	if config.Credits != nil && truthy(config.Credits) {
		raw, err := wire(config.Credits)
		if err != nil {
			return conformance.Instance{}, err
		}
		if settings, err = subscriptions.ValidateCredits(raw); err != nil {
			return conformance.Instance{}, err
		}
	}
	return conformance.Instance{Methods: map[string]conformance.Method{
		// defaults() → default credit settings
		"defaults": func(context.Context, []json.RawMessage) (any, error) {
			return subscriptions.DefaultCredits(), nil
		},
		// validateCredits(input) → normalized settings | 400
		"validateCredits": func(_ context.Context, args []json.RawMessage) (any, error) {
			input, err := wire(arg(args, 0))
			if err != nil {
				return nil, err
			}
			return subscriptions.ValidateCredits(input)
		},
		// estimate({rateId, inputTokens, outputTokens?}) → pricing | 404 | 400
		"estimate": func(_ context.Context, args []json.RawMessage) (any, error) {
			input, err := wire(arg(args, 0))
			if err != nil {
				return nil, err
			}
			fields, _ := input.(map[string]any)
			rateID, _ := fields["rateId"].(string)
			outputTokens := 0.0
			if fields["outputTokens"] != nil {
				outputTokens = number(fields["outputTokens"])
			}
			return settings.Estimate(rateID, number(fields["inputTokens"]), outputTokens)
		},
		// validCurrency(code) → bool
		"validCurrency": func(_ context.Context, args []json.RawMessage) (any, error) {
			input, err := wire(arg(args, 0))
			if err != nil {
				return nil, err
			}
			code, ok := input.(string)
			return ok && subscriptions.ValidCurrency(code), nil
		},
		// currencyDecimals(code) → 0 | 2 | 3
		"currencyDecimals": func(_ context.Context, args []json.RawMessage) (any, error) {
			var code *string
			if err := decodeArgs(args, &code); err != nil || code == nil {
				return nil, errors.Join(errors.New("code must be a string"), err)
			}
			return subscriptions.CurrencyDecimals(*code), nil
		},
		// validMinorAmount(amount, code) → bool
		"validMinorAmount": func(_ context.Context, args []json.RawMessage) (any, error) {
			amount, err := wire(arg(args, 0))
			if err != nil {
				return nil, err
			}
			n, ok := amount.(float64)
			if !ok {
				return false, nil // not a number: never a safe integer
			}
			var code *string
			if err := decodeArgs(args[min(1, len(args)):], &code); err != nil || code == nil {
				return nil, errors.Join(errors.New("code must be a string"), err)
			}
			return subscriptions.ValidMinorAmount(n, *code), nil
		},
	}}, nil
}

// wire decodes a raw JSON argument into a plain JSON value (float64 numbers).
func wire(raw json.RawMessage) (any, error) {
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, err
	}
	return value, nil
}

// number returns a JSON number, or NaN (never a safe integer) for anything else.
func number(v any) float64 {
	if n, ok := v.(float64); ok {
		return n
	}
	return math.NaN()
}
