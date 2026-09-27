package subscriptions

import (
	"math"
	"testing"
)

func TestRound4NeverNegativeZero(t *testing.T) {
	if v := round4(-0.00001); v != 0 || math.Signbit(v) {
		t.Fatalf("round4(-0.00001) = %v", v)
	}
	if v := round4(2.09999999); v != 2.1 {
		t.Fatalf("round4 = %v", v)
	}
}

func TestProviderCost(t *testing.T) {
	in, out := 1.5, 7.5
	cost, ok := ProviderCost(CreditRate{CostInputPer1k: &in, CostOutputPer1k: &out}, 2000, 500)
	if !ok || cost != 6.75 {
		t.Fatalf("cost %v %v", cost, ok)
	}
	if _, ok := ProviderCost(CreditRate{}, 1, 1); ok {
		t.Fatal("a rate without costs has no cost")
	}
}

func TestExceededWindow(t *testing.T) {
	windows := []any{WindowUsage("day", 18, 0, 20, 0), WindowUsage("period", 18, 0, 100, 0)}
	if w := exceededWindow(windows, 2); w != "" {
		t.Fatalf("2 fits, got %q", w)
	}
	if w := exceededWindow(windows, 3); w != "day" {
		t.Fatalf("3 overflows day, got %q", w)
	}
}
