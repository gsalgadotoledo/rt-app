package subscriptions

import (
	"context"
	"fmt"
	"math/rand"
	"reflect"
	"strings"
	"sync"
	"testing"

	"rt.local/core-go/apperr"
	"rt.local/core-go/nosql"
	"rt.local/core-go/web"
)

var alice = User{ID: "alice", Email: "alice@example.test"}

// failing is a memory store whose next transactions fail before or after committing.
type failing struct {
	*nosql.MemoryStore
	mu       sync.Mutex
	failures []string
	writes   int
}

func (f *failing) Transact(ctx context.Context, writes []nosql.Write) error {
	f.mu.Lock()
	f.writes++
	mode := ""
	if len(f.failures) > 0 {
		mode, f.failures = f.failures[0], f.failures[1:]
	}
	f.mu.Unlock()
	if mode == "before" {
		return apperr.New(503, "Injected store failure")
	}
	if err := f.MemoryStore.Transact(ctx, writes); err != nil {
		return err
	}
	if mode == "after" {
		return apperr.New(503, "Injected store failure")
	}
	return nil
}

func newReservations(t *testing.T) (*Subscriptions, *failing, *float64) {
	t.Helper()
	now := t0
	store := &failing{MemoryStore: nosql.NewMemoryStore()}
	return New(store, WithClock(func() float64 { return now })), store, &now
}

// checkLedger asserts the statement invariants and returns the entries and the account.
func checkLedger(t *testing.T, store nosql.Store, userID string) ([]map[string]any, map[string]any) {
	t.Helper()
	ctx := context.Background()
	var entries []map[string]any
	cursor := ""
	for {
		page := must(store.List(ctx, "SUB_LEDGER#"+userID, cursor))
		for _, r := range page.Items {
			entries = append(entries, r.Data)
		}
		if cursor = page.Cursor; cursor == "" {
			break
		}
	}
	account := rowData(must(store.Get(ctx, "SUB_ACCOUNTS", userID)))
	windows := obj(account["ledgerWindows"])
	counters := obj(account["counters"])
	if strings.HasPrefix(str(windows["key"]), "admin:") {
		counters = obj(obj(account["adminGrant"])["counters"])
	}
	credits, held, reserved, allowance, additional := 0.0, 0.0, 0.0, 0.0, 0.0
	for _, e := range entries {
		credits += num(e["credits"])
		held += numOr(e["held"], 0)
		if v, ok := e["available"].(float64); ok && v < 0 {
			t.Fatalf("negative available in %v", e)
		}
	}
	for _, h := range holdsOf(account) {
		reserved += num(h["credits"])
	}
	for id, w := range obj(windows["products"]) {
		window, counter := obj(w), obj(counters[id])
		used := 0.0
		if counter != nil && num(counter["weekStart"]) == num(window["start"]) {
			used = num(counter["week"])
		}
		allowance += num(window["allowance"]) - used
	}
	for _, v := range obj(account["creditBalance"]) {
		if num(v) < 0 {
			t.Fatalf("negative balance %v", v)
		}
		additional += num(v)
	}
	if credits != allowance+additional || held != reserved {
		t.Fatalf("ledger %v != allowance %v + additional %v, or held %v != reserved %v", credits, allowance, additional, held, reserved)
	}
	return entries, account
}

