package migrations

import (
	"bytes"
	"context"
	"math"
	"slices"
	"strings"
	"testing"

	"rt.local/core-go/nosql"
)

func cliApp(environment string) (App, *nosql.MemoryStore) {
	store := nosql.NewMemoryStore()
	noop := func(context.Context, *Context) error { return nil }
	return NewApp(Options{
		Store: store, Environment: environment, Owner: "runner-a", Clock: (&clock{start}).Now,
		Modules: []Module{{
			ID: "catalog",
			Migrations: []Migration{
				SchemaMigration("catalog"),
				{ID: "catalog:002", Checksum: "2", Description: Text("Currencies"), Up: noop, Down: noop},
			},
			Seeds: []Seed{{ID: "catalog:demo", Description: Text("Demo products"), Run: func(_ context.Context, s *SeedContext) error {
				_, err := s.Secret("DEMO_PASSWORD")
				return err
			}}},
		}},
	}), store
}

func run(t *testing.T, fn func(out func(string)) error) ([]string, error) {
	t.Helper()
	lines := []string{}
	err := fn(func(line string) { lines = append(lines, line) })
	return lines, err
}

func TestMigrateCommand(t *testing.T) {
	ctx := context.Background()
	a, store := cliApp("")
	migrate := func(argv ...string) []string {
		t.Helper()
		lines, err := run(t, func(out func(string)) error { return MigrateCommand(ctx, a, argv, out) })
		if err != nil {
			t.Fatal(argv, err)
		}
		return lines
	}
	want := func(got []string, want ...string) {
		t.Helper()
		if !slices.Equal(got, want) {
			t.Fatalf("got %q, want %q", got, want)
		}
	}
	want(migrate(), "Migrations (local):", "  pending  catalog:001 — Register the catalog document schema", "  pending  catalog:002 — Currencies", "2 pending. Run: rta migrate up")
	want(migrate("up", "--step", "0x1"), "  migrating catalog:001", "Applied: catalog:001")
	want(migrate("up", "--json"), `{"environment":"local","applied":["catalog:002"]}`)
	want(migrate("up"), "Nothing to apply.")
	want(migrate("status")[3:], "Up to date.")
	want(migrate("down", "--to", "catalog:002"), "  reverting catalog:002", "Reverted: catalog:002")
	want(migrate("down", "--json", "--step", ""), `{"environment":"local","reverted":[]}`)
	status := migrate("status", "--json")[0]
	if !strings.HasPrefix(status, "{\n  \"environment\": \"local\",\n  \"migrations\": [\n    {\n      \"id\": \"catalog:001\",") {
		t.Fatal(status)
	}
	for _, argv := range [][]string{{"sideways"}, {"up", "--step", "-1"}, {"up", "--step", "1.5"}, {"up", "--to"}, {"up", "--force"}, {"status", "--step", "1"}, {"up", "stray"}, {"--json", "up"}} {
		_, err := run(t, func(out func(string)) error { return MigrateCommand(ctx, a, argv, out) })
		wantError(t, err, MigrateUsage)
	}
	if len(keys(t, store, "MIGRATION_LOCKS")) != 0 {
		t.Fatal("lock kept")
	}
}

func TestSeedCommand(t *testing.T) {
	ctx := context.Background()
	a, _ := cliApp("stage")
	secrets := map[string]string{"DEMO_PASSWORD": "x"}
	lines, err := run(t, func(out func(string)) error { return SeedCommand(ctx, a, nil, map[string]string{}, out) })
	wantError(t, err, "Migration catalog:demo (up) failed: Original error: Seed catalog:demo requires DEMO_PASSWORD")
	if !slices.Equal(lines, []string{"  seeding catalog:demo"}) {
		t.Fatal(lines)
	}
	lines, _ = run(t, func(out func(string)) error {
		return SeedCommand(ctx, a, []string{"--module", " catalog ,"}, secrets, out)
	})
	if !slices.Equal(lines, []string{"  seeding catalog:demo", "Seeded: catalog:demo"}) {
		t.Fatal(lines)
	}
	lines, _ = run(t, func(out func(string)) error { return SeedCommand(ctx, a, []string{"run"}, secrets, out) })
	if !slices.Equal(lines, []string{"No pending seeds for stage."}) {
		t.Fatal(lines)
	}
	lines, _ = run(t, func(out func(string)) error { return SeedCommand(ctx, a, []string{"status"}, nil, out) })
	if !slices.Equal(lines, []string{"Seeds (stage):", "  applied  catalog:demo — Demo products"}) {
		t.Fatal(lines)
	}
	for _, argv := range [][]string{{"plant"}, {"status", "--rerun"}, {"--module"}, {"--everything"}} {
		_, err := run(t, func(out func(string)) error { return SeedCommand(ctx, a, argv, nil, out) })
		wantError(t, err, SeedUsage)
	}
	var stdout, stderr bytes.Buffer
	if code := RunCLI(ctx, a, []string{"migrate", "up"}, &stdout, &stderr); code != 0 || !strings.Contains(stdout.String(), "Applied: catalog:001, catalog:002") {
		t.Fatal(code, stdout.String(), stderr.String())
	}
	if code := RunCLI(ctx, a, []string{"migrate", "sideways"}, &stdout, &stderr); code != 1 || !strings.Contains(stderr.String(), MigrateUsage) {
		t.Fatal(code)
	}
}

func TestNumber(t *testing.T) {
	cases := map[string]float64{"": 0, " 1\n": 1, "0x1": 1, "0b10": 2, "0o7": 7, "1e0": 1, "+1.0": 1, ".5e1": 5, "1e21": 1e21, "Infinity": math.Inf(1), "\u00a02\ufeff": 2}
	for text, want := range cases {
		if got := Number(text); got != want {
			t.Errorf("Number(%q) = %v, want %v", text, got, want)
		}
	}
	for _, text := range []string{"-0x1", "1_0", "x", "1e", "--1", "0x", "\u200b1"} {
		if !math.IsNaN(Number(text)) {
			t.Errorf("Number(%q) should be NaN", text)
		}
	}
	if n := Number("-0"); n != 0 || !math.Signbit(n) {
		t.Error("-0")
	}
}
