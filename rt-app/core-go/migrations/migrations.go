// Package migrations runs module-owned migrations and seeds over a NoSQL store, the Go port of
// @gsalgadotoledo/rt-app-migrations (TypeScript is the reference; see
// spec/contracts/migrations.contract.yaml).
//
// History lives in the application store: MIGRATIONS/<id> {checksum, provider, appliedAt} and
// SEEDS/<id> {version, environment, appliedAt}. One runner at a time holds a lease row
// (MIGRATION_LOCKS/"migrations" or "seeds") that is renewed before every step, and every
// history write is committed in the same transaction as a renewal, so a runner that lost its
// lease records nothing. Checksums are opaque declared strings: history written by the
// TypeScript, Python and Go runners is interchangeable.
package migrations

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"

	"rt.local/core-go/internal/js"
	"rt.local/core-go/internal/uuid"
	"rt.local/core-go/nosql"
)

// Environments are the deployment environments a runner may use.
var Environments = []string{"local", "develop", "stage", "prod"}

// DefaultSeedEnvironments is where seeds without an explicit list run: never in prod.
var DefaultSeedEnvironments = []string{"local", "develop", "stage"}

// DefaultLockTTL is how long a crashed runner's lease blocks others.
const DefaultLockTTL = 15 * time.Minute

const (
	partitionMigrations = "MIGRATIONS"
	partitionSeeds      = "SEEDS"
	partitionLocks      = "MIGRATION_LOCKS"
)

// Context is what migration steps receive. Write through Store (the NoSQL contract) so the
// same step runs on every engine.
type Context struct {
	Store       nosql.Store
	Provider    string
	Environment string
	Log         func(string)
}

// NewContext returns a step context; a nil log discards messages.
func NewContext(store nosql.Store, provider, environment string, log func(string)) *Context {
	if log == nil {
		log = func(string) {}
	}
	return &Context{Store: store, Provider: provider, Environment: environment, Log: log}
}

// EnsureRows inserts the rows that do not exist yet (version 1, TTL kept) and returns the
// "pk/sk" keys it created. Existing rows are never overwritten; a failed create is ignored only
// when the row exists afterwards (another writer created it).
func (c *Context) EnsureRows(ctx context.Context, rows []nosql.Row) ([]string, error) {
	inserted := []string{}
	for _, row := range rows {
		existing, err := c.Store.Get(ctx, row.PK, row.SK)
		if err != nil {
			return inserted, err
		}
		if existing != nil {
			continue
		}
		create := nosql.Row{PK: row.PK, SK: row.SK, Version: 1, Data: row.Data, TTL: row.TTL}
		if err := c.Store.Transact(ctx, []nosql.Write{{Row: create}}); err != nil {
			again, getErr := c.Store.Get(ctx, row.PK, row.SK)
			if getErr != nil {
				return inserted, getErr
			}
			if again == nil {
				return inserted, err
			}
			continue
		}
		inserted = append(inserted, row.PK+"/"+row.SK)
	}
	return inserted, nil
}

// SeedContext is what seeds receive: the step context plus secrets and shared services.
// (The TypeScript faker() helper has no Go equivalent.)
type SeedContext struct {
	*Context
	seedID   string
	secrets  map[string]string
	services map[string]any
}

// Secret returns a required, non-empty secret such as DEMO_PASSWORD.
func (s *SeedContext) Secret(name string) (string, error) {
	value := s.secrets[name]
	if value == "" {
		return "", fmt.Errorf("Seed %s requires %s", s.seedID, name)
	}
	return value, nil
}

// Service returns a service another module shares with seeds.
func (s *SeedContext) Service(id string) (any, error) {
	value, ok := s.services[id]
	if !ok {
		return nil, fmt.Errorf("Seed %s requires the %s service", s.seedID, id)
	}
	return value, nil
}

// StepFunc is an up or down step.
type StepFunc func(ctx context.Context, c *Context) error