func TestReservationHelpers(t *testing.T) {
	if k, err := ReservationKey("turn-1:0.a_b"); err != nil || k != "turn-1:0.a_b" {
		t.Fatal(k, err)
	}
	for _, bad := range []any{"", "bad key", strings.Repeat("x", 129), 5.0, nil} {
		if _, err := ReservationKey(bad); err == nil {
			t.Fatalf("key %v accepted", bad)
		}
	}
	if ttl, _ := reservationTTL(nil); ttl != ReservationTTL {
		t.Fatal(ttl)
	}
	for _, bad := range []any{999.0, 86400001.0, 1000.5, "1000", true} {
		if _, err := reservationTTL(bad); err == nil {
			t.Fatalf("ttl %v accepted", bad)
		}
	}
	if r, ok, _ := reservationReason(" Chat "); !ok || r != "Chat" {
		t.Fatal(r)
	}
	for _, bad := range []any{" ", strings.Repeat("r", 301)} {
		if _, _, err := reservationReason(bad); err == nil {
			t.Fatal("reason accepted")
		}
	}
	got := []float64{}
	for _, p := range []float64{0, 79, 80, 94, 95, 99, 100, 250} {
		got = append(got, ThresholdOf(p))
	}
	if !reflect.DeepEqual(got, []float64{0, 0, 80, 80, 95, 95, 100, 100}) {
		t.Fatal(got)
	}
	if w := WindowUsage("day", 60, 25, 100, 9); w["percent"] != 85.0 || w["threshold"] != 80.0 || w["remaining"] != 15.0 {
		t.Fatal(w)
	}
	if w := WindowUsage("week", 0, 0, 0, 1); w["percent"] != 100.0 {
		t.Fatal(w)
	}
	if u, _ := settleUsage(map[string]any{"inputTokens": 5.0}); !reflect.DeepEqual(u, map[string]any{"inputTokens": 5.0, "outputTokens": 0.0}) {
		t.Fatal(u)
	}
	for _, bad := range []map[string]any{{}, {"outputTokens": 1.0}, {"credits": -1.0}, {"inputTokens": 1.0, "outputTokens": 1.5}, {"inputTokens": "1"}} {
		if _, err := settleUsage(bad); err == nil {
			t.Fatalf("usage %v accepted", bad)
		}
	}
	if !sameUsage(map[string]any{"credits": 1.0}, map[string]any{"credits": 1.0}) || sameUsage(map[string]any{"credits": 1.0}, map[string]any{"inputTokens": 1.0, "outputTokens": 0.0}) {
		t.Fatal("sameUsage")
	}
}

func TestReserveSettleRelease(t *testing.T) {
	s, store, _ := newReservations(t)
	ctx := context.Background()
	if _, err := s.Reserve(ctx, "alice", "api", map[string]any{"key": "t:1", "credits": 1.0}, ReservationMeta{}); httpStatus(err) != 402 {
		t.Fatal(err)
	}
	must(s.Change(ctx, alice, "starter", "plan"))
	reserved := must(s.Reserve(ctx, "alice", "api", map[string]any{"key": "turn-1:0", "estimate": map[string]any{"rateId": "standard", "inputTokens": 12000.0, "maxOutputTokens": 8000.0}}, ReservationMeta{}))
	if reserved["credits"] != 36.0 || reserved["available"] != 64.0 || reserved["expiresAt"] != t0+ReservationTTL {
		t.Fatal(reserved)
	}
	if _, err := s.Consume(ctx, "alice", "api", 65.0, "u1", Meta{}); httpStatus(err) != 429 {
		t.Fatal(err)
	}
	must(s.Consume(ctx, "alice", "api", 64.0, "u1", Meta{}))
	settled := must(s.Settle(ctx, "alice", "turn-1:0", map[string]any{"inputTokens": 12000.0, "outputTokens": 2000.0}, ReservationMeta{}))
	if settled["used"] != 18.0 || settled["credits"] != 18.0 || settled["available"] != 18.0 {
		t.Fatal(settled)
	}
	replay := must(s.Settle(ctx, "alice", "turn-1:0", map[string]any{"inputTokens": 12000.0, "outputTokens": 2000.0}, ReservationMeta{}))
	if replay["replayed"] != true || replay["at"] != settled["at"] {
		t.Fatal(replay)
	}
	for _, err := range []error{
		second(s.Settle(ctx, "alice", "turn-1:0", map[string]any{"credits": 18.0}, ReservationMeta{})),
		second(s.Release(ctx, "alice", "turn-1:0", ReservationMeta{})),
		second(s.Reserve(ctx, "alice", "api", map[string]any{"key": "turn-1:0", "credits": 35.0}, ReservationMeta{})),
	} {
		if httpStatus(err) != 409 {
			t.Fatal(err)
		}
	}
	must(s.Reserve(ctx, "alice", "api", map[string]any{"key": "r1", "credits": 5.0, "reason": "Batch"}, ReservationMeta{}))
	if r := must(s.Release(ctx, "alice", "r1", ReservationMeta{})); r["status"] != "released" {
		t.Fatal(r)
	}
	if r := must(s.Release(ctx, "alice", "r1", ReservationMeta{})); r["replayed"] != true {
		t.Fatal(r)
	}
	if _, err := s.Settle(ctx, "alice", "r1", map[string]any{"credits": 1.0}, ReservationMeta{}); httpStatus(err) != 409 {
		t.Fatal(err)
	}
	must(s.Reserve(ctx, "alice", "api", map[string]any{"key": "r2", "credits": 5.0}, ReservationMeta{}))
	if _, err := s.Settle(ctx, "alice", "r2", map[string]any{"inputTokens": 1.0}, ReservationMeta{}); httpStatus(err) != 400 {
		t.Fatal(err)
	}
	must(s.Settle(ctx, "alice", "r2", map[string]any{"credits": 0.0}, ReservationMeta{}))
	entries, _ := checkLedger(t, store, "alice")
	raw := must(store.Get(ctx, "SUB_LEDGER#alice", str(entries[len(entries)-1]["id"])))
	if text := fmt.Sprint(raw.Data["credits"]); text != "0" {
		t.Fatalf("settlement credits %s", text)
	}
}

