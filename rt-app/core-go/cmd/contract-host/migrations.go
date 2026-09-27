package main

// Subjects: migrations (MemoryStore), migrations-postgres (RT_APP_TEST_POSTGRES_URL) and
// migrations-dynamodb (RT_APP_TEST_DYNAMODB_ENDPOINT). A facade over migrations.Runner,
// SeedRunner, Context.EnsureRows and the migrate/seed commands; migrations and seeds are
// declared as data in init.features (mirrors spec/hosts/node/migrations.mjs).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	ddb "github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/jackc/pgx/v5/pgxpool"

	"rt.local/core-go/conformance"
	"rt.local/core-go/migrations"
	"rt.local/core-go/nosql"
	"rt.local/core-go/nosql/dynamodb"
	"rt.local/core-go/nosql/postgres"
)

func init() {
	register("migrations", func(ctx context.Context, init json.RawMessage) (conformance.Instance, error) {
		store, err := memoryStore(ctx, init)
		if err != nil {
			return conformance.Instance{}, err
		}
		return migSubject(store, nil, init)
	})
	if url := os.Getenv("RT_APP_TEST_POSTGRES_URL"); url != "" {
		register("migrations-postgres", func(ctx context.Context, init json.RawMessage) (conformance.Instance, error) {
			store, closeFn, err := migPostgres(ctx, url, init)
			if err != nil {
				return conformance.Instance{}, err
			}
			return migSubject(store, closeFn, init)
		})
	}
	if endpoint := os.Getenv("RT_APP_TEST_DYNAMODB_ENDPOINT"); endpoint != "" {
		register("migrations-dynamodb", func(ctx context.Context, init json.RawMessage) (conformance.Instance, error) {
			store, closeFn, err := migDynamo(ctx, endpoint, init)
			if err != nil {
				return conformance.Instance{}, err
			}
			return migSubject(store, closeFn, init)
		})
	}
}

// migPostgres is a fresh table holding init.rows, dropped on close.
func migPostgres(ctx context.Context, url string, init json.RawMessage) (nosql.Store, func() error, error) {
	config, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, nil, err
	}
	config.MaxConns = 2
	config.ConnConfig.TLSConfig, config.ConnConfig.Fallbacks = nil, nil
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, nil, err
	}
	table := uniqueTable()
	closeAll := cleanup(func(ctx context.Context) error {
		defer pool.Close()
		_, err := pool.Exec(ctx, "DROP TABLE IF EXISTS "+table)
		return err
	})
	store, err := postgres.New(pool, table)
	if err == nil {
		err = seedRows(ctx, store, init)
	}
	if err != nil {
		_ = closeAll()
		return nil, nil, err
	}
	return store, closeAll, nil
}

// migDynamo is a fresh DynamoDB Local table holding init.rows, deleted on close.
func migDynamo(ctx context.Context, endpoint string, init json.RawMessage) (nosql.Store, func() error, error) {
	client := ddb.New(ddb.Options{
		Region:           "us-east-1",
		BaseEndpoint:     aws.String(endpoint),
		Credentials:      credentials.NewStaticCredentialsProvider(envOr("AWS_ACCESS_KEY_ID", "local"), envOr("AWS_SECRET_ACCESS_KEY", "local"), ""),
		RetryMaxAttempts: 3,
		HTTPClient:       &http.Client{Timeout: 8 * time.Second},
	})
	table := uniqueTable()
	_, err := client.CreateTable(ctx, &ddb.CreateTableInput{
		TableName:   aws.String(table),
		BillingMode: types.BillingModePayPerRequest,
		AttributeDefinitions: []types.AttributeDefinition{
			{AttributeName: aws.String("pk"), AttributeType: types.ScalarAttributeTypeS},
			{AttributeName: aws.String("sk"), AttributeType: types.ScalarAttributeTypeS},
		},
		KeySchema: []types.KeySchemaElement{
			{AttributeName: aws.String("pk"), KeyType: types.KeyTypeHash},
			{AttributeName: aws.String("sk"), KeyType: types.KeyTypeRange},
		},
	})
	if err != nil {
		return nil, nil, err
	}
	closeAll := cleanup(func(ctx context.Context) error {
		_, err := client.DeleteTable(ctx, &ddb.DeleteTableInput{TableName: aws.String(table)})
		return err
	})
	store, err := dynamodb.New(client, table)
	if err == nil {
		err = seedRows(ctx, store, init)
	}
	if err != nil {
		_ = closeAll()
		return nil, nil, err
	}
	return store, closeAll, nil
}

