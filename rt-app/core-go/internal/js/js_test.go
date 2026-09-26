package js

import (
	"math"
	"testing"
)

func TestStrings(t *testing.T) {
	for in, want := range map[string]string{"İNCI": "i\u0307nci", "ÁNGEL": "ángel", "ΟΔΟΣ": "οδος", "ΟΔΟΣ@X": "οδος@x", "ΑΣ.Β": "ασ.β", "Σ": "σ"} {
		if got := ToLower(in); got != want {
			t.Errorf("ToLower(%q) = %q, want %q", in, got, want)
		}
	}
	if got := Trim("\ufeff\u00a0\u2003 a \n\u2028"); got != "a" {
		t.Errorf("Trim = %q", got)
	}
	if got := Trim("a\u0085"); got != "a\u0085" {
		t.Errorf("NEL trimmed: %q", got)
	}
	if IsSpace('\u200b') || IsSpace('\u001f') || !IsSpace('\u3000') {
		t.Error("IsSpace set")
	}
	if Len("😀x") != 3 || Len("é") != 1 {
		t.Error("Len counts UTF-16 units")
	}
	if EncodeURIComponent("a b@c.d/é!") != "a%20b%40c.d%2F%C3%A9!" {
		t.Error(EncodeURIComponent("a b@c.d/é!"))
	}
}

func TestValues(t *testing.T) {
	if Truthy(0.0) || Truthy("") || Truthy(nil) || !Truthy([]any{}) || !Truthy("0") {
		t.Error("Truthy")
	}
	if _, ok := Integer(true); ok {
		t.Error("true is not an integer")
	}
	if _, ok := Integer(1.5); ok {
		t.Error("1.5 is not an integer")
	}
	if !math.IsNaN(Field(map[string]any{}, "x")) || Field(map[string]any{"x": nil}, "x") != 0 {
		t.Error("Field: undefined is NaN, null is 0")
	}
	for f, want := range map[float64]string{1: "1", 1.5: "1.5", -1: "-1", 1e21: "1e+21", 1e-7: "1e-7", 123456789012: "123456789012"} {
		if got := FormatNumber(f); got != want {
			t.Errorf("FormatNumber(%v) = %s", f, got)
		}
	}
	if !Equal(1.0, 1.0) || Equal(1.0, "1") || !Equal(nil, nil) {
		t.Error("Equal")
	}
}