// Step is a provider override: it replaces the generic steps on that provider only. An empty
// Checksum keeps the migration's.
type Step struct {
	Checksum string
	Up       StepFunc
	Down     StepFunc
	// Run is the legacy run(store) form of Up.
	Run func(ctx context.Context, store nosql.Store) error
}

// Migration is a module-owned, versioned change. ID ("module:name") is permanent and its
// checksum must never change once applied. Without Down it is irreversible.
type Migration struct {
	ID          string
	Checksum    string
	Description *string
	Up          StepFunc
	Down        StepFunc
	// Run is the legacy run(store) form of Up.
	Run       func(ctx context.Context, store nosql.Store) error
	Providers map[string]Step
}

// Seed is example or reference data. It runs once per Version ("1" when empty) in the
// Environments it lists (DefaultSeedEnvironments when nil).
type Seed struct {
	ID           string
	Description  *string
	Version      string
	Environments []string
	Run          func(ctx context.Context, s *SeedContext) error
}

// Module is what a feature contributes: its id, migrations and seeds.
type Module struct {
	ID         string
	Migrations []Migration
	Seeds      []Seed
}

// Text returns a pointer to s, for Description fields.
func Text(s string) *string { return &s }

// SchemaMigration is the first migration of every document module: SCHEMA/<module>
// {schemaVersion: 1}, written once.
func SchemaMigration(module string) Migration {
	return Migration{
		ID:          module + ":001",
		Checksum:    module + "-document-v1",
		Description: Text("Register the " + module + " document schema"),
		Up: func(ctx context.Context, c *Context) error {
			existing, err := c.Store.Get(ctx, "SCHEMA", module)
			if err != nil || existing != nil {
				return err
			}
			return c.Store.Transact(ctx, []nosql.Write{{Row: nosql.Row{PK: "SCHEMA", SK: module, Version: 1, Data: map[string]any{"schemaVersion": 1}}}})
		},
	}
}

// Options configure a runner.
type Options struct {
	Store   nosql.Store
	Modules []Module
	// Environment is local, develop, stage or prod ("" means local).
	Environment string
	// Owner identifies this process in lock messages ("" means "rt-app-" + a random UUID).
	Owner string
	// LockTTL is when a crashed runner's lease can be taken over (0 means DefaultLockTTL).
	LockTTL time.Duration
	Clock   func() time.Time
	Log     func(string)
	// Secrets are what seeds read with Secret (e.g. DEMO_PASSWORD).
	Secrets map[string]string
	// Services are what seeds read with Service.
	Services map[string]any
	// Provider is the engine name recorded in history and used to pick overrides. When empty:
	// the store's Provider() method, else "memory" for *nosql.MemoryStore.
	Provider string
}

type settings struct {
	Options
	provider string
}

func resolve(o Options) (settings, error) {
	if o.Environment == "" {
		o.Environment = "local"
	}
	if !slices.Contains(Environments, o.Environment) {
		return settings{}, errors.New("Unknown environment: " + o.Environment)
	}
	if o.Owner == "" {
		o.Owner = "rt-app-" + uuid.New()
	}
	if o.LockTTL == 0 {
		o.LockTTL = DefaultLockTTL
	}
	if o.Clock == nil {
		o.Clock = time.Now
	}
	if o.Log == nil {
		o.Log = func(string) {}
	}
	provider := o.Provider
	if provider == "" {
		if p, ok := o.Store.(interface{ Provider() string }); ok {
			provider = p.Provider()
		} else if _, ok := o.Store.(*nosql.MemoryStore); ok {
			provider = "memory"
		} else {
			return settings{}, errors.New("Unknown store provider: set Options.Provider")
		}
	}
	return settings{Options: o, provider: provider}, nil
}

// LockedError means another runner holds a live lease.
type LockedError struct {
	Holder    string
	ExpiresAt string
}

func (e *LockedError) Error() string {
	return fmt.Sprintf("Migrations are already running (%s, lock expires %s)", e.Holder, e.ExpiresAt)
}

