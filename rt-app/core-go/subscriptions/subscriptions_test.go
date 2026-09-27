package subscriptions

import (
	"encoding/json"
	"math"
	"reflect"
	"strings"
	"testing"

	"rt.local/core-go/apperr"
)

func TestNumberString(t *testing.T) {
	for x, want := range map[float64]string{
		0: "0", math.Copysign(0, -1): "0", 1: "1", -1: "-1", 1.5: "1.5", 1788220800000: "1788220800000",
		1e21: "1e+21", 1.5e21: "1.5e+21", 1e20: "100000000000000000000", 1e-7: "1e-7", 1.25e-7: "1.25e-7",
		0.000001: "0.000001", 0.30000000000000004: "0.30000000000000004", 9007199254740993: "9007199254740992",
		math.NaN(): "NaN", math.Inf(1): "Infinity", math.Inf(-1): "-Infinity",
	} {
		if got := NumberString(x); got != want {
			t.Errorf("NumberString(%v) = %q, want %q", x, got, want)
		}
	}
}

func TestJSRound(t *testing.T) {
	for x, want := range map[float64]float64{
		0.5: 1, 1.5: 2, 2.5: 3, -0.5: 0, -1.5: -1, -2.5: -2, 0.49999999999999994: 0, 27.5: 28, 5699.999999999999: 5700,
	} {
		if got := jsRound(x); got != want {
			t.Errorf("jsRound(%v) = %v, want %v", x, got, want)
		}
	}
	if got := jsRound(-0.3); !math.Signbit(got) {
		t.Errorf("jsRound(-0.3) = %v, want -0", got)
	}
}

func TestCutUTF16AndLoneSurrogates(t *testing.T) {
	name := strings.Repeat("a", 79) + "😀"
	cut := cutUTF16(name, 80)
	raw, err := json.Marshal(CreditRate{ID: "a", Name: cut})
	if err != nil {
		t.Fatal(err)
	}
	if want := `"name":"` + strings.Repeat("a", 79) + `\ud83d"`; !strings.Contains(string(raw), want) {
		t.Fatalf("marshal = %s, want %s", raw, want)
	}
	if got := cutUTF16(strings.Repeat("😀", 50), 80); got != strings.Repeat("😀", 40) {
		t.Errorf("40 emoji are 80 units, got %d bytes", len(got))
	}
	if got := wellFormed(cut); got != strings.Repeat("a", 79)+"�" {
		t.Errorf("wellFormed = %q", got)
	}
}

func TestLedgerKey(t *testing.T) {
	for _, c := range []struct {
		at, seq float64
		seed    string
		want    string
	}{
		{0, 0, "", "000000000000000-0000000000-e3b0c44298fc1c14"},
		{1788220800000, 7, "abc", "001788220800000-0000000007-ba7816bf8f01cfea"},
		{-1, 0, "s", "0000000000000-1-0000000000-043a718774c572bd"},
		{1.5, 2.5, "s", "0000000000001.5-00000002.5-043a718774c572bd"},
		{1e21, 0, "s", "00000000001e+21-0000000000-043a718774c572bd"},
		{9007199254740991, 1, "s", "9007199254740991-0000000001-043a718774c572bd"},
		{1, 1, "a�b", "000000000000001-0000000001-05087813392efc16"},
		{1, 1, "a\xed\xa0\x80b", "000000000000001-0000000001-05087813392efc16"}, // lone U+D800 hashes as U+FFFD
	} {
		if got := LedgerKey(c.at, c.seed, c.seq); got != c.want {
			t.Errorf("LedgerKey(%v, %q, %v) = %s, want %s", c.at, c.seed, c.seq, got, c.want)
		}
	}
}