func second[T any](_ T, err error) error { return err }

func TestReservationValidationAndPreflight(t *testing.T) {
	s, _, _ := newReservations(t)
	ctx := context.Background()
	cases := []struct {
		input   map[string]any
		product any
		status  int
	}{
		{map[string]any{"key": "bad key", "credits": 1.0}, "api", 400},
		{map[string]any{"key": "k", "credits": 1.0}, "bad id", 400},
		{map[string]any{"key": "k"}, "api", 400},
		{map[string]any{"key": "k", "credits": 1.0, "estimate": map[string]any{}}, "api", 400},
		{map[string]any{"key": "k", "estimate": 5.0}, "api", 400},
		{map[string]any{"key": "k", "credits": 0.0}, "api", 400},
		{map[string]any{"key": "k", "estimate": map[string]any{"rateId": "nope", "inputTokens": 1.0}}, "api", 404},
		{map[string]any{"key": "k", "credits": 1.0, "ttlMs": 5.0}, "api", 400},
		{map[string]any{"key": "k", "credits": 1.0, "reason": " "}, "api", 400},
	}
	for _, c := range cases {
		if _, err := s.Reserve(ctx, "alice", c.product, c.input, ReservationMeta{}); httpStatus(err) != c.status {
			t.Fatalf("%v: %v", c.input, err)
		}
	}
	if p := must(s.Preflight(ctx, "alice", "api", map[string]any{"credits": 10.0})); p["reason"] != "inactive" || p["available"] != 0.0 || p["topUp"] != nil {
		t.Fatal(p)
	}
	must(s.Change(ctx, alice, "starter", "plan"))
	if p := must(s.Preflight(ctx, "alice", "gpu", map[string]any{"credits": 1.0})); p["reason"] != "product" {
		t.Fatal(p)
	}
	must(s.Consume(ctx, "alice", "api", 70.0, "u1", Meta{}))
	must(s.Reserve(ctx, "alice", "api", map[string]any{"key": "t", "credits": 10.0}, ReservationMeta{}))
	summary := must(s.UsageSummary(ctx, "alice"))
	if !reflect.DeepEqual(summary["alerts"], []any{map[string]any{"productId": "api", "window": "day", "percent": 80.0, "threshold": 80.0}}) {
		t.Fatal(summary["alerts"])
	}
	must(s.Consume(ctx, "alice", "api", 15.0, "u2", Meta{}))
	short := must(s.Preflight(ctx, "alice", "api", map[string]any{"credits": 10.0}))
	if short["reason"] != "credits" || short["missing"] != 5.0 || !reflect.DeepEqual(short["topUp"], map[string]any{"credits": 5.0, "packs": 1.0, "amountMinor": 1000.0, "valueMinor": 5.0, "currency": "usd"}) {
		t.Fatal(short)
	}
	if fits := must(s.Preflight(ctx, "alice", "api", map[string]any{"estimate": map[string]any{"rateId": "standard", "inputTokens": 1000.0, "maxOutputTokens": 1000.0}})); fits["fits"] != true || fits["reason"] != nil {
		t.Fatal(fits)
	}
	if _, err := s.Preflight(ctx, "alice", "bad id", map[string]any{"credits": 1.0}); httpStatus(err) != 400 {
		t.Fatal(err)
	}
	if _, err := s.Preflight(ctx, "alice", "api", map[string]any{}); httpStatus(err) != 400 {
		t.Fatal(err)
	}
	if other := must(s.UsageSummary(ctx, "bob")); other["active"] != false || len(other["products"].([]any)) != 0 {
		t.Fatal(other)
	}
}

