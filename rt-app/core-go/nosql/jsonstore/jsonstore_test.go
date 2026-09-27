package jsonstore

import (
	"context"
	"errors"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"rt.local/core-go/apperr"
	"rt.local/core-go/nosql"
	"rt.local/core-go/nosql/nosqltest"
)

func TestStoreSuite(t *testing.T) {
	nosqltest.Run(t, func(t *testing.T) nosql.Store { return New(filepath.Join(t.TempDir(), "db.json")) })
}

func row(sk string, version int, data map[string]any) nosql.Row {
	if data == nil {
		data = map[string]any{}
	}
	return nosql.Row{PK: "p", SK: sk, Version: version, Data: data}
}

func read(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func TestFileFormatMatchesTypeScript(t *testing.T) {
	ctx := t.Context()
	path := filepath.Join(t.TempDir(), "db.json")
	s := New(path)
	must(t, s.Transact(ctx, []nosql.Write{{Row: row("b", 1, map[string]any{"name": "B"})}, {Row: row("a", 1, nil)}}))
	must(t, s.Transact(ctx, []nosql.Write{{Row: row("b", 2, map[string]any{"s": "\u2028<>&\x7f\x01", "n": 1e21, "m": 1e-7, "10": true, "9": false}), Expected: nosql.Expect(1)}, {Row: row("c", 1, nil)}}))
	want := `{"format":1,"rows":[{"pk":"p","sk":"b","version":2,"data":{"9":false,"10":true,"m":1e-7,"n":1e+21,"s":"` + "\u2028<>&\x7f" + `\u0001"}},{"pk":"p","sk":"a","version":1,"data":{}},{"pk":"p","sk":"c","version":1,"data":{}}]}`
	if got := read(t, path); got != want {
		t.Fatalf("file:\n%s\nwant:\n%s", got, want)
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", info.Mode())
	}
	entries, _ := os.ReadDir(filepath.Dir(path))
	if len(entries) != 1 {
		t.Fatalf("leftover files: %v", entries)
	}
}

func TestTypeScriptFilesAreNormalizedAndKeepUnknownFields(t *testing.T) {
	ctx := t.Context()
	path := filepath.Join(t.TempDir(), "db.json")
	text := `{"note":1,"rows":[{"data":{"b":1.0,"2":[1E21,-0],"b":2},"version":1.0,"sk":"a","pk":"p","extra":{"y":1,"x":2},"ttl":4102444800}],"format":1.0}`
	must(t, os.WriteFile(path, []byte(text), 0o644))
	s := New(path)
	got, err := s.Get(ctx, "p", "a")
	if err != nil || got == nil || got.Data["b"] != 2.0 || got.TTL == nil || *got.TTL != 4102444800 {
		t.Fatalf("get = %+v, %v", got, err)
	}
	if read(t, path) != text {
		t.Fatal("reads must not rewrite the file")
	}
	must(t, s.Transact(ctx, []nosql.Write{{Row: row("b", 1, nil)}}))
	want := `{"format":1,"rows":[{"data":{"2":[1e+21,0],"b":2},"version":1,"sk":"a","pk":"p","extra":{"y":1,"x":2},"ttl":4102444800},{"pk":"p","sk":"b","version":1,"data":{}}]}`
	if got := read(t, path); got != want {
		t.Fatalf("file:\n%s\nwant:\n%s", got, want)
	}
}

func TestFailuresLeaveTheFileUntouched(t *testing.T) {
	ctx := t.Context()
	path := filepath.Join(t.TempDir(), "db.json")
	s := New(path)
	must(t, s.Transact(ctx, []nosql.Write{{Row: row("a", 1, nil)}}))
	before := read(t, path)
	if err := s.Transact(ctx, []nosql.Write{{Row: row("b", 1, nil)}, {Row: row("a", 2, nil), Expected: nosql.Expect(5)}}); !isConflict(err) {
		t.Fatal(err)
	}
	if err := s.Transact(ctx, []nosql.Write{{Row: nosql.Row{PK: "p", SK: "x", Version: 1}}}); !errors.Is(err, ErrInvalidRow) {
		t.Fatal(err)
	}
	if err := s.Transact(ctx, []nosql.Write{{Row: row("x", 1, nil)}, {Row: row("x", 1, nil)}}); !errors.Is(err, nosql.ErrDuplicateKey) {
		t.Fatal(err)
	}
	if read(t, path) != before {
		t.Fatal("a failed transaction rewrote the file")
	}
}

func TestInvalidFilesFailClosed(t *testing.T) {
	ctx := t.Context()
	for text, want := range map[string]error{
		"broken":                    ErrInvalidDatabase,
		"null":                      ErrInvalidDatabase,
		`{"format":1,"rows":[]} []`: ErrInvalidDatabase,
		`{"format":true,"rows":[]}`: ErrInvalidDatabase,
		`{"format":1,"rows":[{"pk":"a","sk":"b","version":9007199254740992,"data":{}}]}`:                            ErrInvalidDatabase,
		`{"format":1,"rows":[{"pk":"a","sk":"b","version":1,"data":{}},{"pk":"a","sk":"b","version":1,"data":{}}]}`: ErrDuplicateDatabaseKey,
	} {
		path := filepath.Join(t.TempDir(), "db.json")
		must(t, os.WriteFile(path, []byte(text), 0o600))
		if err := New(path).Transact(ctx, nil); !errors.Is(err, want) {
			t.Fatalf("%s: %v", text, err)
		}
		if read(t, path) != text {
			t.Fatalf("%s was rewritten", text)
		}
		if _, err := os.Stat(path + ".lock"); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("the lock must be released")
		}
	}
}