func TestLedgerWriteKeepsUnknownFieldsAndReplacesID(t *testing.T) {
	var entry Entry
	if err := json.Unmarshal([]byte(`{"id":"forged","at":5,"kind":"grant","source":"admin","credits":250,"reason":"Courtesy","amountMinor":0,"currency":"usd","extra":"kept","details":{}}`), &entry); err != nil {
		t.Fatal(err)
	}
	written, err := LedgerWrite("bob", entry, "grant:g1", 0)
	if err != nil {
		t.Fatal(err)
	}
	const key = "000000000000005-0000000000-4abfbe07ca6291fc"
	if entry.ID != "forged" || written.Entry.ID != key || written.Write.Row.SK != key || written.Write.Row.PK != "SUB_LEDGER#bob" {
		t.Fatalf("written = %+v", written)
	}
	data := written.Write.Row.Data
	if data["extra"] != "kept" || data["amountMinor"] != 0.0 || data["id"] != key || written.Write.Expected != nil || written.Write.Row.Version != 1 {
		t.Fatalf("data = %v", data)
	}
	if d, ok := data["details"].(map[string]any); !ok || len(d) != 0 {
		t.Fatalf("empty details must be kept: %v", data["details"])
	}
}

func TestApplyTotals(t *testing.T) {
	amount := func(n float64) *float64 { return &n }
	stored := Totals{CreditsIn: 1, PaidMinor: map[string]float64{"usd": 10}, Extra: map[string]any{"consumed": 90.0}}
	next := ApplyTotals(&stored, Entry{Kind: KindPurchase, Source: SourceBilling, Credits: 5, AmountMinor: amount(-200), Currency: "usd"})
	if next.CreditsIn != 6 || next.PaidMinor["usd"] != -190 || next.Extra["consumed"] != 90.0 {
		t.Fatalf("next = %+v", next)
	}
	if stored.PaidMinor["usd"] != 10 || stored.CreditsIn != 1 {
		t.Fatal("the input totals changed")
	}
	next = ApplyTotals(&next, Entry{Kind: KindPlan, Source: SourceAdmin, AmountMinor: amount(3), Currency: "USD"})
	if next.GrantedValueMinor["USD"] != 3 || next.CreditsOut != 0 {
		t.Fatalf("admin money goes to grantedValueMinor: %+v", next)
	}
	next = ApplyTotals(nil, Entry{Kind: KindExpiry, Credits: 30, AmountMinor: amount(0), Currency: "usd"})
	if next.Expired != -30 || len(next.PaidMinor) != 0 {
		t.Fatalf("expiry = %+v", next)
	}
	if got := ApplyTotals(nil, Entry{Kind: KindGrant, Credits: 0.1}); ApplyTotals(&got, Entry{Kind: KindGrant, Credits: 0.2}).CreditsIn != 0.30000000000000004 {
		t.Fatal("float64 addition")
	}
	raw, _ := json.Marshal(Totals{})
	if string(raw) != `{"creditsIn":0,"creditsOut":0,"expired":0,"paidMinor":{},"grantedValueMinor":{}}` {
		t.Fatalf("zero totals = %s", raw)
	}
}

func TestWindowStateKeepsJavaScriptPropertyOrder(t *testing.T) {
	var state WindowState
	raw := `{"key":"k","products":{"b":{"start":0},"a":{"start":1},"10":{"start":2},"2":{"start":3},"01":{"start":4},"b":{"start":5}}}`
	if err := json.Unmarshal([]byte(raw), &state); err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, w := range state.Products {
		ids = append(ids, w.ID)
	}
	if want := []string{"2", "10", "b", "a", "01"}; !reflect.DeepEqual(ids, want) {
		t.Fatalf("order = %v, want %v", ids, want)
	}
	if state.window("b").Start != 5 {
		t.Fatal("a repeated key keeps its first position and its last value")
	}
	out, _ := json.Marshal(state)
	if !strings.HasPrefix(string(out), `{"key":"k","products":{"2":`) {
		t.Fatalf("marshal = %s", out)
	}
}

