package jsjson

import (
	"encoding/json"
	"testing"
)

func TestStringifyMatchesJavaScript(t *testing.T) {
	value := map[string]any{"b": 1.0, "a": 2.0, "10": 3.0, "2": 4.0, "😀": 5.0, "！": 6.0, "4294967295": 7.0, "4294967294": 8.0}
	got, _ := Stringify(value)
	if want := `{"2":4,"10":3,"4294967294":8,"4294967295":7,"a":2,"b":1,"😀":5,"！":6}`; got != want {
		t.Errorf("order: %s", got)
	}
	got, _ = Canonical(map[string]any{"b": 1.0, "10": 2.0, "2": 3.0})
	if got != `{"10":2,"2":3,"b":1}` {
		t.Errorf("canonical: %s", got)
	}
	got, _ = Stringify([]any{1e21, 1e-7, 100.0, 0.000001, "\x00\x1f\b\"\\\x7f\u2028<&>", json.RawMessage(`{"x":1}`)})
	if want := "[1e+21,1e-7,100,0.000001,\"\\u0000\\u001f\\b\\\"\\\\\x7f\u2028<&>\",{\"x\":1}]"; got != want {
		t.Errorf("values: %s", got)
	}
	got, _ = Stringify(Pairs{{"b", nil}, {"10", ""}, {"2", "x"}, {"a", nil}})
	if got != `{"2":"x","10":"","b":null,"a":null}` {
		t.Errorf("pairs: %s", got)
	}
	if _, err := Stringify(struct{}{}); err == nil {
		t.Error("unsupported values must fail")
	}
}
