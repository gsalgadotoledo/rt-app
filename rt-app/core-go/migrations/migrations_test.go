package migrations

import (
	"context"
	"errors"
	"math"
	"slices"
	"strings"
	"testing"
	"time"

	"rt.local/core-go/apperr"
	"rt.local/core-go/nosql"
)

var start = time.Date(2026, 9, 24, 10, 0, 0, 0, time.UTC)

type clock struct{ now time.Time }

func (c *clock) Now() time.Time { return c.now }

func currencies(calls *[]string) Module {
	rows := []nosql.Row{{PK: "CURRENCY", SK: "USD", Data: map[string]any{"code": "USD"}}, {PK: "CURRENCY", SK: "EUR", Data: map[string]any{"code": "EUR"}}}
	return Module{ID: "catalog", Migrations: []Migration{
		SchemaMigration("catalog"),
		{
			ID: "catalog:002", Checksum: "catalog-currencies-v1", Description: Text("Add supported currencies"),
			Up: func(ctx context.Context, c *Context) error {
				*calls = append(*calls, "up")
				_, err := c.EnsureRows(ctx, rows)
				return err
			},
			Down: func(ctx context.Context, c *Context) error {
				*calls = append(*calls, "down")
				for _, sk := range []string{"USD", "EUR"} {
					row, err := c.Store.Get(ctx, "CURRENCY", sk)
					if err != nil {
						return err
					}
					if row != nil {
						if err := c.Store.Transact(ctx, []nosql.Write{{Row: *row, Expected: nosql.Expect(row.Version), Delete: true}}); err != nil {
							return err
						}
					}
				}
				return nil
			},
		},
	}}
}

func options(store nosql.Store, c *clock, modules ...Module) Options {
	return Options{Store: store, Modules: modules, Owner: "runner-a", Clock: c.Now}
}

func keys(t *testing.T, store nosql.Store, pk string) []string {
	t.Helper()
	rows, err := listAll(context.Background(), store, pk)
	if err != nil {
		t.Fatal(err)
	}
	out := []string{}
	for _, r := range rows {
		out = append(out, r.SK)
	}
	return out
}

// must returns value, failing the test (through a panic) on an error.
func must[T any](value T, err error) T {
	if err != nil {
		panic(err)
	}
	return value
}

func wantError(t *testing.T, err error, message string) {
	t.Helper()
	if err == nil || err.Error() != message {
		t.Fatalf("error %v, want %q", err, message)
	}
}

func TestUpAppliesOnceInOrderAndReleases(t *testing.T) {
	ctx, store, c := context.Background(), nosql.NewMemoryStore(), &clock{start}
	var calls []string
	var logs []string
	o := options(store, c, currencies(&calls))
	o.Log = func(line string) { logs = append(logs, line) }
	r := must(NewRunner(o))
	if got := must(r.Up(ctx, Target{})); !slices.Equal(got, []string{"catalog:001", "catalog:002"}) {
		t.Fatal(got)
	}
	if got := must(r.Up(ctx, Target{})); len(got) != 0 || got == nil {
		t.Fatalf("second run %#v", got)
	}
	if !slices.Equal(calls, []string{"up"}) || !slices.Equal(logs, []string{"migrating catalog:001", "migrating catalog:002"}) {
		t.Fatal(calls, logs)
	}
	row := must(store.Get(ctx, "MIGRATIONS", "catalog:002"))
	if row.Version != 1 || row.Data["checksum"] != "catalog-currencies-v1" || row.Data["provider"] != "memory" || row.Data["appliedAt"] != "2026-09-24T10:00:00.000Z" {
		t.Fatal(row)
	}
	if len(keys(t, store, "MIGRATION_LOCKS")) != 0 {
		t.Fatal("lock kept")
	}
	status := must(r.Status(ctx))
	if status[0].State != "applied" || status[0].Reversible || !status[1].Reversible {
		t.Fatal(status)
	}
}