// migInit is the facade configuration; raw fields keep "missing" apart from null.
type migInit struct {
	Now         *string           `json:"now"`
	Environment *string           `json:"environment"`
	Owner       json.RawMessage   `json:"owner"`
	LockTTLMs   *float64          `json:"lockTtlMs"`
	Provider    *string           `json:"provider"`
	Secrets     map[string]string `json:"secrets"`
	Services    map[string]any    `json:"services"`
	Features    json.RawMessage   `json:"features"`
}

type migFacade struct {
	faulty      *faultyStore
	provider    string
	now         int64
	features    json.RawMessage
	environment string
	owner       *string
	lockTTL     time.Duration
	secrets     map[string]string
	services    map[string]any
	trace       []any
	logs        []string
	output      []string
}

func migParseISO(value, what string) (int64, error) {
	at, err := parseISO(value)
	if err != nil {
		return 0, fmt.Errorf("%s must be an ISO 8601 date", what)
	}
	return at.UnixMilli(), nil
}

func migSubject(store nosql.Store, closeFn func() error, raw json.RawMessage) (conformance.Instance, error) {
	fail := func(err error) (conformance.Instance, error) {
		if closeFn != nil {
			_ = closeFn()
		}
		return conformance.Instance{}, err
	}
	var init migInit
	if err := json.Unmarshal(raw, &init); err != nil {
		return fail(fmt.Errorf("init: %w", err))
	}
	f := &migFacade{faulty: &faultyStore{Store: store}, provider: "memory", features: init.Features, secrets: init.Secrets, services: init.Services}
	now := "2026-09-24T10:00:00.000Z"
	if init.Now != nil {
		now = *init.Now
	}
	var err error
	if f.now, err = migParseISO(now, "init.now"); err != nil {
		return fail(err)
	}
	if init.Provider != nil {
		f.provider = *init.Provider
	}
	if init.Environment != nil {
		f.environment = *init.Environment
	}
	owner := "runner-a"
	f.owner = &owner
	if len(init.Owner) > 0 {
		var given *string
		_ = json.Unmarshal(init.Owner, &given)
		f.owner = given
	}
	if init.LockTTLMs != nil {
		f.lockTTL = time.Duration(*init.LockTTLMs) * time.Millisecond
	}
	methods := map[string]conformance.Method{
		"status": func(ctx context.Context, _ []json.RawMessage) (any, error) {
			r, err := f.runner(nil)
			if err != nil {
				return nil, err
			}
			return r.Status(ctx)
		},
		"up": func(ctx context.Context, args []json.RawMessage) (any, error) {
			r, err := f.runner(nil)
			if err != nil {
				return nil, err
			}
			return r.Up(ctx, migTarget(arg(args, 0)))
		},
		"down": func(ctx context.Context, args []json.RawMessage) (any, error) {
			r, err := f.runner(nil)
			if err != nil {
				return nil, err
			}
			return r.Down(ctx, migTarget(arg(args, 0)))
		},
		"seedStatus": func(ctx context.Context, _ []json.RawMessage) (any, error) {
			r, err := f.seeds(nil)
			if err != nil {
				return nil, err
			}
			return r.Status(ctx)
		},
		"seed": func(ctx context.Context, args []json.RawMessage) (any, error) {
			r, err := f.seeds(nil)
			if err != nil {
				return nil, err
			}
			return r.Run(ctx, migRunOptions(arg(args, 0)))
		},
		"ensureRows": func(ctx context.Context, args []json.RawMessage) (any, error) {
			var rows []nosql.Row
			if err := decodeArgs(args, &rows); err != nil {
				return nil, err
			}
			environment := f.environment
			if environment == "" {
				environment = "local"
			}
			return migrations.NewContext(f.faulty, f.provider, environment, f.log).EnsureRows(ctx, rows)
		},
		"migrateCommand": func(ctx context.Context, args []json.RawMessage) (any, error) {
			var argv []string
			if err := decodeArgs(args, &argv); err != nil {
				return nil, err
			}
			f.output = []string{}
			err := migrations.MigrateCommand(ctx, f.app(), argv, func(line string) { f.output = append(f.output, line) })
			return f.output, err
		},
		"seedCommand": func(ctx context.Context, args []json.RawMessage) (any, error) {
			var argv []string
			secrets := map[string]string{}
			if err := decodeArgs(args, &argv, &secrets); err != nil {
				return nil, err
			}
			f.output = []string{}
			err := migrations.SeedCommand(ctx, f.app(), argv, secrets, func(line string) { f.output = append(f.output, line) })
			return f.output, err
		},
		"output": func(context.Context, []json.RawMessage) (any, error) { return migList(f.output), nil },
		"trace":  func(context.Context, []json.RawMessage) (any, error) { return migList(f.trace), nil },
		"logs":   func(context.Context, []json.RawMessage) (any, error) { return migList(f.logs), nil },
		"row":    cacheRowMethod(f.faulty),
		"rows": func(ctx context.Context, args []json.RawMessage) (any, error) {
			var pk string
			if err := decodeArgs(args, &pk); err != nil {
				return nil, err
			}
			return migListAll(ctx, f.faulty, pk)
		},
		"setNow": func(_ context.Context, args []json.RawMessage) (any, error) {
			var iso string
			_ = decodeArgs(args, &iso)
			ms, err := migParseISO(iso, "setNow")
			if err == nil {
				f.now = ms
			}
			return nil, err
		},
		"setFeatures": func(_ context.Context, args []json.RawMessage) (any, error) {
			f.features = arg(args, 0)
			return nil, nil
		},
		"setEnvironment": func(_ context.Context, args []json.RawMessage) (any, error) {
			var environment *string
			_ = decodeArgs(args, &environment)
			f.environment = ""
			if environment != nil {
				f.environment = *environment
			}
			return nil, nil
		},
		"setOwner": func(_ context.Context, args []json.RawMessage) (any, error) {
			var owner *string
			_ = decodeArgs(args, &owner)
			f.owner = owner
			return nil, nil
		},
		"injectFaults": func(_ context.Context, args []json.RawMessage) (any, error) { return f.faulty.inject(args) },
	}
	return conformance.Instance{Methods: methods, Close: closeFn}, nil
}

