package subscriptions

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"testing"

	"rt.local/core-go/apperr"
	"rt.local/core-go/nosql"
)

const t0 = 1767225600000.0 // 2026-01-01T00:00:00.000Z

type fixture struct {
	ctx   context.Context
	store *nosql.MemoryStore
	s     *Subscriptions
	now   *float64
	mail  *[]Mail
}

func newFixture(t *testing.T, paid bool) fixture {
	t.Helper()
	now := t0
	clock := func() float64 { return now }
	store := nosql.NewMemoryStore()
	var mail []Mail
	options := []Option{WithClock(clock), WithNotifier(func(_ context.Context, m Mail) error { mail = append(mail, m); return nil })}
	if paid {
		billing, err := NewLocalBilling(store, clock)
		if err != nil {
			t.Fatal(err)
		}
		options = append(options, WithProvider(billing))
	}
	return fixture{context.Background(), store, New(store, options...), &now, &mail}
}

// must returns v, failing the test (by panicking) on an error.
func must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}

func httpStatus(err error) int {
	if e, ok := apperr.As(err); ok {
		return e.Status
	}
	return 0
}

func defaultValues(t *testing.T, f fixture) map[string]any {
	settings := must(f.s.Settings(f.ctx))
	return settings["values"].(map[string]any)
}

func TestSettingsVersions(t *testing.T) {
	f := newFixture(t, false)
	values := defaultValues(t, f)
	if got := list(values["plans"])[0].(map[string]any)["version"]; got != "0.0.1" {
		t.Fatalf("default version %v", got)
	}
	plans := list(values["plans"])
	plans[1].(map[string]any)["amount"] = 2500.0
	saved := must(f.s.SaveSettings(f.ctx, map[string]any{"version": 0.0, "values": values}, "root", nil))
	pro := list(saved["values"].(map[string]any)["plans"])[1].(map[string]any)
	if saved["version"] != 1.0 || pro["version"] != "0.0.2" {
		t.Fatalf("saved %v %v", saved["version"], pro["version"])
	}
	history := must(f.store.Get(f.ctx, "SUB_PLAN_HISTORY#pro", "0.0.1"))
	if history == nil || history.Data["amount"] != 2000.0 {
		t.Fatalf("history %v", history)
	}
	if _, err := f.s.SaveSettings(f.ctx, map[string]any{"version": 0.0, "values": values}, "root", nil); !isConflict(err) {
		t.Fatalf("stale version: %v", err)
	}
	// A non-Conflict 409 is not retried and keeps its message.
	if isConflict(apperr.New(409, "Already subscribed to this plan")) {
		t.Fatal("other 409s are not conflicts")
	}
	if got := bumpVersion("0.0.9"); got != "0.0.10" {
		t.Fatalf("bump %q", got)
	}
}

func TestPlanIDFromName(t *testing.T) {
	cases := []struct{ name, want string }{
		{"  Plan Élite!! ", "plan-elite"},
		{"¡¿", "new-plan"},
		{"Ｍａｘ  Ⅱ — Ñandú ﬁ", "max-ii-nandu-fi"},
		{"Starter", "starter-2"},
	}
	for _, c := range cases {
		if got := PlanIDFromName(c.name, []string{"starter"}); got != c.want {
			t.Errorf("%q: got %q, want %q", c.name, got, c.want)
		}
	}
}

func TestChangeConsumeAndRollover(t *testing.T) {
	f := newFixture(t, false)
	alice := User{ID: "alice", Email: "alice@example.test"}
	must(f.s.Change(f.ctx, alice, "starter", "plan-1"))
	receipt := must(f.s.Consume(f.ctx, "alice", "api", 100.0, "u1", Meta{}))
	if receipt["fromAllowance"] != 100.0 {
		t.Fatalf("receipt %v", receipt)
	}
	if _, err := f.s.Consume(f.ctx, "alice", "api", 1.0, "u2", Meta{}); httpStatus(err) != 429 {
		t.Fatalf("day limit: %v", err)
	}
	replay := must(f.s.Consume(f.ctx, "alice", "api", 100.0, "u1", Meta{}))
	if replay["replayed"] != true {
		t.Fatal("replay")
	}
	*f.now = t0 + 7*day + 3600000
	ledger := must(f.s.Ledger(f.ctx, "alice", ""))
	pending := ledger["pending"].([]any)
	if len(pending) != 2 || pending[0].(map[string]any)["credits"] != -400.0 || pending[1].(map[string]any)["kind"] != "allowance" {
		t.Fatalf("pending %v", pending)
	}
	must(f.s.Consume(f.ctx, "alice", "api", 10.0, "u3", Meta{}))
	page := must(f.store.List(f.ctx, Ledger("alice"), ""))
	if len(page.Items) != 6 {
		t.Fatalf("entries %d", len(page.Items))
	}
	// Sequence numbers follow the TypeScript order: settle first, then the entry.
	if page.Items[0].SK[16:26] != "0000000001" || page.Items[1].Data["kind"] != "plan" {
		t.Fatalf("order %v %v", page.Items[0].SK, page.Items[1].Data["kind"])
	}
}

