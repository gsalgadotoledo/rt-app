package main

// Subjects: nosql-memory, nosql-json (jsonstore.go), feature-flags.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"rt.local/core-go/conformance"
	"rt.local/core-go/featureflags"
	"rt.local/core-go/nosql"
)

func init() {
	register("nosql-memory", memoryStoreSubject)
	register("nosql-json", nosqlJSONSubject)
	register("feature-flags", featureFlagsSubject)
}

// memoryStore returns a store holding init.rows, written as version-guarded creates.
func memoryStore(ctx context.Context, init json.RawMessage) (*nosql.MemoryStore, error) {
	var config struct {
		Rows []nosql.Row `json:"rows"`
	}
	if err := json.Unmarshal(init, &config); err != nil {
		return nil, fmt.Errorf("init: %w", err)
	}
	store := nosql.NewMemoryStore()
	if len(config.Rows) > 0 {
		writes := make([]nosql.Write, len(config.Rows))
		for i, row := range config.Rows {
			writes[i] = nosql.Write{Row: row}
		}
		if err := store.Transact(ctx, writes); err != nil {
			return nil, err
		}
	}
	return store, nil
}

func memoryStoreSubject(ctx context.Context, init json.RawMessage) (conformance.Instance, error) {
	store, err := memoryStore(ctx, init)
	if err != nil {
		return conformance.Instance{}, err
	}
	return conformance.Instance{Methods: map[string]conformance.Method{
		// get(pk, sk) → row | null
		"get": func(ctx context.Context, args []json.RawMessage) (any, error) {
			var pk, sk string
			if err := decodeArgs(args, &pk, &sk); err != nil {
				return nil, err
			}
			return store.Get(ctx, pk, sk)
		},
		// transact(writes) → null
		"transact": func(ctx context.Context, args []json.RawMessage) (any, error) {
			var writes []nosql.Write
			if err := decodeArgs(args, &writes); err != nil {
				return nil, err
			}
			return nil, store.Transact(ctx, writes)
		},
		// list(pk, cursor?) → {items, cursor?}
		"list": func(ctx context.Context, args []json.RawMessage) (any, error) {
			var pk, cursor string
			if err := decodeArgs(args, &pk, &cursor); err != nil {
				return nil, err
			}
			return store.List(ctx, pk, cursor)
		},
	}}, nil
}

func featureFlagsSubject(ctx context.Context, init json.RawMessage) (conformance.Instance, error) {
	store, err := memoryStore(ctx, init)
	if err != nil {
		return conformance.Instance{}, err
	}
	flags := featureflags.New(store)
	return conformance.Instance{Methods: map[string]conformance.Method{
		// get(key) → flag | null
		"get": func(ctx context.Context, args []json.RawMessage) (any, error) {
			key, err := featureflags.ParseKey(arg(args, 0))
			if err != nil {
				return nil, err
			}
			return flags.Get(ctx, key)
		},
		// save(key, definition, version, actorId) → flag
		"save": func(ctx context.Context, args []json.RawMessage) (any, error) {
			key, err := featureflags.ParseKey(arg(args, 0))
			if err != nil {
				return nil, err
			}
			def, err := featureflags.ParseDefinition(arg(args, 1))
			if err != nil {
				return nil, err
			}
			var version *int
			if len(args) > 2 {
				version, err = featureflags.ParseVersion(args[2])
			} else {
				version, err = featureflags.VersionFrom(nil, false)
			}
			if err != nil {
				return nil, err
			}
			var actor string
			if err := decodeArgs(args[min(len(args), 3):], &actor); err != nil {
				return nil, err
			}
			return flags.Save(ctx, key, def, version, actor)
		},
		// enabled(key, subject?, publicOnly?) → bool; the subject is checked before the key.
		"enabled": func(ctx context.Context, args []json.RawMessage) (any, error) {
			subject := ""
			if len(args) > 1 {
				var err error
				if subject, err = featureflags.ParseSubject(args[1]); err != nil {
					return nil, err
				}
			}
			key, err := featureflags.ParseKey(arg(args, 0))
			if err != nil {
				return nil, err
			}
			return flags.Enabled(ctx, key, subject, len(args) > 2 && truthy(args[2]))
		},
		// list(cursor?) → {items, cursor?}
		"list": func(ctx context.Context, args []json.RawMessage) (any, error) {
			var cursor string
			if err := decodeArgs(args, &cursor); err != nil {
				return nil, err
			}
			return flags.List(ctx, cursor)
		},
	}}, nil
}

// arg returns argument i, or null when it is missing.
func arg(args []json.RawMessage, i int) json.RawMessage {
	if i < len(args) {
		return args[i]
	}
	return json.RawMessage("null")
}

// decodeArgs decodes positional arguments; missing or null arguments keep their zero value
// and extra arguments are ignored, as in JavaScript.
func decodeArgs(args []json.RawMessage, into ...any) error {
	for i, raw := range args[:min(len(args), len(into))] {
		if err := json.Unmarshal(raw, into[i]); err != nil {
			return errors.Join(fmt.Errorf("argument %d", i+1), err)
		}
	}
	return nil
}

// truthy follows JavaScript truthiness for a JSON value.
func truthy(raw json.RawMessage) bool {
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return false
	}
	switch v := value.(type) {
	case nil:
		return false
	case bool:
		return v
	case float64:
		return v != 0
	case string:
		return v != ""
	default:
		return true
	}
}