func migList[T any](items []T) []T {
	if items == nil {
		return []T{}
	}
	return items
}

func migListAll(ctx context.Context, store nosql.Store, pk string) ([]nosql.Row, error) {
	rows := []nosql.Row{}
	cursor := ""
	for {
		page, err := store.List(ctx, pk, cursor)
		if err != nil {
			return nil, err
		}
		rows = append(rows, page.Items...)
		if cursor = page.Cursor; cursor == "" {
			return rows, nil
		}
	}
}

func migTarget(raw json.RawMessage) migrations.Target {
	var t struct {
		To   *string  `json:"to"`
		Step *float64 `json:"step"`
	}
	_ = json.Unmarshal(raw, &t)
	var target migrations.Target
	if t.To != nil {
		target.To = *t.To
	}
	if t.Step != nil {
		n := int(*t.Step)
		target.Step = &n
	}
	return target
}

func migRunOptions(raw json.RawMessage) migrations.RunOptions {
	var o struct {
		Modules []string `json:"modules"`
		Rerun   bool     `json:"rerun"`
	}
	_ = json.Unmarshal(raw, &o)
	return migrations.RunOptions{Modules: o.Modules, Rerun: o.Rerun}
}

func (f *migFacade) log(line string) { f.logs = append(f.logs, line) }

func (f *migFacade) clock() time.Time { return time.UnixMilli(f.now) }