func TestRolloverOrdersExpiriesInReverseThenAllowances(t *testing.T) {
	previous := &WindowState{Key: "own:multi"}
	current := &CurrentWindow{Key: "own:multi", PeriodMs: 2592000000}
	for _, id := range []string{"b", "a", "10", "2"} {
		previous.Products = putWindow(previous.Products, Window{ID: id, Allowance: 5, Name: id, WeekSeconds: 604800})
		current.Products = append(current.Products, CurrentProduct{ID: id, Name: id, WeeklyLimit: 7, WeekSeconds: 604800, Start: 604800000})
	}
	rolled := Rollover(previous, current, nil, 604800005)
	var got []string
	for _, e := range rolled.Entries {
		got = append(got, string(e.Kind)+":"+e.ProductID)
	}
	want := []string{"expiry:a", "expiry:b", "expiry:10", "expiry:2", "allowance:b", "allowance:a", "allowance:10", "allowance:2"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("order = %v, want %v", got, want)
	}
	if rolled.State.window("2").Allowance != 7 {
		t.Fatalf("state = %+v", rolled.State)
	}
}

func TestRolloverIdleWeeksAndPlanEnd(t *testing.T) {
	previous := &WindowState{Key: "own:x", Products: []Window{{ID: "api", Allowance: 0.3, Name: "API", WeekSeconds: 604800}}}
	current := &CurrentWindow{Key: "own:x", PeriodMs: 2592000000, Products: []CurrentProduct{{ID: "api", Name: "API", WeeklyLimit: 0.3, WeekSeconds: 604800, Start: 1209600000}}}
	used := func(id string, start float64) float64 { return 0.1 }
	rolled := Rollover(previous, current, used, 1209600000)
	e := rolled.Entries[0]
	if e.At != 604800000 || e.Credits != -0.5 || e.Details.Unused != 0.19999999999999998 || e.Details.SkippedWeeks != 1 ||
		e.Reason != "API: unused allowance of 2 weeks expired" || e.Seed != "expiry:own:x:api:0:1209600000" {
		t.Fatalf("expiry = %+v", e)
	}
	ended := Rollover(previous, nil, used, 172800000)
	if len(ended.Entries) != 1 || ended.State != nil || ended.Entries[0].At != 172800000 || ended.Entries[0].Reason != "API: allowance ended with the plan" {
		t.Fatalf("ended = %+v", ended)
	}
	if empty := Rollover(nil, nil, nil, 0); empty.Entries == nil || len(empty.Entries) != 0 {
		t.Fatal("entries must be an empty list")
	}
}

func status(err error) (int, string) {
	if e, ok := apperr.As(err); ok {
		return e.Status, e.Message
	}
	return 0, ""
}

