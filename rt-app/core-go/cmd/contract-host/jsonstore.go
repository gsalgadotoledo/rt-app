package main

// Subjects: json-store (spec/contracts/json.contract.yaml) and nosql-json (the nosql contract on
// a jsonstore file; registered in storage.go). Mirrors hosts/node/json.mjs: every instance owns a
// fresh temporary directory, the database is "db.json" there (or init.path), and file helpers
// take names relative to that directory.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"sync"
	"time"

	"rt.local/core-go/apperr"
	"rt.local/core-go/conformance"
	"rt.local/core-go/nosql"
	"rt.local/core-go/nosql/jsonstore"
)

func init() {
	register("json-store", jsonStoreSubject)
}

const jsonDefaultNow = 1767225600000 // 2026-01-01T00:00:00.000Z

// storeMethods is the store surface of a subject: get, transact, list. Writes are decoded
// leniently so a row the TypeScript store rejects reaches the store as an invalid row at its
// position, instead of failing to decode.
func storeMethods(store nosql.Store) map[string]conformance.Method {
	return map[string]conformance.Method{
		"get": func(ctx context.Context, args []json.RawMessage) (any, error) {
			var pk, sk string
			if err := decodeArgs(args, &pk, &sk); err != nil {
				return nil, err
			}
			return store.Get(ctx, pk, sk)
		},
		"transact": func(ctx context.Context, args []json.RawMessage) (any, error) {
			writes, err := looseWrites(arg(args, 0))
			if err != nil {
				return nil, err
			}
			return nil, store.Transact(ctx, writes)
		},
		"list": func(ctx context.Context, args []json.RawMessage) (any, error) {
			var pk, cursor string
			if err := decodeArgs(args, &pk, &cursor); err != nil {
				return nil, err
			}
			return store.List(ctx, pk, cursor)
		},
	}
}

// looseWrites decodes writes like JavaScript sees them: a row that is not {pk: string, sk:
// string, version: safe integer, data: object} keeps its key and gets an unsafe version, so the
// store rejects it ("Invalid JSON row") at its position.
func looseWrites(raw json.RawMessage) ([]nosql.Write, error) {
	var items []struct {
		Row      json.RawMessage `json:"row"`
		Expected any             `json:"expected"`
		Delete   json.RawMessage `json:"delete"`
	}
	if err := json.Unmarshal(raw, &items); err != nil {
		return nil, fmt.Errorf("argument 1: %w", err)
	}
	writes := make([]nosql.Write, len(items))
	for i, item := range items {
		var loose map[string]any
		_ = json.Unmarshal(item.Row, &loose)
		pk, _ := loose["pk"].(string)
		sk, _ := loose["sk"].(string)
		row := nosql.Row{PK: pk, SK: sk}
		version, isNumber := loose["version"].(float64)
		_, isObject := loose["data"].(map[string]any)
		if _, ok := loose["pk"].(string); ok && isNumber && version == math.Trunc(version) && math.Abs(version) <= 1<<53-1 && isObject {
			if err := json.Unmarshal(item.Row, &row); err != nil {
				return nil, fmt.Errorf("argument 1: row %d: %w", i, err)
			}
		} else {
			row.Version = math.MaxInt // not a safe integer: the store rejects the row
		}
		if _, ok := loose["sk"].(string); !ok {
			row.Version = math.MaxInt
		}
		w := nosql.Write{Row: row, Delete: len(item.Delete) > 0 && truthy(item.Delete)}
		switch expected := item.Expected.(type) {
		case nil:
		case float64:
			if expected == math.Trunc(expected) && math.Abs(expected) <= 1<<53-1 {
				w.Expected = nosql.Expect(int(expected))
			} else {
				w.Expected = nosql.Expect(math.MinInt) // never equals a stored version
			}
		default:
			w.Expected = nosql.Expect(math.MinInt)
		}
		writes[i] = w
	}
	return writes, nil
}

// seedStore creates rows with version-guarded creates.
func seedStore(ctx context.Context, store nosql.Store, rows []nosql.Row) error {
	if len(rows) == 0 {
		return nil
	}
	writes := make([]nosql.Write, len(rows))
	for i, row := range rows {
		writes[i] = nosql.Write{Row: row}
	}
	return store.Transact(ctx, writes)
}

// nosqlJSONSubject: a jsonstore on a fresh temporary file holding init.rows.
func nosqlJSONSubject(ctx context.Context, init json.RawMessage) (conformance.Instance, error) {
	var config struct {
		Rows []nosql.Row `json:"rows"`
	}
	if err := json.Unmarshal(init, &config); err != nil {
		return conformance.Instance{}, fmt.Errorf("init: %w", err)
	}
	dir, err := os.MkdirTemp("", "rt-contract-nosql-json-")
	if err != nil {
		return conformance.Instance{}, err
	}
	store := jsonstore.New(filepath.Join(dir, "db.json"))
	if err := seedStore(ctx, store, config.Rows); err != nil {
		_ = os.RemoveAll(dir)
		return conformance.Instance{}, err
	}
	return conformance.Instance{Methods: storeMethods(store), Close: func() error { return os.RemoveAll(dir) }}, nil
}