// options are the runner options the application passes; modules default to init.features.
func (f *migFacade) options(features json.RawMessage, owner *string) (migrations.Options, error) {
	modules, err := f.build(features)
	if err != nil {
		return migrations.Options{}, err
	}
	o := migrations.Options{
		Store: f.faulty, Modules: modules, Environment: f.environment, LockTTL: f.lockTTL,
		Clock: f.clock, Log: f.log, Secrets: f.secrets, Services: f.services, Provider: f.provider,
	}
	if owner == nil {
		owner = f.owner
	}
	if owner != nil {
		o.Owner = *owner
	}
	return o, nil
}

func (f *migFacade) runner(nested *migNested) (*migrations.Runner, error) {
	o, err := f.nestedOptions(nested)
	if err != nil {
		return nil, err
	}
	return migrations.NewRunner(o)
}

func (f *migFacade) seeds(nested *migNested) (*migrations.SeedRunner, error) {
	o, err := f.nestedOptions(nested)
	if err != nil {
		return nil, err
	}
	return migrations.NewSeedRunner(o)
}

func (f *migFacade) nestedOptions(nested *migNested) (migrations.Options, error) {
	if nested == nil {
		return f.options(f.features, nil)
	}
	features := nested.Features
	if len(features) == 0 || string(features) == "null" {
		features = json.RawMessage("[]")
	}
	owner := nested.Owner
	if owner == nil {
		owner = new(string) // an omitted owner is the default one, as in the reference
	}
	return f.options(features, owner)
}

func (f *migFacade) app() migrations.App {
	o, err := f.options(f.features, nil)
	return &migApp{f: f, options: o, err: err}
}

// migApp is the application surface of the commands (its runners use the command's log).
type migApp struct {
	f       *migFacade
	options migrations.Options
	err     error
}

func (a *migApp) Environment() string {
	if a.f.environment == "" {
		return "local"
	}
	return a.f.environment
}

func (a *migApp) Migrations(o migrations.RunnerOptions) (*migrations.Runner, error) {
	if a.err != nil {
		return nil, a.err
	}
	options := a.options
	options.Log = o.Log
	return migrations.NewRunner(options)
}

func (a *migApp) Seeds(o migrations.RunnerOptions) (*migrations.SeedRunner, error) {
	if a.err != nil {
		return nil, a.err
	}
	options := a.options
	options.Log, options.Secrets = o.Log, o.Secrets
	return migrations.NewSeedRunner(options)
}

// --- declarations -------------------------------------------------------------------------

type migFeatureDecl struct {
	ID         string            `json:"id"`
	Migrations []json.RawMessage `json:"migrations"`
	Seeds      []migSeedDecl     `json:"seeds"`
}

type migStepDecl struct {
	Checksum *string         `json:"checksum"`
	Up       json.RawMessage `json:"up"`
	Down     json.RawMessage `json:"down"`
	Run      json.RawMessage `json:"run"`
}

type migMigrationDecl struct {
	Schema      *string                `json:"schema"`
	ID          *string                `json:"id"`
	Description *string                `json:"description"`
	Providers   map[string]migStepDecl `json:"providers"`
	migStepDecl
}

type migSeedDecl struct {
	ID           *string         `json:"id"`
	Description  *string         `json:"description"`
	Version      *string         `json:"version"`
	Environments []string        `json:"environments"`
	Run          json.RawMessage `json:"run"`
}

func migOps(raw json.RawMessage) ([]json.RawMessage, bool) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, false
	}
	var ops []json.RawMessage
	_ = json.Unmarshal(raw, &ops)
	return ops, true
}

func migText(p *string, missing string) string {
	if p == nil {
		return missing
	}
	return *p
}

