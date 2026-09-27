package idempotency

import (
	"context"
	"errors"
	"testing"
	"time"

	"rt.local/core-go/apperr"
	"rt.local/core-go/nosql"
)

func fixed() time.Time { return time.UnixMilli(1767323045678) } // 2026-01-02T03:04:05.678Z

func returning(result any, calls *[]Context) Work {
	return func(_ context.Context, c Context) (any, error) {
		*calls = append(*calls, c)
		return result, nil
	}
}

func TestReplayConflictAndRowFormat(t *testing.T) {
	ctx := context.Background()
	store := nosql.NewMemoryStore()
	e := NewNoSQL(store, WithClock(fixed))
	var calls []Context
	request := Request{Scope: "shop:u1:charge:v1", Key: "order-1", Input: map[string]any{"currency": "USD", "amount": 10.0}}
	if v, err := e.Execute(ctx, request, returning(map[string]any{"id": "paid"}, &calls)); err != nil || v.(map[string]any)["id"] != "paid" {
		t.Fatal(v, err)
	}
	if v, err := e.Execute(ctx, request, returning("other", &calls)); err != nil || v.(map[string]any)["id"] != "paid" {
		t.Fatal(v, err)
	}
	if len(calls) != 1 || calls[0].IdempotencyKey != "rtapp-1d70ab84a2b68564ecc7595944c41ee98bb8df1f468c300f39ab1a64eeea9c85" {
		t.Fatalf("calls = %+v", calls)
	}
	row, _ := store.Get(ctx, "IDEMPOTENCY#shop:u1:charge:v1", "order-1")
	if row.Version != 2 || row.Data["fingerprint"] != "1748e5b562237637f7af0d4e3d15d118c268e47a60ed8f248142dc1c978dc6c9" || row.Data["createdAt"] != "2026-01-02T03:04:05.678Z" {
		t.Fatalf("row = %+v", row)
	}
	request.Input = map[string]any{"amount": 11.0}
	if _, err := e.Execute(ctx, request, returning(1.0, &calls)); !IsCode(err, Conflict) || err.Error() != "RT-App idempotency: CONFLICT" {
		t.Fatal(err)
	}
}

func TestFailuresAreUncertain(t *testing.T) {
	ctx := context.Background()
	e := NewNoSQL(nosql.NewMemoryStore())
	boom := errors.New("gateway timeout")
	request := Request{Scope: "s", Key: "k", Input: 1.0}
	_, err := e.Execute(ctx, request, func(context.Context, Context) (any, error) { return nil, boom })
	if !IsCode(err, Uncertain) || !errors.Is(err, boom) {
		t.Fatal(err)
	}
	var calls []Context
	if _, err := e.Execute(ctx, request, returning(1.0, &calls)); !errors.Is(err, NewError(Uncertain)) || len(calls) != 0 {
		t.Fatal(err, calls)
	}
	_, err = e.Execute(ctx, Request{Scope: "p", Key: "k", Input: 1.0}, func(context.Context, Context) (any, error) { panic("crash") })
	if !IsCode(err, Uncertain) {
		t.Fatal(err)
	}
}

func TestPendingWhileRunning(t *testing.T) {
	ctx := context.Background()
	e := NewNoSQL(nosql.NewMemoryStore())
	request := Request{Scope: "s", Key: "k", Input: 1.0}
	var nested error
	_, err := e.Execute(ctx, request, func(ctx context.Context, _ Context) (any, error) {
		_, nested = e.Execute(ctx, request, func(context.Context, Context) (any, error) { return nil, nil })
		return "done", nil
	})
	if err != nil || !IsCode(nested, Pending) {
		t.Fatal(err, nested)
	}
}

func TestValidation(t *testing.T) {
	ctx := context.Background()
	e := NewNoSQL(nosql.NewMemoryStore())
	var calls []Context
	emoji := ""
	for range 129 {
		emoji += "😀"
	}
	for _, r := range []Request{{Scope: "", Key: "k"}, {Scope: "\u00a0\ufeff\u3000", Key: "k"}, {Scope: "s", Key: emoji}} {
		if _, err := e.Execute(ctx, r, returning(nil, &calls)); !IsCode(err, InvalidKey) {
			t.Errorf("%+v: %v", r, err)
		}
	}
	if _, err := e.Execute(ctx, Request{Scope: "s", Key: "k", NoInput: true}, returning(nil, &calls)); !IsCode(err, InvalidJSON) {
		t.Error(err)
	}
	if _, err := e.Execute(ctx, Request{Scope: "\u200b", Key: "k", Input: nil}, returning(nil, &calls)); err != nil {
		t.Error("U+200B is not whitespace", err)
	}
	if err := (&Executor{}).Init(); !IsCode(err, NotConfigured) {
		t.Error(err)
	}
	if _, err := (&Idempotent{}).ExecuteIdempotent(ctx, Request{}, nil); !IsCode(err, NotConfigured) {
		t.Error(err)
	}
	if Key("tenant/é/😀\u2028</script>&", "k\n\t\u0001\u007f\"\\") != "rtapp-f22f9cc87fa0e9c17848ea756f5dbd21c62f78d442fd27dcee129f9f21d69859" {
		t.Error("the key must hash JSON.stringify output")
	}
}

func TestStoreOwnerRules(t *testing.T) {
	ctx := context.Background()
	s := NewNoSQLStore(nosql.NewMemoryStore())
	claim := Claim{Scope: "s", Key: "k", Fingerprint: "f", Owner: "a"}
	if d, _ := s.Claim(ctx, claim); d.State != Acquired {
		t.Fatal(d)
	}
	other := claim
	other.Owner = "b"
	if d, _ := s.Claim(ctx, other); d.State != StatePending {
		t.Fatal(d)
	}
	if err := s.Complete(ctx, other, 1.0); !apperr.IsConflict(err) {
		t.Fatal(err)
	}
	if err := s.Complete(ctx, claim, nil); err != nil {
		t.Fatal(err)
	}
	if err := s.MarkUncertain(ctx, claim); err != nil {
		t.Fatal(err)
	}
	if d, _ := s.Claim(ctx, other); d.State != Completed || !d.HasResult || d.Result != nil {
		t.Fatal(d)
	}
}