func TestFingerprints(t *testing.T) {
	sum := func(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }
	f := newFixture(t, true)
	values := defaultValues(t, f)
	values["paymentRequired"] = true
	must(f.s.SaveSettings(f.ctx, map[string]any{"version": 0.0, "values": values}, "root", nil))
	must(f.s.Change(f.ctx, User{ID: "alice"}, "pro", "pay-1"))
	op := must(f.store.Get(f.ctx, "SUB_BILLING_OP#alice", "pay-1"))
	if op.Data["fingerprint"] != sum(`{"action":"change","planId":"pro"}`) {
		t.Fatalf("billing fingerprint %v", op.Data["fingerprint"])
	}
	input := map[string]any{"requestId": "r1", "productId": "api", "credits": 5.0, "reason": "Gift", "details": map[string]any{"b": 1.0, "a": "x"}}
	must(f.s.RecordCredits(f.ctx, "bob", input, "requestId", "productId", "credits", "reason", "details"))
	record := must(f.store.Get(f.ctx, "SUB_LEDGER_OP#bob", "r1"))
	want := sum(`{"requestId":"r1","productId":"api","credits":5,"reason":"Gift","details":{"a":"x","b":1},"kind":"adjustment","source":"api"}`)
	if record.Data["fingerprint"] != want {
		t.Fatalf("record fingerprint %v", record.Data["fingerprint"])
	}
	got := stringify([]pair{{"kind", "credits"}, {"target", "api"}, {"credits", 5.0}, {"valueMinor", 0.0}, {"currency", "usd"}, {"reason", "Thanks"}, {"actorId", "root"}})
	if got != `{"kind":"credits","target":"api","credits":5,"valueMinor":0,"currency":"usd","reason":"Thanks","actorId":"root"}` {
		t.Fatalf("grant fingerprint %s", got)
	}
}

func TestOverview(t *testing.T) {
	f := newFixture(t, true)
	must(f.s.Change(f.ctx, User{ID: "alice"}, "starter", "a1"))
	values := defaultValues(t, f)
	values["paymentRequired"] = true
	must(f.s.SaveSettings(f.ctx, map[string]any{"version": 0.0, "values": values}, "root", nil))
	must(f.s.Change(f.ctx, User{ID: "bob"}, "pro", "b1"))
	overview := must(f.s.Overview(f.ctx, nil))
	if overview["customers"] != 2.0 || overview["paying"] != 1.0 || overview["mrrMinor"].(map[string]any)["usd"] != 2000.0 {
		t.Fatalf("overview %v", overview)
	}
	if len(overview["series"].([]any)) != 12 {
		t.Fatal("series")
	}
	if _, err := f.s.Overview(f.ctx, 37.0); httpStatus(err) != 400 {
		t.Fatalf("months: %v", err)
	}
}

func TestLocalBilling(t *testing.T) {
	store := nosql.NewMemoryStore()
	now := t0
	billing := must(NewLocalBilling(store, func() float64 { return now }))
	ctx := context.Background()
	customer := must(billing.Customer(ctx, User{ID: "alice"}, ""))
	plan := Plan{"id": "pro", "amount": 100.0, "currency": "usd", "periodDays": 30.0}
	first := must(billing.Change(ctx, customer, plan, "", "k1"))
	again := must(billing.Change(ctx, customer, plan, "", "k1"))
	if first["subscriptionId"] != again["subscriptionId"] {
		t.Fatal("replay")
	}
	must(billing.Change(ctx, customer, Plan{"id": "pro", "amount": 100.0, "currency": "eur", "periodDays": 30.0}, "", "k2"))
	snapshot := must(billing.Snapshot(ctx, customer, ""))
	totals := snapshot["totals"].([]any)
	if len(totals) != 2 || totals[0].(map[string]any)["currency"] != "eur" {
		t.Fatalf("totals %v", totals)
	}
	must(billing.Cancel(ctx, customer, "", ""))
	now += 31 * day
	if s := must(billing.Snapshot(ctx, customer, "")); s["status"] != "canceled" {
		t.Fatalf("status %v", s["status"])
	}
	if err := billing.Simulate(ctx, customer, "lost"); httpStatus(err) != 400 {
		t.Fatalf("simulate: %v", err)
	}
	t.Setenv("NODE_ENV", "production")
	if _, err := NewLocalBilling(store, nil); err != ErrLocalBillingInProduction {
		t.Fatal("production")
	}
}