func (f *migFacade) build(raw json.RawMessage) ([]migrations.Module, error) {
	var decls []migFeatureDecl
	if len(raw) > 0 && string(raw) != "null" {
		if err := json.Unmarshal(raw, &decls); err != nil {
			return nil, fmt.Errorf("features: %w", err)
		}
	}
	modules := []migrations.Module{}
	for _, d := range decls {
		module := migrations.Module{ID: d.ID}
		for _, rawMigration := range d.Migrations {
			var m migMigrationDecl
			if err := json.Unmarshal(rawMigration, &m); err != nil {
				return nil, fmt.Errorf("migration: %w", err)
			}
			if m.Schema != nil {
				module.Migrations = append(module.Migrations, migrations.SchemaMigration(*m.Schema))
				continue
			}
			id := migText(m.ID, "undefined") // String(undefined), as the reference prints it
			migration := migrations.Migration{ID: id, Checksum: migText(m.Checksum, ""), Description: m.Description}
			migration.Up, migration.Down, migration.Run = f.steps(id, "", m.migStepDecl)
			if m.Providers != nil {
				migration.Providers = map[string]migrations.Step{}
				for name, p := range m.Providers {
					step := migrations.Step{Checksum: migText(p.Checksum, "")}
					step.Up, step.Down, step.Run = f.steps(id, "@"+name, p)
					migration.Providers[name] = step
				}
			}
			module.Migrations = append(module.Migrations, migration)
		}
		for _, s := range d.Seeds {
			id := migText(s.ID, "undefined")
			ops, _ := migOps(s.Run)
			module.Seeds = append(module.Seeds, migrations.Seed{
				ID: id, Description: s.Description, Version: migText(s.Version, ""), Environments: s.Environments,
				Run: func(ctx context.Context, sc *migrations.SeedContext) error {
					f.trace = append(f.trace, id+" seed")
					return f.perform(ctx, ops, sc.Context, sc)
				},
			})
		}
		modules = append(modules, module)
	}
	return modules, nil
}

// steps turns the up/down/run operation lists of a declaration into step functions.
func (f *migFacade) steps(id, suffix string, d migStepDecl) (up, down migrations.StepFunc, run func(context.Context, nosql.Store) error) {
	step := func(name string, raw json.RawMessage) migrations.StepFunc {
		ops, ok := migOps(raw)
		if !ok {
			return nil
		}
		return func(ctx context.Context, c *migrations.Context) error {
			f.trace = append(f.trace, id+" "+name+suffix)
			return f.perform(ctx, ops, c, nil)
		}
	}
	if ops, ok := migOps(d.Run); ok {
		run = func(ctx context.Context, _ nosql.Store) error {
			f.trace = append(f.trace, id+" run"+suffix)
			return f.perform(ctx, ops, nil, nil)
		}
	}
	return step("up", d.Up), step("down", d.Down), run
}

type migNested struct {
	Runner   string          `json:"runner"`
	Owner    *string         `json:"owner"`
	Call     string          `json:"call"`
	Options  json.RawMessage `json:"options"`
	Features json.RawMessage `json:"features"`
}

// perform runs data operations inside a step; c is nil for legacy run(store) steps.
func (f *migFacade) perform(ctx context.Context, ops []json.RawMessage, c *migrations.Context, sc *migrations.SeedContext) error {
	for _, rawOp := range ops {
		var op map[string]json.RawMessage
		if err := json.Unmarshal(rawOp, &op); err != nil || len(op) != 1 {
			return fmt.Errorf("Unknown operation %s", rawOp)
		}
		for kind, value := range op {
			if c == nil && (kind == "ensure" || kind == "log" || kind == "context" || kind == "secret" || kind == "service") {
				return fmt.Errorf("Operation %s needs a migration context", kind)
			}
			if err := f.operation(ctx, kind, value, c, sc); err != nil {
				return err
			}
		}
	}
	return nil
}