func TestStaleLocksTimeOut(t *testing.T) {
	path := filepath.Join(t.TempDir(), "db.json")
	must(t, os.WriteFile(path+".lock", nil, 0o600))
	_, err := New(path, WithLockTimeout(30*time.Millisecond)).Get(t.Context(), "p", "a")
	if err == nil || !regexp.MustCompile(`^JSON store locked: /.*db\.json\.lock\. Stop writers before removing a stale lock\.$`).MatchString(err.Error()) {
		t.Fatal(err)
	}
	if _, err := os.Stat(path + ".lock"); err != nil {
		t.Fatal("a stale lock must stay")
	}
}

func TestRetentionUsesTheClockOnWrites(t *testing.T) {
	ctx := t.Context()
	path := filepath.Join(t.TempDir(), "db.json")
	now := time.UnixMilli(10_000)
	s := New(path, WithClock(func() time.Time { return now }))
	ttl := func(n int64) *int64 { return &n }
	must(t, s.Transact(ctx, []nosql.Write{
		{Row: nosql.Row{PK: "CACHE#a", SK: "x", Version: 1, Data: map[string]any{}, TTL: ttl(10)}},
		{Row: nosql.Row{PK: "CACHE#a", SK: "y", Version: 1, Data: map[string]any{}, TTL: ttl(11)}},
		{Row: nosql.Row{PK: "USERS", SK: "u", Version: 1, Data: map[string]any{}, TTL: ttl(1)}},
	}))
	page, _ := s.List(ctx, "CACHE#a", "")
	if len(page.Items) != 1 || page.Items[0].SK != "y" {
		t.Fatalf("%+v", page)
	}
	now = time.UnixMilli(11_000)
	if got, _ := s.Get(ctx, "CACHE#a", "y"); got == nil {
		t.Fatal("reads never drop rows")
	}
	must(t, s.Transact(ctx, nil))
	if got, _ := s.Get(ctx, "CACHE#a", "y"); got != nil {
		t.Fatal("expired row kept")
	}
	if got, _ := s.Get(ctx, "USERS", "u"); got == nil {
		t.Fatal("application rows are never dropped")
	}
}

func TestStringNumbersFollowJavaScript(t *testing.T) {
	for text, want := range map[string]float64{"100": 100, " 7 ": 7, "0x10": 16, "0b11": 3, "0o7": 7, "": 0, "1e3": 1000, ".5": 0.5, "5.": 5, "-Infinity": math.Inf(-1)} {
		if got := stringNumber(text); got != want {
			t.Errorf("Number(%q) = %v, want %v", text, got, want)
		}
	}
	for _, text := range []string{"soon", "1_0", "inf", "-0x1", "0x", "1e", "NaN"} {
		if got := stringNumber(text); !math.IsNaN(got) {
			t.Errorf("Number(%q) = %v, want NaN", text, got)
		}
	}
}

func TestConcurrentWritersAndProcessesCreateOnce(t *testing.T) {
	ctx := t.Context()
	path := filepath.Join(t.TempDir(), "db.json")
	var wg sync.WaitGroup
	results := make([]error, 4)
	for i := range results {
		wg.Go(func() { results[i] = New(path).Transact(ctx, []nosql.Write{{Row: row("once", 1, nil)}}) })
	}
	wg.Wait()
	committed := 0
	for _, err := range results {
		if err == nil {
			committed++
		} else if !isConflict(err) {
			t.Fatal(err)
		}
	}
	if committed != 1 {
		t.Fatalf("%d writers committed", committed)
	}
	if os.Getenv("JSONSTORE_CHILD") == "" {
		// Two processes race for another row.
		exe, _ := os.Executable()
		codes := make([]int, 2)
		for i := range codes {
			wg.Go(func() {
				cmd := exec.Command(exe, "-test.run", "^TestChildWriter$")
				cmd.Env = append(os.Environ(), "JSONSTORE_CHILD="+path)
				if err := cmd.Run(); err != nil {
					var exit *exec.ExitError
					if errors.As(err, &exit) {
						codes[i] = exit.ExitCode()
					}
				}
			})
		}
		wg.Wait()
		if codes[0]+codes[1] != 1 {
			t.Fatalf("exit codes %v: exactly one process must fail", codes)
		}
	}
}

// TestChildWriter runs in a child process of TestConcurrentWritersAndProcessesCreateOnce.
func TestChildWriter(t *testing.T) {
	path := os.Getenv("JSONSTORE_CHILD")
	if path == "" {
		t.Skip("child process only")
	}
	if err := New(path).Transact(context.Background(), []nosql.Write{{Row: row("process", 1, nil)}}); err != nil {
		t.Fatal(err)
	}
}

func TestLocalSecret(t *testing.T) {
	database := filepath.Join(t.TempDir(), "nested", "local.json")
	first, err := LocalSecret(database)
	if err != nil || !regexp.MustCompile(`^[a-f0-9]{96}$`).MatchString(first) {
		t.Fatal(first, err)
	}
	if again, _ := LocalSecret(database); again != first {
		t.Fatal("the key must be stable")
	}
	info, _ := os.Stat(database + ".key")
	dir, _ := os.Stat(filepath.Dir(database))
	if info.Mode().Perm() != 0o600 || dir.Mode().Perm() != 0o700 {
		t.Fatal(info.Mode(), dir.Mode())
	}
	if _, err := os.Stat(database); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("the database must not be created")
	}
	for _, broken := range []string{"broken", first + "\n", strings.ToUpper(first), ""} {
		must(t, os.WriteFile(database+".key", []byte(broken), 0o600))
		if _, err := LocalSecret(database); !errors.Is(err, ErrInvalidSecret) {
			t.Fatalf("%q: %v", broken, err)
		}
	}
}

func isConflict(err error) bool {
	httpErr, ok := apperr.As(err)
	return ok && httpErr.Status == 409
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
