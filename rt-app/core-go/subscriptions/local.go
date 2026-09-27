package subscriptions

import (
	"context"
	"errors"
	"os"
	"time"

	"rt.local/core-go/apperr"
	"rt.local/core-go/nosql"
)

// LocalBilling is the explicit payment simulation (TypeScript LocalBilling): no card numbers, no
// real charges, persisted in the store (LOCAL_BILLING/<customer>, LOCAL_BILLING_OP#<customer>).
type LocalBilling struct {
	store nosql.Store
	now   func() float64
}

// ErrLocalBillingInProduction is returned by NewLocalBilling when NODE_ENV or
// RT_APP_ENVIRONMENT is "production".
var ErrLocalBillingInProduction = errors.New("Local billing cannot run in production")

// NewLocalBilling returns the simulator over store; now is the clock in epoch milliseconds
// (the system clock when nil). It refuses to run in production.
func NewLocalBilling(store nosql.Store, now func() float64) (*LocalBilling, error) {
	if os.Getenv("NODE_ENV") == "production" || os.Getenv("RT_APP_ENVIRONMENT") == "production" {
		return nil, ErrLocalBillingInProduction
	}
	if now == nil {
		now = func() float64 { return float64(time.Now().UnixMilli()) }
	}
	return &LocalBilling{store: store, now: now}, nil
}

// Mode is "local".
func (*LocalBilling) Mode() string { return "local" }

// PublishableKey is empty.
func (*LocalBilling) PublishableKey() string { return "" }

// Customer is "local_<userId>".
func (*LocalBilling) Customer(_ context.Context, user User, _ string) (string, error) {
	return "local_" + user.ID, nil
}

// Change records a paid simulated invoice once per key; a still-active period continues.
func (l *LocalBilling) Change(ctx context.Context, customer string, plan Plan, _ string, key string) (map[string]any, error) {
	existing, err := l.store.Get(ctx, "LOCAL_BILLING_OP#"+customer, key)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		return existing.Data, nil
	}
	old, err := l.store.Get(ctx, "LOCAL_BILLING", customer)
	if err != nil {
		return nil, err
	}
	now := l.now()
	oldData := rowData(old)
	continuing := oldData["status"] == "active" && num(oldData["periodEnd"]) > now
	invoice := map[string]any{"id": "sim_" + key, "number": "SIMULATION", "status": "paid", "amountPaid": plan["amount"], "amountDue": 0.0, "currency": plan["currency"], "createdAt": now}
	result := map[string]any{"subscriptionId": "sub_" + customer, "status": "active", "clientSecret": nil}
	periodStart, periodEnd := any(now), any(now+num(plan["periodDays"])*day)
	if continuing {
		periodStart, periodEnd = oldData["periodStart"], oldData["periodEnd"]
	}
	invoices := append([]any{invoice}, list(oldData["invoices"])...)
	data := spread(oldData, result, map[string]any{
		"priceId": orDefault(plan["stripePriceId"], plan["id"]), "plan": plan, "periodStart": periodStart, "periodEnd": periodEnd,
		"invoices": invoices, "paymentMethods": []any{map[string]any{"brand": "simulation", "last4": "0000"}}, "cancelAtPeriodEnd": false,
	})
	err = l.store.Transact(ctx, []nosql.Write{write(old, "LOCAL_BILLING", customer, data), write(nil, "LOCAL_BILLING_OP#"+customer, key, result)})
	if err != nil {
		return nil, err
	}
	return result, nil
}

// Setup returns {simulated: true}.
func (*LocalBilling) Setup(context.Context, string, string) (map[string]any, error) {
	return map[string]any{"simulated": true}, nil
}

// SetPaymentMethod does nothing.
func (*LocalBilling) SetPaymentMethod(context.Context, string, string, string) error { return nil }

// Cancel marks the simulated subscription to end with its period (404 "No subscription").
func (l *LocalBilling) Cancel(ctx context.Context, customer, _, _ string) (map[string]any, error) {
	old, err := l.store.Get(ctx, "LOCAL_BILLING", customer)
	if err != nil {
		return nil, err
	}
	if old == nil {
		return nil, apperr.NotFound("No subscription")
	}
	if err := l.store.Transact(ctx, []nosql.Write{write(old, old.PK, old.SK, spread(old.Data, map[string]any{"cancelAtPeriodEnd": true}))}); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true}, nil
}

// Snapshot returns the simulated subscription with invoice totals per currency (in invoice
// order); a canceling subscription past its period is "canceled".
func (l *LocalBilling) Snapshot(ctx context.Context, customer, _ string) (map[string]any, error) {
	row, err := l.store.Get(ctx, "LOCAL_BILLING", customer)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return map[string]any{"invoices": []any{}, "paymentMethods": []any{}, "totals": []any{}}, nil
	}
	data := cloneMap(row.Data)
	var order []string
	totals := map[string]map[string]any{}
	for _, item := range list(data["invoices"]) {
		invoice := obj(item)
		currency := jsString(invoice["currency"])
		t, ok := totals[currency]
		if !ok {
			t = map[string]any{"currency": currency, "paid": 0.0, "due": 0.0}
			totals[currency] = t
			order = append(order, currency)
		}
		t["paid"] = num(t["paid"]) + num(invoice["amountPaid"])
		t["due"] = num(t["due"]) + num(invoice["amountDue"])
	}
	if truthy(data["cancelAtPeriodEnd"]) && l.now() >= num(data["periodEnd"]) {
		data["status"] = "canceled"
	}
	out := make([]any, 0, len(order))
	for _, currency := range jsKeys(order, order) {
		out = append(out, totals[currency])
	}
	data["simulated"] = true
	data["totals"] = out
	return data, nil
}

// Verify always fails: the simulation does not accept webhooks.
func (*LocalBilling) Verify(string, string) (Event, error) {
	return Event{}, errors.New("Local simulation does not accept Stripe webhooks")
}

// Simulate sets the simulated status: active, past_due or canceled.
func (l *LocalBilling) Simulate(ctx context.Context, customer, status string) error {
	if status != "active" && status != "past_due" && status != "canceled" {
		return apperr.BadRequest("Invalid simulated state")
	}
	row, err := l.store.Get(ctx, "LOCAL_BILLING", customer)
	if err != nil {
		return err
	}
	if row == nil {
		return apperr.NotFound("No simulated subscription")
	}
	return l.store.Transact(ctx, []nosql.Write{write(row, row.PK, row.SK, spread(row.Data, map[string]any{"status": status}))})
}