func (f *migFacade) operation(ctx context.Context, kind string, value json.RawMessage, c *migrations.Context, sc *migrations.SeedContext) error {
	store := f.faulty
	switch kind {
	case "ensure":
		var rows []nosql.Row
		if err := json.Unmarshal(value, &rows); err != nil {
			return err
		}
		inserted, err := c.EnsureRows(ctx, rows)
		if err != nil {
			return err
		}
		f.trace = append(f.trace, map[string]any{"ensured": inserted})
	case "delete":
		var key struct{ PK, SK string }
		_ = json.Unmarshal(value, &key)
		row, err := store.Get(ctx, key.PK, key.SK)
		if err != nil || row == nil {
			return err
		}
		return store.Transact(ctx, []nosql.Write{{Row: *row, Expected: nosql.Expect(row.Version), Delete: true}})
	case "fail":
		var message string
		_ = json.Unmarshal(value, &message)
		return errors.New(message)
	case "advance":
		var ms float64
		_ = json.Unmarshal(value, &ms)
		f.now += int64(ms)
	case "steal":
		var s struct {
			Lock  string   `json:"lock"`
			Owner string   `json:"owner"`
			TTLMs *float64 `json:"ttlMs"`
		}
		_ = json.Unmarshal(value, &s)
		ttl := int64(900000)
		if s.TTLMs != nil {
			ttl = int64(*s.TTLMs)
		}
		current, err := store.Get(ctx, "MIGRATION_LOCKS", s.Lock)
		if err != nil {
			return err
		}
		write := nosql.Write{Row: nosql.Row{PK: "MIGRATION_LOCKS", SK: s.Lock, Version: 1, Data: map[string]any{
			"owner": s.Owner, "acquiredAt": migISO(f.now), "expiresAt": migISO(f.now + ttl),
		}}}
		if current != nil {
			write.Row.Version, write.Expected = current.Version+1, nosql.Expect(current.Version)
		}
		return store.Transact(ctx, []nosql.Write{write})
	case "release":
		var name string
		_ = json.Unmarshal(value, &name)
		current, err := store.Get(ctx, "MIGRATION_LOCKS", name)
		if err != nil || current == nil {
			return err
		}
		return store.Transact(ctx, []nosql.Write{{Row: *current, Expected: nosql.Expect(current.Version), Delete: true}})
	case "faults":
		var kinds []json.RawMessage
		_ = json.Unmarshal(value, &kinds)
		for _, k := range kinds {
			if _, err := store.inject([]json.RawMessage{k}); err != nil {
				return err
			}
		}
	case "peek":
		var key []string
		_ = json.Unmarshal(value, &key)
		row, err := store.Get(ctx, key[0], key[1])
		if err != nil {
			return err
		}
		f.trace = append(f.trace, map[string]any{"peek": row})
	case "log":
		var text string
		_ = json.Unmarshal(value, &text)
		c.Log(text)
	case "context":
		f.trace = append(f.trace, map[string]any{"context": map[string]any{"provider": c.Provider, "environment": c.Environment}})
	case "secret", "service":
		if sc == nil {
			return fmt.Errorf("Operation %s needs a seed context", kind)
		}
		var name string
		_ = json.Unmarshal(value, &name)
		var result any
		var err error
		if kind == "secret" {
			result, err = sc.Secret(name)
		} else {
			result, err = sc.Service(name)
		}
		if err != nil {
			return err
		}
		f.trace = append(f.trace, map[string]any{kind: result})
	case "nested":
		var n migNested
		_ = json.Unmarshal(value, &n)
		result, err := f.nested(ctx, &n)
		if err != nil {
			f.trace = append(f.trace, map[string]any{"nested": map[string]any{"error": err.Error()}})
		} else {
			f.trace = append(f.trace, map[string]any{"nested": map[string]any{"value": result}})
		}
	default:
		return fmt.Errorf("Unknown operation %s", kind)
	}
	return nil
}

func (f *migFacade) nested(ctx context.Context, n *migNested) (any, error) {
	if n.Runner == "seeds" {
		r, err := f.seeds(n)
		if err != nil {
			return nil, err
		}
		switch n.Call {
		case "run":
			return r.Run(ctx, migRunOptions(n.Options))
		case "status":
			return r.Status(ctx)
		}
		return nil, fmt.Errorf("runner.%s is not a function", n.Call)
	}
	r, err := f.runner(n)
	if err != nil {
		return nil, err
	}
	switch n.Call {
	case "up":
		return r.Up(ctx, migTarget(n.Options))
	case "down":
		return r.Down(ctx, migTarget(n.Options))
	case "status":
		return r.Status(ctx)
	}
	return nil, fmt.Errorf("runner.%s is not a function", n.Call)
}

func migISO(ms int64) string { return time.UnixMilli(ms).UTC().Format("2006-01-02T15:04:05.000Z") }