// StepError is a failed step; nothing was recorded for it.
type StepError struct {
	ID        string
	Direction string // "up" or "down"
	Cause     error
}

func (e *StepError) Error() string {
	return fmt.Sprintf("Migration %s (%s) failed: Original error: %s", e.ID, e.Direction, e.Cause.Error())
}

func (e *StepError) Unwrap() error { return e.Cause }

var idPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]*:[a-zA-Z0-9][a-zA-Z0-9._-]*$`)

// moduleOf validates "module:name" (ASCII, at most 200 UTF-16 units) and returns the module.
func moduleOf(id, kind string) (string, error) {
	if !idPattern.MatchString(id) || js.Len(id) > 200 {
		return "", fmt.Errorf("Invalid %s id: %s (expected module:name)", kind, id)
	}
	return id[:strings.IndexByte(id, ':')], nil
}

func listAll(ctx context.Context, store nosql.Store, pk string) ([]nosql.Row, error) {
	rows := []nosql.Row{}
	cursor := ""
	for {
		page, err := store.List(ctx, pk, cursor)
		if err != nil {
			return nil, err
		}
		rows = append(rows, page.Items...)
		cursor = page.Cursor
		if cursor == "" {
			return rows, nil
		}
	}
}

type history struct {
	rows []nosql.Row
	byID map[string]nosql.Row
}

func readHistory(ctx context.Context, store nosql.Store, pk string) (history, error) {
	rows, err := listAll(ctx, store, pk)
	if err != nil {
		return history{}, err
	}
	h := history{rows: rows, byID: map[string]nosql.Row{}}
	for _, row := range rows {
		h.byID[row.SK] = row
	}
	return h, nil
}

func isoTime(ms int64) string {
	return time.UnixMilli(ms).UTC().Format("2006-01-02T15:04:05.000Z")
}

// jsSlice is the end index of Array.prototype.slice(0, n) on a list of length size.
func jsSlice(n, size int) int {
	if n < 0 {
		return max(size+n, 0)
	}
	return min(n, size)
}

// dateMs reads a stored instant like new Date(value): ISO strings or epoch milliseconds.
func dateMs(value any) (int64, bool) {
	switch v := value.(type) {
	case string:
		at, err := time.Parse(time.RFC3339Nano, v)
		if err != nil {
			if at, err = time.Parse("2006-01-02", v); err != nil {
				return 0, false
			}
		}
		return at.UnixMilli(), true
	case float64:
		return int64(v), v == v
	case int:
		return int64(v), true
	}
	return 0, false
}

// --- lock ---------------------------------------------------------------------------------

type lock struct {
	s       *settings
	name    string
	version int
}

func (l *lock) row(version int) nosql.Row {
	now := l.s.Clock().UnixMilli()
	return nosql.Row{PK: partitionLocks, SK: l.name, Version: version, Data: map[string]any{
		"owner":      l.s.Owner,
		"acquiredAt": isoTime(now),
		"expiresAt":  isoTime(now + l.s.LockTTL.Milliseconds()),
	}}
}

func (l *lock) acquire(ctx context.Context) error {
	store := l.s.Store
	current, err := store.Get(ctx, partitionLocks, l.name)
	if err != nil {
		return err
	}
	now := l.s.Clock().UnixMilli()
	if current != nil {
		if at, ok := dateMs(current.Data["expiresAt"]); ok && at > now {
			return &LockedError{Holder: js.String(current.Data["owner"]), ExpiresAt: js.String(current.Data["expiresAt"])}
		}
	}
	version, write := 1, nosql.Write{}
	if current != nil {
		version = current.Version + 1
		write.Expected = nosql.Expect(current.Version)
	}
	write.Row = l.row(version)
	if err := store.Transact(ctx, []nosql.Write{write}); err != nil {
		winner, getErr := store.Get(ctx, partitionLocks, l.name)
		if getErr != nil {
			return getErr
		}
		if winner == nil {
			return &LockedError{Holder: "unknown", ExpiresAt: "unknown"}
		}
		return &LockedError{Holder: js.String(winner.Data["owner"]), ExpiresAt: js.String(winner.Data["expiresAt"])}
	}
	l.version = version
	return nil
}

// commit renews the lease and applies writes in one transaction.
func (l *lock) commit(ctx context.Context, writes []nosql.Write) error {
	row := l.row(l.version + 1)
	all := append(slices.Clone(writes), nosql.Write{Row: row, Expected: nosql.Expect(l.version)})
	if err := l.s.Store.Transact(ctx, all); err != nil {
		return err
	}
	l.version = row.Version
	return nil
}

func (l *lock) renew(ctx context.Context) error { return l.commit(ctx, nil) }

// release deletes the lease only while it is still ours.
func (l *lock) release(ctx context.Context) error {
	current, err := l.s.Store.Get(ctx, partitionLocks, l.name)
	if err != nil {
		return err
	}
	if current == nil || current.Version != l.version || current.Data["owner"] != l.s.Owner {
		return nil
	}
	return l.s.Store.Transact(ctx, []nosql.Write{{Row: *current, Expected: nosql.Expect(current.Version), Delete: true}})
}

func withLock[T any](ctx context.Context, s *settings, name string, work func(*lock) (T, error)) (T, error) {
	l := &lock{s: s, name: name}
	var zero T
	if err := l.acquire(ctx); err != nil {
		return zero, err
	}
	result, err := work(l)
	// As in a JavaScript finally block, a failing release replaces the outcome.
	if releaseErr := l.release(ctx); releaseErr != nil {
		return zero, releaseErr
	}
	return result, err
}

// --- migrations ---------------------------------------------------------------------------

// Status is one declared (or unknown) migration.
type Status struct {
	ID          string  `json:"id"`
	Module      string  `json:"module"`
	Description *string `json:"description,omitempty"`
	// State is applied, pending or unknown (history of a module that is no longer declared).
	State      string `json:"state"`
	AppliedAt  any    `json:"appliedAt,omitempty"`
	Reversible bool   `json:"reversible"`
}

// Target limits up and down: To (inclusive, ignored when empty) wins over Step. A nil Step
// means all pending for Up and 1 for Down; negative steps count from the end.
type Target struct {
	To   string
	Step *int
}

type planned struct {
	migration        Migration
	module           string
	checksum         string
	up, down         StepFunc
	providerSpecific bool
}

// Runner applies and reverts module migrations.
type Runner struct {
	s    settings
	plan []planned
}

// NewRunner validates the whole plan (environment, ids, duplicates, engine support,
// checksums) before anything is read or written.
func NewRunner(o Options) (*Runner, error) {
	s, err := resolve(o)
	if err != nil {
		return nil, err
	}
	r := &Runner{s: s}
	ids := map[string]bool{}
	for _, module := range s.Modules {
		for _, m := range module.Migrations {
			name, err := moduleOf(m.ID, "migration")
			if err != nil {
				return nil, err
			}
			if ids[m.ID] {
				return nil, errors.New("Duplicate migration id: " + m.ID)
			}
			ids[m.ID] = true
			p, ok := selectStep(m, s.provider)
			if !ok {
				return nil, fmt.Errorf("Unsupported migration %s for %s", m.ID, s.provider)
			}
			if p.checksum == "" {
				return nil, errors.New("Migration without checksum: " + m.ID)
			}
			p.module = name
			r.plan = append(r.plan, p)
		}
	}
	return r, nil
}

func legacy(run func(context.Context, nosql.Store) error) StepFunc {
	return func(ctx context.Context, c *Context) error { return run(ctx, c.Store) }
}

// selectStep picks the provider override or the generic steps (never falling back from an
// override to the generic step).
func selectStep(m Migration, provider string) (planned, bool) {
	p := planned{migration: m, checksum: m.Checksum}
	if specific, ok := m.Providers[provider]; ok {
		p.providerSpecific = true
		p.up, p.down = specific.Up, specific.Down
		if p.up == nil && specific.Run != nil {
			p.up = legacy(specific.Run)
		}
		if specific.Checksum != "" {
			p.checksum = specific.Checksum
		}
		return p, p.up != nil
	}
	p.up, p.down = m.Up, m.Down
	if p.up == nil && m.Run != nil {
		p.up = legacy(m.Run)
	}
	return p, p.up != nil
}

func (r *Runner) find(id string) *planned {
	for i := range r.plan {
		if r.plan[i].migration.ID == id {
			return &r.plan[i]
		}
	}
	return nil
}

// Status lists every declared migration, then history of undeclared modules. It does not
// lock or verify.
func (r *Runner) Status(ctx context.Context) ([]Status, error) {
	h, err := readHistory(ctx, r.s.Store, partitionMigrations)
	if err != nil {
		return nil, err
	}
	out := []Status{}
	for _, p := range r.plan {
		st := Status{ID: p.migration.ID, Module: p.module, Description: p.migration.Description, State: "pending", Reversible: p.down != nil}
		if row, ok := h.byID[p.migration.ID]; ok {
			st.State, st.AppliedAt = "applied", row.Data["appliedAt"]
		}
		out = append(out, st)
	}
	for _, row := range h.rows {
		if r.find(row.SK) == nil {
			out = append(out, Status{ID: row.SK, Module: strings.Split(row.SK, ":")[0], State: "unknown", AppliedAt: row.Data["appliedAt"]})
		}
	}
	return out, nil
}

// verify fails with "Migration changed: <id>" when an applied checksum differs, or when a
// provider-specific migration was recorded by another engine.
func (r *Runner) verify(ctx context.Context) (history, error) {
	h, err := readHistory(ctx, r.s.Store, partitionMigrations)
	if err != nil {
		return h, err
	}
	for _, p := range r.plan {
		row, ok := h.byID[p.migration.ID]
		if !ok {
			continue
		}
		checksum, isString := row.Data["checksum"].(string)
		engineChanged := false
		if recorded := row.Data["provider"]; p.providerSpecific && js.Truthy(recorded) {
			name, isName := recorded.(string)
			engineChanged = !isName || name != r.s.provider
		}
		if !isString || checksum != p.checksum || engineChanged {
			return h, errors.New("Migration changed: " + p.migration.ID)
		}
	}
	return h, nil
}

func (r *Runner) applied(h history) []*planned {
	var out []*planned
	for i := range r.plan {
		if _, ok := h.byID[r.plan[i].migration.ID]; ok {
			out = append(out, &r.plan[i])
		}
	}
	return out
}

func (r *Runner) context() *Context {
	return NewContext(r.s.Store, r.s.provider, r.s.Environment, r.s.Log)
}

// Up applies pending migrations in declaration order and returns their ids.
func (r *Runner) Up(ctx context.Context, target Target) ([]string, error) {
	return withLock(ctx, &r.s, "migrations", func(l *lock) ([]string, error) {
		if _, err := r.verify(ctx); err != nil {
			return nil, err
		}
		h, err := readHistory(ctx, r.s.Store, partitionMigrations)
		if err != nil {
			return nil, err
		}
		var pending []*planned
		for i := range r.plan {
			if _, ok := h.byID[r.plan[i].migration.ID]; !ok {
				pending = append(pending, &r.plan[i])
			}
		}
		end := len(pending)
		if target.To != "" {
			index := slices.IndexFunc(pending, func(p *planned) bool { return p.migration.ID == target.To })
			if index < 0 {
				return nil, errors.New("Couldn't find migration to apply with name " + jsonString(target.To))
			}
			end = index + 1
		} else if target.Step != nil {
			end = jsSlice(*target.Step, len(pending))
		}
		c := r.context()
		done := []string{}
		for _, p := range pending[:end] {
			id := p.migration.ID
			r.s.Log("migrating " + id)
			if err := l.renew(ctx); err != nil {
				return done, &StepError{ID: id, Direction: "up", Cause: err}
			}
			if err := p.up(ctx, c); err != nil {
				return done, &StepError{ID: id, Direction: "up", Cause: err}
			}
			record := nosql.Row{PK: partitionMigrations, SK: id, Version: 1, Data: map[string]any{
				"checksum": p.checksum, "provider": r.s.provider, "appliedAt": isoTime(r.s.Clock().UnixMilli()),
			}}
			if err := l.commit(ctx, []nosql.Write{{Row: record}}); err != nil {
				return done, err
			}
			done = append(done, id)
		}
		return done, nil
	})
}

// Down reverts the latest applied migrations (one by default) and returns their ids. It
// refuses before reverting anything when a target has no Down step.
func (r *Runner) Down(ctx context.Context, target Target) ([]string, error) {
	return withLock(ctx, &r.s, "migrations", func(l *lock) ([]string, error) {
		h, err := r.verify(ctx)
		if err != nil {
			return nil, err
		}
		applied := r.applied(h)
		slices.Reverse(applied)
		n := 1
		if target.Step != nil {
			n = *target.Step
		}
		targets := applied[:jsSlice(n, len(applied))]
		if target.To != "" {
			index := slices.IndexFunc(applied, func(p *planned) bool { return p.migration.ID == target.To })
			if index < 0 {
				return nil, errors.New("Migration is not applied: " + target.To)
			}
			targets = applied[:index+1]
		}
		var irreversible []string
		for _, p := range targets {
			if p.down == nil {
				irreversible = append(irreversible, p.migration.ID)
			}
		}
		if len(irreversible) > 0 {
			return nil, errors.New("Irreversible migrations: " + strings.Join(irreversible, ", "))
		}
		c := r.context()
		done := []string{}
		for _, p := range targets {
			id := p.migration.ID
			r.s.Log("reverting " + id)
			if err := l.renew(ctx); err != nil {
				return done, &StepError{ID: id, Direction: "down", Cause: err}
			}
			if err := p.down(ctx, c); err != nil {
				return done, &StepError{ID: id, Direction: "down", Cause: err}
			}
			record, err := r.s.Store.Get(ctx, partitionMigrations, id)
			if err != nil {
				return done, err
			}
			var writes []nosql.Write
			if record != nil {
				writes = []nosql.Write{{Row: *record, Expected: nosql.Expect(record.Version), Delete: true}}
			}
			if err := l.commit(ctx, writes); err != nil {
				return done, err
			}
			done = append(done, id)
		}
		return done, nil
	})
}

// Migrate applies every pending migration.
func Migrate(ctx context.Context, o Options) ([]string, error) {
	r, err := NewRunner(o)
	if err != nil {
		return nil, err
	}
	return r.Up(ctx, Target{})
}

// --- seeds --------------------------------------------------------------------------------

// SeedStatus is one declared seed and whether it would run in the runner's environment.
type SeedStatus struct {
	ID           string   `json:"id"`
	Module       string   `json:"module"`
	Description  *string  `json:"description,omitempty"`
	Environments []string `json:"environments"`
	AppliedAt    any      `json:"appliedAt,omitempty"`
	// State is skipped (not allowed in this environment), pending, changed or applied.
	State string `json:"state"`
}

// RunOptions select seeds: Modules nil means every module (an empty list selects none);
// Rerun also runs applied seeds.
type RunOptions struct {
	Modules []string
	Rerun   bool
}

type plannedSeed struct {
	seed         Seed
	module       string
	version      string
	environments []string
}

// SeedRunner runs module seeds, once per version and database.
type SeedRunner struct {
	s    settings
	plan []plannedSeed
}

// NewSeedRunner validates the environment and every seed declaration.
func NewSeedRunner(o Options) (*SeedRunner, error) {
	s, err := resolve(o)
	if err != nil {
		return nil, err
	}
	r := &SeedRunner{s: s}
	ids := map[string]bool{}
	for _, module := range s.Modules {
		for _, seed := range module.Seeds {
			name, err := moduleOf(seed.ID, "seed")
			if err != nil {
				return nil, err
			}
			if ids[seed.ID] {
				return nil, errors.New("Duplicate seed id: " + seed.ID)
			}
			ids[seed.ID] = true
			environments := seed.Environments
			if environments == nil {
				environments = DefaultSeedEnvironments
			}
			if len(environments) == 0 || slices.ContainsFunc(environments, func(e string) bool { return !slices.Contains(Environments, e) }) {
				return nil, errors.New("Invalid environments for seed " + seed.ID)
			}
			version := seed.Version
			if version == "" {
				version = "1"
			}
			r.plan = append(r.plan, plannedSeed{seed: seed, module: name, version: version, environments: slices.Clone(environments)})
		}
	}
	return r, nil
}

// Status lists every declared seed. It does not lock.
func (r *SeedRunner) Status(ctx context.Context) ([]SeedStatus, error) {
	h, err := readHistory(ctx, r.s.Store, partitionSeeds)
	if err != nil {
		return nil, err
	}
	out := []SeedStatus{}
	for _, p := range r.plan {
		st := SeedStatus{ID: p.seed.ID, Module: p.module, Description: p.seed.Description, Environments: p.environments}
		row, ok := h.byID[p.seed.ID]
		if ok {
			st.AppliedAt = row.Data["appliedAt"]
		}
		switch {
		case !slices.Contains(p.environments, r.s.Environment):
			st.State = "skipped"
		case !ok:
			st.State = "pending"
		case row.Data["version"] != p.version:
			st.State = "changed"
		default:
			st.State = "applied"
		}
		out = append(out, st)
	}
	return out, nil
}

// Run runs pending or changed seeds allowed in this environment and returns their ids.
func (r *SeedRunner) Run(ctx context.Context, options RunOptions) ([]string, error) {
	for _, module := range options.Modules {
		if !slices.ContainsFunc(r.s.Modules, func(m Module) bool { return m.ID == module }) {
			return nil, errors.New("Unknown module: " + module)
		}
	}
	var selected []plannedSeed
	for _, p := range r.plan {
		if slices.Contains(p.environments, r.s.Environment) && (options.Modules == nil || slices.Contains(options.Modules, p.module)) {
			selected = append(selected, p)
		}
	}
	if len(selected) == 0 {
		return []string{}, nil
	}
	return withLock(ctx, &r.s, "seeds", func(l *lock) ([]string, error) {
		h, err := readHistory(ctx, r.s.Store, partitionSeeds)
		if err != nil {
			return nil, err
		}
		done := []string{}
		for _, p := range selected {
			id := p.seed.ID
			if row, ok := h.byID[id]; !options.Rerun && ok && row.Data["version"] == p.version {
				continue
			}
			r.s.Log("seeding " + id)
			if err := l.renew(ctx); err != nil {
				return done, &StepError{ID: id, Direction: "up", Cause: err}
			}
			sc := &SeedContext{Context: NewContext(r.s.Store, r.s.provider, r.s.Environment, r.s.Log), seedID: id, secrets: r.s.Secrets, services: r.s.Services}
			if err := p.seed.Run(ctx, sc); err != nil {
				return done, &StepError{ID: id, Direction: "up", Cause: err}
			}
			current, err := r.s.Store.Get(ctx, partitionSeeds, id)
			if err != nil {
				return done, err
			}
			write := nosql.Write{Row: nosql.Row{PK: partitionSeeds, SK: id, Version: 1, Data: map[string]any{
				"version": p.version, "environment": r.s.Environment, "appliedAt": isoTime(r.s.Clock().UnixMilli()),
			}}}
			if current != nil {
				write.Row.Version = current.Version + 1
				write.Expected = nosql.Expect(current.Version)
			}
			if err := l.commit(ctx, []nosql.Write{write}); err != nil {
				return done, err
			}
			done = append(done, id)
		}
		return done, nil
	})
}