func jsonStoreSubject(ctx context.Context, init json.RawMessage) (conformance.Instance, error) {
	var config struct {
		Rows        []nosql.Row `json:"rows"`
		Text        *string     `json:"text"`
		Path        string      `json:"path"`
		LockTimeout *float64    `json:"lockTimeout"`
		Now         *float64    `json:"now"`
	}
	if err := json.Unmarshal(init, &config); err != nil {
		return conformance.Instance{}, fmt.Errorf("init: %w", err)
	}
	dir, err := os.MkdirTemp("", "rt-contract-json-")
	if err != nil {
		return conformance.Instance{}, err
	}
	cleanup := func() error { return os.RemoveAll(dir) }
	if config.Path == "" {
		config.Path = "db.json"
	}
	file := filepath.Join(dir, config.Path)
	var mu sync.Mutex
	now := float64(jsonDefaultNow)
	if config.Now != nil {
		now = *config.Now
	}
	clock := func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		return time.UnixMilli(int64(now))
	}
	open := func() *jsonstore.Store {
		opts := []jsonstore.Option{jsonstore.WithClock(clock)}
		if config.LockTimeout != nil {
			opts = append(opts, jsonstore.WithLockTimeout(time.Duration(*config.LockTimeout*float64(time.Millisecond))))
		}
		return jsonstore.New(file, opts...)
	}
	if config.Text != nil {
		if err := os.WriteFile(file, []byte(*config.Text), 0o644); err != nil {
			_ = cleanup()
			return conformance.Instance{}, err
		}
	}
	store := open()
	if err := seedStore(ctx, store, config.Rows); err != nil {
		_ = cleanup()
		return conformance.Instance{}, err
	}
	path := func(args []json.RawMessage, i int) (string, error) {
		var name *string
		if err := decodeArgs(args[min(len(args), i):], &name); err != nil {
			return "", err
		}
		if name == nil {
			return file, nil
		}
		return filepath.Join(dir, *name), nil
	}
	missing := func(value any, err error) (any, error) {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return value, err
	}
	methods := storeMethods(store)
	// race(writes, count): count store instances run the same transaction at once.
	methods["race"] = func(ctx context.Context, args []json.RawMessage) (any, error) {
		writes, err := looseWrites(arg(args, 0))
		if err != nil {
			return nil, err
		}
		var count int
		if err := decodeArgs(args[min(len(args), 1):], &count); err != nil {
			return nil, err
		}
		results := make([]error, count)
		var wg sync.WaitGroup
		for i := range count {
			wg.Go(func() { results[i] = open().Transact(ctx, writes) })
		}
		wg.Wait()
		committed, conflicts, other := 0, 0, []string{}
		for _, err := range results {
			if err == nil {
				committed++
			} else if httpErr, ok := apperr.As(err); ok && httpErr.Status == 409 {
				conflicts++
			} else {
				other = append(other, err.Error())
			}
		}
		return map[string]any{"committed": committed, "conflicts": conflicts, "errors": other}, nil
	}
	methods["document"] = func(context.Context, []json.RawMessage) (any, error) {
		raw, err := os.ReadFile(file)
		if err != nil {
			return missing(nil, err)
		}
		var value any
		return value, json.Unmarshal(raw, &value)
	}
	methods["text"] = func(_ context.Context, args []json.RawMessage) (any, error) {
		name, err := path(args, 0)
		if err != nil {
			return nil, err
		}
		raw, err := os.ReadFile(name)
		if err != nil {
			return missing(nil, err)
		}
		return string(raw), nil
	}
	methods["writeText"] = func(_ context.Context, args []json.RawMessage) (any, error) {
		var text string
		if err := decodeArgs(args, &text); err != nil {
			return nil, err
		}
		name, err := path(args, 1)
		if err != nil {
			return nil, err
		}
		return nil, os.WriteFile(name, []byte(text), 0o644)
	}
	methods["remove"] = func(_ context.Context, args []json.RawMessage) (any, error) {
		name, err := path(args, 0)
		if err != nil {
			return nil, err
		}
		return nil, os.Remove(name)
	}
	methods["mode"] = func(_ context.Context, args []json.RawMessage) (any, error) {
		name, err := path(args, 0)
		if err != nil {
			return nil, err
		}
		info, err := os.Stat(name)
		if err != nil {
			return missing(nil, err)
		}
		return strconv.FormatUint(uint64(info.Mode().Perm()), 8), nil
	}
	methods["chmod"] = func(_ context.Context, args []json.RawMessage) (any, error) {
		var mode string
		if err := decodeArgs(args, &mode); err != nil {
			return nil, err
		}
		bits, err := strconv.ParseUint(mode, 8, 32)
		if err != nil {
			return nil, err
		}
		name, err := path(args, 1)
		if err != nil {
			return nil, err
		}
		return nil, os.Chmod(name, os.FileMode(bits))
	}
	methods["files"] = func(context.Context, []json.RawMessage) (any, error) {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return nil, err
		}
		names := make([]string, 0, len(entries))
		for _, e := range entries {
			names = append(names, e.Name())
		}
		slices.Sort(names)
		return names, nil
	}
	methods["lock"] = func(context.Context, []json.RawMessage) (any, error) {
		return nil, os.WriteFile(file+".lock", nil, 0o644)
	}
	methods["unlock"] = func(context.Context, []json.RawMessage) (any, error) {
		return nil, os.Remove(file + ".lock")
	}
	methods["setNow"] = func(_ context.Context, args []json.RawMessage) (any, error) {
		var ms float64
		if err := decodeArgs(args, &ms); err != nil {
			return nil, err
		}
		mu.Lock()
		now = ms
		mu.Unlock()
		return nil, nil
	}
	methods["localSecret"] = func(context.Context, []json.RawMessage) (any, error) {
		return jsonstore.LocalSecret(file)
	}
	return conformance.Instance{Methods: methods, Close: cleanup}, nil
}