func TestStepToAndDown(t *testing.T) {
	ctx, store, c := context.Background(), nosql.NewMemoryStore(), &clock{start}
	var calls []string
	r := must(NewRunner(options(store, c, currencies(&calls))))
	one, zero, two := 1, 0, 2
	if got := must(r.Up(ctx, Target{Step: &one})); !slices.Equal(got, []string{"catalog:001"}) {
		t.Fatal(got)
	}
	_, err := r.Up(ctx, Target{To: "catalog:001"})
	wantError(t, err, `Couldn't find migration to apply with name "catalog:001"`)
	if got := must(r.Up(ctx, Target{To: "catalog:002", Step: &zero})); !slices.Equal(got, []string{"catalog:002"}) {
		t.Fatal(got)
	}
	_, err = r.Down(ctx, Target{Step: &two})
	wantError(t, err, "Irreversible migrations: catalog:001")
	if got := must(r.Down(ctx, Target{})); !slices.Equal(got, []string{"catalog:002"}) {
		t.Fatal(got)
	}
	if len(keys(t, store, "CURRENCY")) != 0 || !slices.Equal(calls, []string{"up", "down"}) {
		t.Fatal(calls)
	}
	_, err = r.Down(ctx, Target{To: "catalog:002"})
	wantError(t, err, "Migration is not applied: catalog:002")
	_, err = r.Down(ctx, Target{To: "catalog:001"})
	wantError(t, err, "Irreversible migrations: catalog:001")
}

func TestPlanValidation(t *testing.T) {
	store, c := nosql.NewMemoryStore(), &clock{start}
	noop := func(context.Context, *Context) error { return nil }
	cases := map[string][]Module{
		"Invalid migration id: no-module (expected module:name)": {{ID: "x", Migrations: []Migration{{ID: "no-module", Checksum: "1", Up: noop}}}},
		"Invalid migration id: x:1\n (expected module:name)":     {{ID: "x", Migrations: []Migration{{ID: "x:1\n", Checksum: "1", Up: noop}}}},
		"Invalid migration id: x:\u212a (expected module:name)":  {{ID: "x", Migrations: []Migration{{ID: "x:\u212a", Checksum: "1", Up: noop}}}},
		"Duplicate migration id: a:1":                            {{ID: "a", Migrations: []Migration{{ID: "a:1", Checksum: "1", Up: noop}, {ID: "a:1", Checksum: "1", Up: noop}}}},
		"Unsupported migration a:1 for memory":                   {{ID: "a", Migrations: []Migration{{ID: "a:1", Checksum: "1", Up: noop, Providers: map[string]Step{"memory": {Checksum: "2"}}}}}},
		"Migration without checksum: a:1":                        {{ID: "a", Migrations: []Migration{{ID: "a:1", Up: noop}}}},
	}
	for message, modules := range cases {
		_, err := NewRunner(options(store, c, modules...))
		wantError(t, err, message)
	}
	long := "m:" + strings.Repeat("a", 198)
	must(NewRunner(options(store, c, Module{ID: "m", Migrations: []Migration{{ID: long, Checksum: "1", Up: noop}}})))
	_, err := NewRunner(options(store, c, Module{ID: "m", Migrations: []Migration{{ID: long + "a", Checksum: "1", Up: noop}}}))
	wantError(t, err, "Invalid migration id: "+long+"a (expected module:name)")
	o := options(store, c)
	o.Environment = "qa"
	_, err = NewRunner(o)
	wantError(t, err, "Unknown environment: qa")
	_, err = NewRunner(Options{Store: struct{ nosql.Store }{store}})
	wantError(t, err, "Unknown store provider: set Options.Provider")
}

func TestProviderOverridesAndChecksums(t *testing.T) {
	ctx, store, c := context.Background(), nosql.NewMemoryStore(), &clock{start}
	var used []string
	module := Module{ID: "idx", Migrations: []Migration{{
		ID: "idx:001", Checksum: "generic",
		Up:        func(context.Context, *Context) error { used = append(used, "generic"); return nil },
		Providers: map[string]Step{"dynamodb": {Run: func(context.Context, nosql.Store) error { used = append(used, "dynamo"); return nil }}},
	}}}
	o := options(store, c, module)
	o.Provider = "dynamodb"
	must(Migrate(ctx, o))
	if !slices.Equal(used, []string{"dynamo"}) {
		t.Fatal(used)
	}
	row := must(store.Get(ctx, "MIGRATIONS", "idx:001"))
	if row.Data["checksum"] != "generic" || row.Data["provider"] != "dynamodb" {
		t.Fatal(row)
	}
	// The same provider-specific history seen from another engine is a change.
	o.Provider = ""
	o.Modules[0].Migrations[0].Providers = map[string]Step{"memory": {Up: func(context.Context, *Context) error { return nil }}}
	_, err := must(NewRunner(o)).Up(ctx, Target{})
	wantError(t, err, "Migration changed: idx:001")
	// A numeric checksum is not the declared string.
	store2 := nosql.NewMemoryStore()
	_ = store2.Transact(ctx, []nosql.Write{{Row: nosql.Row{PK: "MIGRATIONS", SK: "catalog:001", Version: 1, Data: map[string]any{"checksum": 1.0}}}})
	_, err = Migrate(ctx, options(store2, c, Module{ID: "catalog", Migrations: []Migration{{ID: "catalog:001", Checksum: "1", Up: func(context.Context, *Context) error { return nil }}}}))
	wantError(t, err, "Migration changed: catalog:001")
	if len(keys(t, store2, "MIGRATION_LOCKS")) != 0 {
		t.Fatal("a failed verification must release the lock")
	}
}