func TestPaymentRequiredPreflight(t *testing.T) {
	f := newFixture(t, true)
	must(f.s.Change(f.ctx, alice, "starter", "plan"))
	must(f.s.Reserve(f.ctx, "alice", "api", map[string]any{"key": "p1", "credits": 10.0}, ReservationMeta{}))
	values := defaultValues(t, f)
	values["paymentRequired"] = true
	must(f.s.SaveSettings(f.ctx, map[string]any{"version": 0.0, "values": values}, "root", nil))
	if p := must(f.s.Preflight(f.ctx, "alice", "api", map[string]any{"credits": 1.0})); p["reason"] != "payment" {
		t.Fatal(p)
	}
	if _, err := f.s.Reserve(f.ctx, "alice", "api", map[string]any{"key": "p2", "credits": 1.0}, ReservationMeta{}); httpStatus(err) != 402 {
		t.Fatal(err)
	}
	if r := must(f.s.Settle(f.ctx, "alice", "p1", map[string]any{"credits": 4.0}, ReservationMeta{})); r["credits"] != 4.0 {
		t.Fatal(r)
	}
	checkLedger(t, f.store, "alice")
}

func TestExpiryCrashResumeAndMaintenance(t *testing.T) {
	s, store, now := newReservations(t)
	ctx := context.Background()
	must(s.Change(ctx, alice, "starter", "plan"))
	must(s.Reserve(ctx, "alice", "api", map[string]any{"key": "turn-9:2", "estimate": map[string]any{"rateId": "advanced", "inputTokens": 2000.0, "maxOutputTokens": 1000.0}, "ttlMs": 60000.0}, ReservationMeta{}))
	must(s.Reserve(ctx, "alice", "api", map[string]any{"key": "e2", "credits": 10.0, "ttlMs": 60000.0}, ReservationMeta{}))
	*now += 60000
	if p := must(s.UsageSummary(ctx, "alice"))["products"].([]any)[0].(map[string]any); p["reserved"] != 0.0 {
		t.Fatal(p)
	}
	if r := must(s.Reserve(ctx, "alice", "api", map[string]any{"key": "e2", "credits": 10.0}, ReservationMeta{})); r["status"] != "expired" || r["replayed"] != true {
		t.Fatal(r)
	}
	settled := must(s.Settle(ctx, "alice", "turn-9:2", map[string]any{"inputTokens": 2000.0, "outputTokens": 400.0}, ReservationMeta{}))
	if settled["credits"] != 16.0 || settled["expired"] != true {
		t.Fatal(settled)
	}
	must(s.Reserve(ctx, "alice", "api", map[string]any{"key": "e3", "credits": 5.0, "ttlMs": 1000.0}, ReservationMeta{}))
	*now += 1000
	if r := must(s.Release(ctx, "alice", "e3", ReservationMeta{})); r["status"] != "expired" {
		t.Fatal(r)
	}
	must(s.Reserve(ctx, "alice", "api", map[string]any{"key": "e4", "credits": 5.0, "ttlMs": 1000.0}, ReservationMeta{}))
	*now += 1000
	if m := must(s.Maintenance(ctx)); m["processed"] != 1.0 {
		t.Fatal(m)
	}
	if row := must(store.Get(ctx, "SUB_RESERVATION#alice", "e4")); row.Data["status"] != "expired" {
		t.Fatal(row.Data)
	}
	_, account := checkLedger(t, store, "alice")
	if holds := account["reservations"].([]any); len(holds) != 0 {
		t.Fatal(holds)
	}
}