func decode(t *testing.T, raw string) any {
	t.Helper()
	var v any
	if err := json.Unmarshal([]byte(raw), &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestValidateCredits(t *testing.T) {
	got, err := ValidateCredits(decode(t, `{"pack":{"credits":500,"amountMinor":999,"currency":"EUR"},"rates":[{"id":"x","name":"  Fast  ","inputPer1k":0.57,"outputPer1k":0.07},{"id":"B","name":42,"inputPer1k":0,"outputPer1k":1000000}]}`))
	if err != nil {
		t.Fatal(err)
	}
	want := CreditSettings{Pack: Pack{500, 999, "eur"}, Rates: []CreditRate{{ID: "x", Name: "Fast", InputPer1k: 0.57, OutputPer1k: 0.07}, {ID: "B", Name: "42", OutputPer1k: 1e6}}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v", got)
	}
	for input, message := range map[string]string{
		`null`: "Invalid currency",
		`{"pack":{"credits":1,"amountMinor":1,"currency":840},"rates":[]}`:                                                          "Invalid currency",
		`{"pack":{"credits":1,"amountMinor":"100","currency":"usd"},"rates":[]}`:                                                    "Invalid numeric setting",
		`{"pack":{"credits":1,"amountMinor":150,"currency":"ISK"},"rates":[]}`:                                                      "Invalid amount for currency",
		`{"pack":{"credits":1,"amountMinor":1,"currency":"usd"},"rates":{}}`:                                                        "Use at most 50 credit rates",
		`{"pack":{"credits":1,"amountMinor":1,"currency":"usd"},"rates":[{"id":"bad id","inputPer1k":-1}]}`:                         "Invalid identifier",
		`{"pack":{"credits":1,"amountMinor":1,"currency":"usd"},"rates":[{"id":"a","inputPer1k":true,"outputPer1k":1}]}`:            "Invalid credit rate",
		`{"pack":{"credits":1,"amountMinor":1,"currency":"usd"},"rates":[{"id":"a","inputPer1k":0.12345,"outputPer1k":1}]}`:         "Invalid credit rate",
		`{"pack":{"credits":1,"amountMinor":1,"currency":"usd"},"rates":[{"id":"a","inputPer1k":1,"outputPer1k":1,"minimum":0.5}]}`: "Invalid numeric setting",
		`{"pack":{"credits":0,"amountMinor":1,"currency":"usd"},"rates":[{"id":"a","name":" ","inputPer1k":1,"outputPer1k":1}]}`:    "Duplicate or unnamed credit rates",
		`{"pack":{"credits":0,"amountMinor":1,"currency":"usd"},"rates":[]}`:                                                        "Invalid numeric setting",
	} {
		_, err := ValidateCredits(decode(t, input))
		if code, got := status(err); code != 400 || got != message {
			t.Errorf("%s: got %d %q, want 400 %q", input, code, got, message)
		}
	}
}

func TestEstimate(t *testing.T) {
	settings := CreditSettings{Pack: Pack{2, 1, "usd"}, Rates: []CreditRate{{ID: "noisy", Name: "Noisy", InputPer1k: 1.1}, {ID: "tiny", Name: "Tiny", InputPer1k: 0.0001}}}
	e, err := settings.Estimate("noisy", 50000, 0)
	if err != nil || e.ExactCredits != 55 || e.Credits != 55 || e.ValueMinor != 28 {
		t.Fatalf("noisy = %+v, %v", e, err)
	}
	e, _ = settings.Estimate("tiny", 10000005, 0)
	if e.Credits != 2 || e.ExactCredits != 1 {
		t.Fatalf("tiny = %+v", e)
	}
	e, _ = DefaultCredits().Estimate("standard", 1000, 500)
	if e.ExactCredits != 2.5 || e.Credits != 3 || e.ValueMinor != 3 || e.Currency != "usd" {
		t.Fatalf("standard = %+v", e)
	}
	if code, msg := status(func() error { _, err := DefaultCredits().Estimate("premium", -1, 0); return err }()); code != 404 || msg != "Credit rate not found" {
		t.Fatalf("unknown rate: %d %s", code, msg)
	}
	for _, tokens := range [][2]float64{{-1, 0}, {1.5, 0}, {math.NaN(), 0}, {1e10 + 1, 0}, {1, -5}} {
		if code, _ := status(func() error { _, err := DefaultCredits().Estimate("standard", tokens[0], tokens[1]); return err }()); code != 400 {
			t.Errorf("tokens %v: status %d", tokens, code)
		}
	}
}

func TestCurrency(t *testing.T) {
	if !ValidCurrency("xcg") || ValidCurrency("USD") || ValidCurrency("") {
		t.Fatal("ValidCurrency")
	}
	for code, want := range map[string]int{"usd": 2, "JPY": 0, "TND": 3, "isk": 2, "zzz": 2} {
		if got := CurrencyDecimals(code); got != want {
			t.Errorf("CurrencyDecimals(%s) = %d", code, got)
		}
	}
	for _, c := range []struct {
		amount float64
		code   string
		want   bool
	}{{0, "usd", true}, {9007199254740991, "usd", true}, {9007199254740992, "usd", false}, {-1, "usd", false}, {1.5, "usd", false}, {150, "isk", false}, {200, "ISK", true}, {150, "zzz", true}} {
		if got := ValidMinorAmount(c.amount, c.code); got != c.want {
			t.Errorf("ValidMinorAmount(%v, %s) = %v", c.amount, c.code, got)
		}
	}
}