func TestFailuresAndLease(t *testing.T) {
	ctx, store, c := context.Background(), nosql.NewMemoryStore(), &clock{start}
	fail := true
	module := Module{ID: "flaky", Migrations: []Migration{
		SchemaMigration("flaky"),
		{ID: "flaky:002", Checksum: "2", Up: func(context.Context, *Context) error {
			if fail {
				return errors.New("provider unavailable")
			}
			return nil
		}},
	}}
	_, err := Migrate(ctx, options(store, c, module))
	wantError(t, err, "Migration flaky:002 (up) failed: Original error: provider unavailable")
	var stepErr *StepError
	if !errors.As(err, &stepErr) || stepErr.ID != "flaky:002" {
		t.Fatal(err)
	}
	if !slices.Equal(keys(t, store, "MIGRATIONS"), []string{"flaky:001"}) || len(keys(t, store, "MIGRATION_LOCKS")) != 0 {
		t.Fatal("partial history")
	}
	fail = false
	if got := must(Migrate(ctx, options(store, c, module))); !slices.Equal(got, []string{"flaky:002"}) {
		t.Fatal(got)
	}

	// A lease stolen during a step: the history write fails and nothing is recorded.
	store = nosql.NewMemoryStore()
	steal := Module{ID: "lease", Migrations: []Migration{{ID: "lease:1", Checksum: "1", Up: func(ctx context.Context, x *Context) error {
		lock, _ := x.Store.Get(ctx, "MIGRATION_LOCKS", "migrations")
		lock.Data["owner"] = "intruder"
		return x.Store.Transact(ctx, []nosql.Write{{Row: nosql.Row{PK: lock.PK, SK: lock.SK, Version: lock.Version + 1, Data: lock.Data}, Expected: nosql.Expect(lock.Version)}})
	}}}}
	_, err = Migrate(ctx, options(store, c, steal))
	if !apperr.IsConflict(err) {
		t.Fatal(err)
	}
	if len(keys(t, store, "MIGRATIONS")) != 0 {
		t.Fatal("recorded after losing the lease")
	}
	lock := must(store.Get(ctx, "MIGRATION_LOCKS", "migrations"))
	if lock.Data["owner"] != "intruder" {
		t.Fatal(lock)
	}
	// A live lock refuses; an expired one is taken over.
	_, err = Migrate(ctx, options(store, c, steal))
	wantError(t, err, "Migrations are already running (intruder, lock expires 2026-09-24T10:15:00.000Z)")
	var locked *LockedError
	if !errors.As(err, &locked) || locked.Holder != "intruder" {
		t.Fatal(err)
	}
	c.now = start.Add(15 * time.Minute)
	noop := Module{ID: "lease", Migrations: []Migration{{ID: "lease:1", Checksum: "1", Up: func(context.Context, *Context) error { return nil }}}}
	if got := must(Migrate(ctx, options(store, c, noop))); !slices.Equal(got, []string{"lease:1"}) {
		t.Fatal(got)
	}
}

func TestNestedRunnerIsLockedOut(t *testing.T) {
	ctx, store, c := context.Background(), nosql.NewMemoryStore(), &clock{start}
	var nested error
	module := Module{ID: "slow", Migrations: []Migration{{ID: "slow:1", Checksum: "1", Up: func(ctx context.Context, _ *Context) error {
		o := options(store, c)
		o.Owner = "runner-b"
		_, nested = Migrate(ctx, o)
		return nil
	}}}}
	must(Migrate(ctx, options(store, c, module)))
	wantError(t, nested, "Migrations are already running (runner-a, lock expires 2026-09-24T10:15:00.000Z)")
}