func TestAdminGrantHoldsAreSweptByMaintenance(t *testing.T) {
	s, store, now := newReservations(t)
	ctx := context.Background()
	must(0, store.Transact(ctx, []nosql.Write{{Row: nosql.Row{PK: "USERS", SK: "bob", Version: 1, Data: map[string]any{"id": "bob", "email": "bob@example.test"}}}}))
	must(s.Grant(ctx, "bob", map[string]any{"requestId": "g", "kind": "plan", "planId": "pro", "reason": "Pilot", "currency": "usd", "valueMinor": 0.0}, "root"))
	must(s.Reserve(ctx, "bob", "api", map[string]any{"key": "b", "credits": 900.0, "ttlMs": 1000.0}, ReservationMeta{}))
	*now += 1000
	must(s.Maintenance(ctx))
	if _, account := checkLedger(t, store, "bob"); len(account["reservations"].([]any)) != 0 {
		t.Fatal(account["reservations"])
	}
}

func TestConcurrentReservationsExactlyOneFits(t *testing.T) {
	s, store, _ := newReservations(t)
	ctx := context.Background()
	must(s.Change(ctx, alice, "starter", "plan"))
	must(s.Consume(ctx, "alice", "api", 40.0, "u0", Meta{}))
	var wg sync.WaitGroup
	errs := make([]error, 3)
	calls := []func() error{
		func() error {
			return second(s.Reserve(ctx, "alice", "api", map[string]any{"key": "a", "credits": 60.0}, ReservationMeta{}))
		},
		func() error {
			return second(s.Reserve(ctx, "alice", "api", map[string]any{"key": "b", "credits": 60.0}, ReservationMeta{}))
		},
		func() error { return second(s.Consume(ctx, "alice", "api", 60.0, "u1", Meta{})) },
	}
	for i, call := range calls {
		wg.Add(1)
		go func() { defer wg.Done(); errs[i] = call() }()
	}
	wg.Wait()
	ok := 0
	for _, err := range errs {
		if err == nil {
			ok++
		} else if httpStatus(err) != 429 {
			t.Fatal(err)
		}
	}
	if ok != 1 {
		t.Fatalf("%d fitted", ok)
	}
	checkLedger(t, store, "alice")
}

func TestAtMost25ActiveReservations(t *testing.T) {
	s, _, _ := newReservations(t)
	ctx := context.Background()
	must(s.Change(ctx, alice, "max", "plan"))
	for i := 0; i < MaxActiveReservations; i++ {
		must(s.Reserve(ctx, "alice", "api", map[string]any{"key": fmt.Sprint("s", i), "credits": 1.0}, ReservationMeta{}))
	}
	if _, err := s.Reserve(ctx, "alice", "api", map[string]any{"key": "s25", "credits": 1.0}, ReservationMeta{}); httpStatus(err) != 429 {
		t.Fatal(err)
	}
}

