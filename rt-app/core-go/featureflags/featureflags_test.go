package featureflags

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"rt.local/core-go/apperr"
	"rt.local/core-go/nosql"
)

var ctx = context.Background()

func valid() Definition {
	return Definition{Description: "", Enabled: true, Public: true, Rollout: 50, Subjects: []string{}}
}

func TestKeys(t *testing.T) {
	for _, key := range []string{"Bad Key", "1checkout", "", "check/out", "a" + strings.Repeat("x", 80)} {
		if err := ValidateKey(key); !errors.Is(err, ErrInvalidKey) {
			t.Errorf("%q: got %v", key, err)
		}
	}
	for _, key := range []string{"a.b_c-d9", "k" + strings.Repeat("2", 79)} {
		if err := ValidateKey(key); err != nil {
			t.Errorf("%q: got %v", key, err)
		}
	}
}

func TestSaveVersionsAndAudit(t *testing.T) {
	now := time.Date(2026, 1, 2, 3, 4, 5, 678_900_000, time.FixedZone("x", 3600))
	f := New(nosql.NewMemoryStore(), WithClock(func() time.Time { return now }))
	def := valid()
	def.Subjects = []string{"vip", "vip", "beta"}
	flag, err := f.Save(ctx, "new-checkout", def, nil, "owner-1")
	if err != nil {
		t.Fatal(err)
	}
	if flag.Version != 1 || flag.UpdatedAt != "2026-01-02T02:04:05.678Z" || flag.UpdatedBy != "owner-1" || strings.Join(flag.Subjects, ",") != "vip,beta" {
		t.Fatalf("unexpected flag %+v", flag)
	}
	if _, err := f.Save(ctx, "new-checkout", def, nil, "a"); !apperr.IsConflict(err) {
		t.Fatalf("create existing: %v", err)
	}
	if _, err := f.Save(ctx, "new-checkout", def, ptr(7), "a"); !apperr.IsConflict(err) {
		t.Fatalf("stale version: %v", err)
	}
	updated, err := f.Save(ctx, "new-checkout", def, ptr(1), "b")
	if err != nil || updated.Version != 2 {
		t.Fatalf("update: %+v %v", updated, err)
	}
	got, err := f.Get(ctx, "new-checkout")
	if err != nil || got.Version != 2 || got.UpdatedBy != "b" {
		t.Fatalf("get: %+v %v", got, err)
	}
	encoded, _ := json.Marshal(got)
	want := `{"key":"new-checkout","description":"","enabled":true,"public":true,"rollout":50,"subjects":["vip","beta"],"updatedAt":"2026-01-02T02:04:05.678Z","updatedBy":"b","version":2}`
	if string(encoded) != want {
		t.Fatalf("JSON\n got %s\nwant %s", encoded, want)
	}
}