func TestEnsureRows(t *testing.T) {
	ctx, store := context.Background(), nosql.NewMemoryStore()
	_ = store.Transact(ctx, []nosql.Write{{Row: nosql.Row{PK: "P", SK: "a", Version: 4, Data: map[string]any{"n": 99.0}}}})
	c := NewContext(store, "memory", "local", nil)
	ttl := int64(4102444800)
	got := must(c.EnsureRows(ctx, []nosql.Row{{PK: "P", SK: "a"}, {PK: "P", SK: "b", TTL: &ttl, Version: 9}}))
	if !slices.Equal(got, []string{"P/b"}) {
		t.Fatal(got)
	}
	row := must(store.Get(ctx, "P", "b"))
	if row.Version != 1 || row.TTL == nil || *row.TTL != ttl {
		t.Fatal(row)
	}
	if must(store.Get(ctx, "P", "a")).Data["n"] != 99.0 {
		t.Fatal("overwritten")
	}
}

func TestSeeds(t *testing.T) {
	ctx, store, c := context.Background(), nosql.NewMemoryStore(), &clock{start}
	var log []string
	modules := []Module{
		{ID: "users", Seeds: []Seed{{ID: "users:demo", Run: func(_ context.Context, s *SeedContext) error {
			v, err := s.Secret("DEMO_PASSWORD")
			log = append(log, "users:"+v)
			return err
		}}}},
		{ID: "catalog", Seeds: []Seed{
			{ID: "catalog:currencies", Environments: Environments, Run: func(context.Context, *SeedContext) error { log = append(log, "currencies"); return nil }},
			{ID: "catalog:products", Run: func(_ context.Context, s *SeedContext) error {
				v, err := s.Service("users")
				log = append(log, "products")
				_ = v
				return err
			}},
		}},
	}
	o := options(store, c, modules...)
	o.Environment = "prod"
	o.Secrets = map[string]string{"DEMO_PASSWORD": "x"}
	o.Services = map[string]any{"users": 1}
	if got := must(must(NewSeedRunner(o)).Run(ctx, RunOptions{})); !slices.Equal(got, []string{"catalog:currencies"}) {
		t.Fatal(got)
	}
	o.Environment = "stage"
	r := must(NewSeedRunner(o))
	if got := must(r.Run(ctx, RunOptions{})); !slices.Equal(got, []string{"users:demo", "catalog:products"}) {
		t.Fatal(got)
	}
	if got := must(r.Run(ctx, RunOptions{Modules: []string{"users"}, Rerun: true})); !slices.Equal(got, []string{"users:demo"}) {
		t.Fatal(got)
	}
	if row := must(store.Get(ctx, "SEEDS", "users:demo")); row.Version != 2 || row.Data["version"] != "1" || row.Data["environment"] != "stage" {
		t.Fatal(row)
	}
	if got := must(r.Run(ctx, RunOptions{Modules: []string{}})); len(got) != 0 {
		t.Fatal(got)
	}
	_, err := r.Run(ctx, RunOptions{Modules: []string{"billing"}})
	wantError(t, err, "Unknown module: billing")
	o.Secrets = map[string]string{"DEMO_PASSWORD": ""}
	_, err = must(NewSeedRunner(o)).Run(ctx, RunOptions{Rerun: true})
	wantError(t, err, "Migration users:demo (up) failed: Original error: Seed users:demo requires DEMO_PASSWORD")
	modules[1].Seeds[1].Version = "2"
	status := must(must(NewSeedRunner(o)).Status(ctx))
	if status[2].State != "changed" || status[0].State != "applied" {
		t.Fatal(status)
	}
	o.Modules = []Module{{ID: "x", Seeds: []Seed{{ID: "x:a", Environments: []string{}}}}}
	_, err = NewSeedRunner(o)
	wantError(t, err, "Invalid environments for seed x:a")
}

func TestJSHelpers(t *testing.T) {
	for n, want := range map[int]int{-1: 2, -5: 0, 1: 1, 9: 3} {
		if got := jsSlice(n, 3); got != want {
			t.Fatal(n, got)
		}
	}
	if jsonString("say \"hi\" <\u2028>") != "\"say \\\"hi\\\" <\u2028>\"" {
		t.Fatal(jsonString("say \"hi\" <\u2028>"))
	}
	if _, ok := dateMs("soon"); ok {
		t.Fatal("soon is not a date")
	}
	if ms, ok := dateMs("2026-09-24T10:00:00.000Z"); !ok || ms != start.UnixMilli() {
		t.Fatal(ms)
	}
	if !math.IsNaN(Number("x")) {
		t.Fatal("NaN")
	}
}