func TestInjectedFailuresNeverChargeTwice(t *testing.T) {
	ctx := context.Background()
	scenario := []func(s *Subscriptions) error{
		func(s *Subscriptions) error { return second(s.Change(ctx, alice, "starter", "plan")) },
		func(s *Subscriptions) error {
			return second(s.RecordCredits(ctx, "alice", map[string]any{"requestId": "pi", "productId": "api", "credits": 30.0, "reason": "Top-up"}))
		},
		func(s *Subscriptions) error {
			return second(s.Reserve(ctx, "alice", "api", map[string]any{"key": "a", "credits": 50.0}, ReservationMeta{}))
		},
		func(s *Subscriptions) error {
			return second(s.Reserve(ctx, "alice", "api", map[string]any{"key": "b", "estimate": map[string]any{"rateId": "standard", "inputTokens": 10000.0, "maxOutputTokens": 5000.0}}, ReservationMeta{}))
		},
		func(s *Subscriptions) error { return second(s.Consume(ctx, "alice", "api", 20.0, "u1", Meta{})) },
		func(s *Subscriptions) error {
			return second(s.Settle(ctx, "alice", "a", map[string]any{"credits": 45.0}, ReservationMeta{}))
		},
		func(s *Subscriptions) error { return second(s.Release(ctx, "alice", "b", ReservationMeta{})) },
		func(s *Subscriptions) error {
			return second(s.Reserve(ctx, "alice", "api", map[string]any{"key": "c", "credits": 30.0, "ttlMs": 1000.0}, ReservationMeta{}))
		},
	}
	run := func(point int, mode string) string {
		s, store, now := newReservations(t)
		for _, step := range scenario {
			if store.writes == point {
				store.failures = append(store.failures, mode)
			}
			if err := step(s); err != nil {
				if httpStatus(err) != 503 {
					t.Fatal(err)
				}
				if err := step(s); err != nil {
					t.Fatal(err)
				}
			}
		}
		*now += 1000
		must(s.Settle(ctx, "alice", "c", map[string]any{"credits": 12.0}, ReservationMeta{}))
		entries, account := checkLedger(t, store, "alice")
		var b strings.Builder
		for _, e := range entries {
			fmt.Fprintln(&b, e["kind"], e["credits"], e["held"], e["requestId"])
		}
		fmt.Fprintln(&b, account["creditBalance"], account["counters"])
		return b.String()
	}
	clean := run(-1, "")
	for point := 0; point < 12; point++ {
		for _, mode := range []string{"before", "after"} {
			if got := run(point, mode); got != clean {
				t.Fatalf("failure %s write %d:\n%s\n!=\n%s", mode, point, got, clean)
			}
		}
	}
}

func TestRandomSequencesKeepTheLedgerBalanced(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	ctx := context.Background()
	for round := 0; round < 10; round++ {
		s, store, now := newReservations(t)
		plan := "pro"
		if round%2 == 1 {
			plan = "starter"
		}
		must(s.Change(ctx, alice, plan, "plan"))
		var keys []string
		for step := 0; step < 40; step++ {
			key := fmt.Sprintf("k%d-%d", round, step)
			var err error
			switch action := rng.Intn(8); {
			case action == 0:
				if err = second(s.Reserve(ctx, "alice", "api", map[string]any{"key": key, "credits": float64(1 + rng.Intn(120)), "ttlMs": float64(1000 + rng.Intn(4)*3600000)}, ReservationMeta{})); err == nil {
					keys = append(keys, key)
				}
			case action == 1 && len(keys) > 0:
				err = second(s.Settle(ctx, "alice", keys[rng.Intn(len(keys))], map[string]any{"credits": float64(rng.Intn(150))}, ReservationMeta{}))
			case action == 2 && len(keys) > 0:
				err = second(s.Release(ctx, "alice", keys[rng.Intn(len(keys))], ReservationMeta{}))
			case action == 3:
				err = second(s.Consume(ctx, "alice", "api", float64(1+rng.Intn(60)), key, Meta{}))
			case action == 4:
				err = second(s.RecordCredits(ctx, "alice", map[string]any{"requestId": key, "productId": "api", "credits": float64(1 + rng.Intn(80)), "reason": "Top-up"}))
			case action == 5:
				*now += float64(rng.Intn(3)*3600000 + rng.Intn(2)*86400000)
			case action == 6:
				err = second(s.Maintenance(ctx))
			default:
				if err = second(s.Reserve(ctx, "alice", "api", map[string]any{"key": key, "estimate": map[string]any{"rateId": "advanced", "inputTokens": float64(rng.Intn(9000)), "maxOutputTokens": float64(rng.Intn(4000))}}, ReservationMeta{})); err == nil {
					keys = append(keys, key)
				}
			}
			if st := httpStatus(err); err != nil && st != 402 && st != 409 && st != 429 {
				t.Fatal(err)
			}
			checkLedger(t, store, "alice")
		}
	}
}