func TestLimitsCountUTF16Units(t *testing.T) {
	f := New(nosql.NewMemoryStore())
	cases := map[string]func(*Definition){
		"401 chars":        func(d *Definition) { d.Description = strings.Repeat("x", 401) },
		"201 emoji":        func(d *Definition) { d.Description = strings.Repeat("😀", 201) },
		"101 subjects":     func(d *Definition) { d.Subjects = make([]string, 101) },
		"subject 121":      func(d *Definition) { d.Subjects = []string{strings.Repeat("s", 121)} },
		"rollout 101":      func(d *Definition) { d.Rollout = 101 },
		"rollout negative": func(d *Definition) { d.Rollout = -1 },
	}
	for name, change := range cases {
		def := valid()
		change(&def)
		if _, err := f.Save(ctx, "f", def, nil, "a"); !errors.Is(err, ErrInvalidConfig) {
			t.Errorf("%s: got %v", name, err)
		}
	}
	for _, version := range []int{0, -1} {
		if _, err := f.Save(ctx, "f", valid(), ptr(version), "a"); !errors.Is(err, ErrInvalidConfig) {
			t.Errorf("version %d: got %v", version, err)
		}
	}
	def := valid()
	def.Description = strings.Repeat("😀", 200)
	def.Subjects = []string{strings.Repeat("é", 120)}
	def.Rollout = 12.5
	if _, err := f.Save(ctx, "f", def, nil, "a"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.Enabled(ctx, "f", strings.Repeat("😀", 61), false); !errors.Is(err, ErrInvalidSubject) {
		t.Fatalf("122-unit subject: %v", err)
	}
}

// The contract's recorded buckets: rollouts are deterministic across languages.
func TestBucketsMatchReference(t *testing.T) {
	store := nosql.NewMemoryStore()
	f := New(store)
	for key, rollout := range map[string]float64{"half": 50, "tiny": 3.7} {
		def := valid()
		def.Rollout = rollout
		if _, err := f.Save(ctx, key, def, nil, "a"); err != nil {
			t.Fatal(err)
		}
	}
	cases := []struct {
		key, subject string
		want         bool
	}{
		{"half", "alice", false}, {"half", "bob", true}, {"half", "carol", true}, {"half", "dave", false},
		{"half", "erin", false}, {"half", "user-1", false}, {"half", "user-2", true}, {"half", "josé", false},
		{"half", "用户", false}, {"half", "😀", true}, {"tiny", "user-1", false}, {"tiny", "user-7", false},
		{"tiny", "user-42", false}, {"tiny", "user-3", true}, {"tiny", "user-74", true},
		{"half", "", false}, {"missing", "bob", false},
	}
	for _, c := range cases {
		got, err := f.Enabled(ctx, c.key, c.subject, false)
		if err != nil || got != c.want {
			t.Errorf("Enabled(%q, %q) = %v, %v; want %v", c.key, c.subject, got, err, c.want)
		}
	}
}

func TestEvaluationRules(t *testing.T) {
	f := New(nosql.NewMemoryStore())
	private := valid()
	private.Public, private.Rollout, private.Subjects = false, 0, []string{"vip"}
	if _, err := f.Save(ctx, "beta", private, nil, "a"); err != nil {
		t.Fatal(err)
	}
	check := func(subject string, publicOnly, want bool) {
		t.Helper()
		if got, err := f.Enabled(ctx, "beta", subject, publicOnly); err != nil || got != want {
			t.Errorf("Enabled(beta, %q, %v) = %v, %v", subject, publicOnly, got, err)
		}
	}
	check("vip", false, true)
	check("someone", false, false)
	check("", false, false)
	check("vip", true, false)
	if _, err := f.Enabled(ctx, "Bad Key", "", false); !errors.Is(err, ErrInvalidKey) {
		t.Fatalf("bad key: %v", err)
	}
}

func TestLooseDecoding(t *testing.T) {
	invalid := []string{
		`{"version":null}`,
		`{"description":"","enabled":"yes","public":false,"rollout":0,"subjects":[]}`,
		`{"description":"","enabled":true,"public":1,"rollout":0,"subjects":[]}`,
		`{"description":5,"enabled":true,"public":false,"rollout":0,"subjects":[]}`,
		`{"description":"","enabled":true,"public":false,"rollout":"50","subjects":[]}`,
		`{"description":"","enabled":true,"public":false,"rollout":true,"subjects":[]}`,
		`{"description":"","enabled":true,"public":false,"rollout":0,"subjects":"vip"}`,
		`{"description":"","enabled":true,"public":false,"rollout":0,"subjects":[1]}`,
		`[]`, `null`,
	}
	for _, raw := range invalid {
		if _, err := ParseDefinition(json.RawMessage(raw)); !errors.Is(err, ErrInvalidConfig) {
			t.Errorf("%s: got %v", raw, err)
		}
	}
	def, err := ParseDefinition(json.RawMessage(`{"description":"d","enabled":true,"public":false,"rollout":12.5,"subjects":["a"]}`))
	if err != nil || def.Rollout != 12.5 || def.Subjects[0] != "a" {
		t.Fatalf("valid definition: %+v %v", def, err)
	}
	for _, raw := range []string{`1.5`, `"1"`, `true`, `0`, `9007199254740992`} {
		if _, err := ParseVersion(json.RawMessage(raw)); !errors.Is(err, ErrInvalidConfig) {
			t.Errorf("version %s: got %v", raw, err)
		}
	}
	if v, err := ParseVersion(json.RawMessage(`null`)); v != nil || err != nil {
		t.Errorf("null version: %v %v", v, err)
	}
	if v, err := ParseVersion(json.RawMessage(`3`)); err != nil || *v != 3 {
		t.Errorf("version 3: %v %v", v, err)
	}
	if _, err := VersionFrom(nil, false); !errors.Is(err, ErrInvalidConfig) {
		t.Errorf("missing version: %v", err)
	}
	for _, raw := range []string{`42`, `null`, `true`} {
		if _, err := ParseSubject(json.RawMessage(raw)); !errors.Is(err, ErrInvalidSubject) {
			t.Errorf("subject %s: got %v", raw, err)
		}
	}
	if s, err := SubjectFrom(nil, false); s != "" || err != nil {
		t.Errorf("missing subject: %q %v", s, err)
	}
	if _, err := ParseKey(json.RawMessage(`1`)); !errors.Is(err, ErrInvalidKey) {
		t.Errorf("numeric key: %v", err)
	}
}

func ptr(n int) *int { return &n }
