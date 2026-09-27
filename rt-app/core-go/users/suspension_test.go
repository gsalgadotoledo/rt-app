package users

import "testing"

func TestParseInstant(t *testing.T) {
	for value, want := range map[string]int64{
		"2026-01-02T03:04:05+01:00": 1767319445000, "2026-01-02T03:04:05.1Z": 1767323045100,
		"9999-12-31T23:59:59.999Z": MaxInstantMs, "1970-01-01T00:00:00Z": 0, "2024-02-29T00:00:00Z": 1709164800000,
	} {
		if got, ok := ParseInstant(value); !ok || got != want {
			t.Errorf("%s: %d %v", value, got, ok)
		}
	}
	for _, bad := range []any{nil, 5.0, "", "2026-01-02", "2026-01-02T03:04:05Z\n", "2025-02-29T00:00:00Z", "٢٠٢٦-01-02T00:00:00Z",
		"2026-01-02T00:00:00+24:00", "1969-12-31T23:59:59Z", "9999-12-31T23:59:59-00:01", "2026-04-31T00:00:00Z"} {
		if _, ok := ParseInstant(bad); ok {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestActiveBanAndView(t *testing.T) {
	now := int64(1772359200000)
	ban := map[string]any{"reason": "Spam", "category": nil, "until": "2026-03-01T10:00:00.001Z", "at": "x", "by": "rt-app-root"}
	if got := ActiveBan(map[string]any{"ban": ban}, now); got == nil || got["reason"] != "Spam" {
		t.Fatal(got)
	}
	if got := ActiveBan(map[string]any{"ban": ban}, now+1); got != nil {
		t.Fatal("until <= now is lifted", got)
	}
	if ActiveBan(map[string]any{"ban": []any{1.0}}, now) != nil || ActiveBan(nil, now) != nil {
		t.Fatal("not a ban")
	}
	if got := ActiveBan(map[string]any{"ban": map[string]any{"until": "soon"}}, now); got["until"] != "soon" {
		t.Fatal("fail closed", got)
	}
	view := ViewAccount(map[string]any{"id": "u", "ban": ban, "tokenVersion": 3.0}, now)
	if view["banned"] != true || view["ban"].(map[string]any)["reason"] != "Spam" {
		t.Fatal(view)
	}
	if _, has := view["tokenVersion"]; has {
		t.Fatal("tokenVersion leaked")
	}
	if view := ViewAccount(map[string]any{"id": "u"}, now); view["banned"] != false || view["ban"] != nil {
		t.Fatal(view)
	}
}