func TestReservationEndpointsKeepUserAndBackendApart(t *testing.T) {
	s, store, _ := newReservations(t)
	ctx := context.Background()
	must(s.Change(ctx, alice, "starter", "plan"))
	endpoints := s.Feature().Endpoints
	user := &web.Actor{ID: "alice", Role: "user"}
	root := &web.Actor{ID: "rt-app-root", Role: "owner"}
	call := func(method, path string, body map[string]any, actor *web.Actor, params map[string]string) (map[string]any, error) {
		for _, e := range endpoints {
			if e.Method == method && e.Path == path {
				v, err := e.Handle(&web.Context{Ctx: ctx, Request: web.Request{Method: method, Path: path, Body: body}, Params: params, Actor: actor})
				if err != nil {
					return nil, err
				}
				return v.(map[string]any), nil
			}
		}
		t.Fatalf("no endpoint %s %s", method, path)
		return nil, nil
	}
	if r := must(call("POST", "/subscriptions/credits/reservations", map[string]any{"key": "u:1", "productId": "api", "credits": 10.0, "extra": 1.0}, user, nil)); r["status"] != "active" {
		t.Fatal(r)
	}
	must(call("POST", "/subscriptions/admin/accounts/:id/reservations", map[string]any{"key": "s:1", "productId": "api", "credits": 5.0}, root, map[string]string{"id": "alice"}))
	if _, err := call("POST", "/subscriptions/credits/reservations/:key/release", map[string]any{}, user, map[string]string{"key": "s:1"}); httpStatus(err) != 404 {
		t.Fatal(err)
	}
	if _, err := call("POST", "/subscriptions/credits/reservations/:key/settle", map[string]any{"credits": 1.0}, user, map[string]string{"key": "s:1"}); httpStatus(err) != 404 {
		t.Fatal(err)
	}
	if r := must(call("POST", "/subscriptions/credits/reservations/:key/settle", map[string]any{"credits": 4.0}, user, map[string]string{"key": "u:1"})); r["credits"] != 4.0 {
		t.Fatal(r)
	}
	must(call("POST", "/subscriptions/admin/accounts/:id/reservations/:key/settle", map[string]any{"credits": 5.0}, root, map[string]string{"id": "alice", "key": "s:1"}))
	must(call("POST", "/subscriptions/credits/reservations", map[string]any{"key": "u:2", "productId": "api", "credits": 1.0}, user, nil))
	if r := must(call("POST", "/subscriptions/credits/reservations/:key/release", map[string]any{}, user, map[string]string{"key": "u:2"})); r["status"] != "released" {
		t.Fatal(r)
	}
	must(call("POST", "/subscriptions/admin/accounts/:id/reservations", map[string]any{"key": "s:2", "productId": "api", "credits": 1.0}, root, map[string]string{"id": "alice"}))
	if r := must(call("POST", "/subscriptions/admin/accounts/:id/reservations/:key/release", map[string]any{}, root, map[string]string{"id": "alice", "key": "s:2"})); r["status"] != "released" {
		t.Fatal(r)
	}
	if r := must(call("POST", "/subscriptions/credits/preflight", map[string]any{"productId": "api", "credits": 1.0}, user, nil)); r["fits"] != true {
		t.Fatal(r)
	}
	if r := must(call("POST", "/subscriptions/admin/accounts/:id/preflight", map[string]any{"productId": "api", "credits": 1.0}, root, map[string]string{"id": "alice"})); r["fits"] != true {
		t.Fatal(r)
	}
	if r := must(call("GET", "/subscriptions/credits/usage", nil, user, nil)); r["userId"] != "alice" {
		t.Fatal(r)
	}
	if r := must(call("GET", "/subscriptions/admin/accounts/:id/usage", nil, root, map[string]string{"id": "alice"})); r["userId"] != "alice" {
		t.Fatal(r)
	}
	entries, _ := checkLedger(t, store, "alice")
	if entries[2]["source"] != "user" || entries[2]["actorId"] != "alice" || entries[3]["source"] != "api" || entries[3]["actorId"] != "rt-app-root" {
		t.Fatal(entries[2], entries[3])
	}
}
