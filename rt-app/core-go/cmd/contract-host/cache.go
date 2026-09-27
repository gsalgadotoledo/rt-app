package main

// Subjects: cache-memory, cache-nosql, cache-file, cache-dynamodb (RT_APP_TEST_DYNAMODB_ENDPOINT).
// Every subject is a facade over cache.New(adapter) with a settable clock (epoch ms), mirroring
// spec/hosts/node/cache.mjs.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	ddb "github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"rt.local/core-go/apperr"
	"rt.local/core-go/cache"
	"rt.local/core-go/cache/dynamocache"
	"rt.local/core-go/conformance"
	"rt.local/core-go/nosql"
)

func init() {
	register("cache-memory", cacheMemorySubject)
	register("cache-nosql", cacheNoSQLSubject)
	register("cache-file", cacheFileSubject)
	if endpoint := os.Getenv("RT_APP_TEST_DYNAMODB_ENDPOINT"); endpoint != "" {
		register("cache-dynamodb", func(ctx context.Context, init json.RawMessage) (conformance.Instance, error) {
			return cacheDynamoSubject(ctx, endpoint, init)
		})
	}
}

// cacheInit is the init of every cache subject.
type cacheInit struct {
	Now       *float64    `json:"now"`
	Capacity  any         `json:"capacity"`
	Namespace *string     `json:"namespace"`
	Rows      []nosql.Row `json:"rows"`
}

func parseCacheInit(init json.RawMessage) (cacheInit, error) {
	var config cacheInit
	if err := json.Unmarshal(init, &config); err != nil {
		return config, fmt.Errorf("init: %w", err)
	}
	return config, nil
}

func (c cacheInit) namespace() string {
	if c.Namespace == nil {
		return "default"
	}
	return *c.Namespace
}

// msClock is a settable clock in epoch milliseconds (2100-01-01 when init.now is absent).
type msClock struct {
	mu sync.Mutex
	ms int64
}

func newMsClock(now *float64) *msClock {
	if now == nil {
		return &msClock{ms: 4102444800000}
	}
	return &msClock{ms: int64(*now)}
}

func (c *msClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return time.UnixMilli(c.ms)
}

func (c *msClock) set(args []json.RawMessage) (any, error) {
	var ms any
	if err := decodeArgs(args, &ms); err != nil {
		return nil, err
	}
	f, ok := ms.(float64)
	if !ok || math.IsInf(f, 0) {
		return nil, errors.New("setNow needs epoch milliseconds")
	}
	c.mu.Lock()
	c.ms = int64(f)
	c.mu.Unlock()
	return nil, nil
}

// faultyStore fails its next transactions on purpose, one queued fault per transaction: "ok"
// passes through, "conflict" returns a Conflict and "error" returns "Store unavailable" (both
// without writing), "lostAck" writes and then returns "Acknowledgement lost".
type faultyStore struct {
	nosql.Store
	mu        sync.Mutex
	faults    []string
	transacts int
}

func (f *faultyStore) Transact(ctx context.Context, writes []nosql.Write) error {
	f.mu.Lock()
	f.transacts++
	fault := ""
	if len(f.faults) > 0 {
		fault, f.faults = f.faults[0], f.faults[1:]
	}
	f.mu.Unlock()
	switch fault {
	case "conflict":
		return apperr.Conflict()
	case "error":
		return errors.New("Store unavailable")
	}
	if err := f.Store.Transact(ctx, writes); err != nil {
		return err
	}
	if fault == "lostAck" {
		return errors.New("Acknowledgement lost")
	}
	return nil
}

// injectFaults(kind, count?) → null
func (f *faultyStore) inject(args []json.RawMessage) (any, error) {
	var kind string
	var count *float64
	if err := decodeArgs(args, &kind, &count); err != nil {
		return nil, err
	}
	switch kind {
	case "ok", "conflict", "error", "lostAck":
	default:
		return nil, fmt.Errorf("Unknown fault %s", kind)
	}
	n := 1
	if count != nil {
		n = int(*count)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	for range n {
		f.faults = append(f.faults, kind)
	}
	return nil, nil
}

func (f *faultyStore) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.transacts
}

// cacheFacade is the shared surface: Cache methods plus loader bookkeeping and the clock.
type cacheFacade struct {
	mu    sync.Mutex
	cache *cache.Cache
	clock *msClock
	loads atomic.Int64
}

func (f *cacheFacade) current() *cache.Cache {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.cache
}

func (f *cacheFacade) replace(c *cache.Cache) {
	f.mu.Lock()
	f.cache = c
	f.mu.Unlock()
}

// outcome of a loader: {value} is returned, {error} is returned as an error.
type loaderOutcome struct {
	Value any     `json:"value"`
	Error *string `json:"error"`
}

func (f *cacheFacade) methods() map[string]conformance.Method {
	return map[string]conformance.Method{
		// get(key) → {hit:false} | {hit:true, value}
		"get": func(ctx context.Context, args []json.RawMessage) (any, error) {
			var key string
			if err := decodeArgs(args, &key); err != nil {
				return nil, err
			}
			value, ok, err := f.current().Get(ctx, key)
			if err != nil {
				return nil, err
			}
			if !ok {
				return map[string]any{"hit": false}, nil
			}
			return map[string]any{"hit": true, "value": value}, nil
		},
		// set(key, value, ttlMs) → null
		"set": func(ctx context.Context, args []json.RawMessage) (any, error) {
			var key string
			var value, ms any
			if err := decodeArgs(args, &key, &value, &ms); err != nil {
				return nil, err
			}
			ttl, err := cache.TTLFromMillis(ms)
			if err != nil {
				return nil, err
			}
			return nil, f.current().Set(ctx, key, value, ttl)
		},
		// delete(key) → null
		"delete": func(ctx context.Context, args []json.RawMessage) (any, error) {
			var key string
			if err := decodeArgs(args, &key); err != nil {
				return nil, err
			}
			return nil, f.current().Delete(ctx, key)
		},
		// remember(namespace, input, ttlMs, outcome) → value
		"remember": func(ctx context.Context, args []json.RawMessage) (any, error) {
			var namespace string
			var input, ms any
			var outcome loaderOutcome
			if err := decodeArgs(args, &namespace, &input, &ms, &outcome); err != nil {
				return nil, err
			}
			ttl, err := rememberTTL(namespace, input, ms)
			if err != nil {
				return nil, err
			}
			return f.current().Remember(ctx, namespace, input, ttl, func(context.Context) (any, error) {
				f.loads.Add(1)
				if outcome.Error != nil {
					return nil, errors.New(*outcome.Error)
				}
				return outcome.Value, nil
			})
		},
		// loads() → number of loader calls
		"loads": func(context.Context, []json.RawMessage) (any, error) { return f.loads.Load(), nil },
		// rememberConcurrently(namespace, input, ttlMs, value, count) → {loads, results}
		"rememberConcurrently": func(ctx context.Context, args []json.RawMessage) (any, error) {
			var namespace string
			var input, ms, value any
			var count int
			if err := decodeArgs(args, &namespace, &input, &ms, &value, &count); err != nil {
				return nil, err
			}
			ttl, err := rememberTTL(namespace, input, ms)
			if err != nil {
				return nil, err
			}
			before := f.loads.Load()
			results := make([]any, count)
			errs := make([]error, count)
			var wg sync.WaitGroup
			c := f.current()
			for i := range count {
				wg.Go(func() {
					results[i], errs[i] = c.Remember(ctx, namespace, input, ttl, func(context.Context) (any, error) {
						f.loads.Add(1)
						time.Sleep(50 * time.Millisecond)
						return value, nil
					})
				})
			}
			wg.Wait()
			if err := errors.Join(errs...); err != nil {
				return nil, err
			}
			return map[string]any{"loads": f.loads.Load() - before, "results": results}, nil
		},
		// canonical(value) → string
		"canonical": func(_ context.Context, args []json.RawMessage) (any, error) {
			var value any
			if err := decodeArgs(args, &value); err != nil {
				return nil, err
			}
			return cache.Canonical(value)
		},
		// contentKey(namespace, input) → string
		"contentKey": func(_ context.Context, args []json.RawMessage) (any, error) {
			var namespace string
			var input any
			if err := decodeArgs(args, &namespace, &input); err != nil {
				return nil, err
			}
			return cache.ContentKey(namespace, input)
		},
		// validateEntry(key, ttlMs) → null
		"validateEntry": func(_ context.Context, args []json.RawMessage) (any, error) {
			var key string
			var ms any
			if err := decodeArgs(args, &key, &ms); err != nil {
				return nil, err
			}
			ttl, err := cache.TTLFromMillis(ms)
			if err != nil {
				return nil, err
			}
			return nil, cache.ValidateEntry(key, ttl)
		},
		// setNow(ms) → null
		"setNow": func(_ context.Context, args []json.RawMessage) (any, error) { return f.clock.set(args) },
	}
}

// rememberTTL converts the TTL after the namespace check, the order of the reference.
func rememberTTL(namespace string, input, ms any) (time.Duration, error) {
	ttl, err := cache.TTLFromMillis(ms)
	if err != nil {
		if _, keyErr := cache.ContentKey(namespace, input); keyErr != nil {
			return 0, keyErr
		}
	}
	return ttl, err
}

// cacheRowMethod exposes row(pk, sk) → raw stored row | null.
func cacheRowMethod(store nosql.Store) conformance.Method {
	return func(ctx context.Context, args []json.RawMessage) (any, error) {
		var pk, sk string
		if err := decodeArgs(args, &pk, &sk); err != nil {
			return nil, err
		}
		return store.Get(ctx, pk, sk)
	}
}

func cacheMemorySubject(_ context.Context, init json.RawMessage) (conformance.Instance, error) {
	config, err := parseCacheInit(init)
	if err != nil {
		return conformance.Instance{}, err
	}
	capacity, err := cache.CapacityFrom(config.Capacity)
	if err != nil {
		return conformance.Instance{}, err
	}
	clock := newMsClock(config.Now)
	memory, err := cache.NewMemory(capacity, cache.WithClock(clock.Now))
	if err != nil {
		return conformance.Instance{}, err
	}
	f := &cacheFacade{cache: cache.New(memory), clock: clock}
	return conformance.Instance{Methods: f.methods()}, nil
}

// cacheNoSQLSubject: NoSQLCache over a MemoryStore holding init.rows, with fault injection.
func cacheNoSQLSubject(ctx context.Context, init json.RawMessage) (conformance.Instance, error) {
	config, err := parseCacheInit(init)
	if err != nil {
		return conformance.Instance{}, err
	}
	memory, err := memoryStore(ctx, init)
	if err != nil {
		return conformance.Instance{}, err
	}
	store := &faultyStore{Store: memory}
	clock := newMsClock(config.Now)
	adapter := func(namespace string) *cache.Cache {
		return cache.New(cache.NewNoSQL(store, namespace, cache.WithClock(clock.Now)))
	}
	f := &cacheFacade{cache: adapter(config.namespace()), clock: clock}
	methods := f.methods()
	methods["row"] = cacheRowMethod(store)
	methods["injectFaults"] = func(_ context.Context, args []json.RawMessage) (any, error) { return store.inject(args) }
	methods["transacts"] = func(context.Context, []json.RawMessage) (any, error) { return store.count(), nil }
	// useNamespace(ns): the same store seen through another namespace.
	methods["useNamespace"] = func(_ context.Context, args []json.RawMessage) (any, error) {
		var namespace string
		if err := decodeArgs(args, &namespace); err != nil {
			return nil, err
		}
		f.replace(adapter(namespace))
		return nil, nil
	}
	return conformance.Instance{Methods: methods}, nil
}

// cacheFileSubject: FileCache on a fresh temporary file; reopen() builds a second instance.
func cacheFileSubject(_ context.Context, init json.RawMessage) (conformance.Instance, error) {
	config, err := parseCacheInit(init)
	if err != nil {
		return conformance.Instance{}, err
	}
	dir, err := os.MkdirTemp("", "rt-contract-cache-")
	if err != nil {
		return conformance.Instance{}, err
	}
	path := filepath.Join(dir, "cache.json")
	clock := newMsClock(config.Now)
	build := func() *cache.Cache {
		return cache.New(cache.NewFile(path, config.namespace(), cache.WithClock(clock.Now)))
	}
	f := &cacheFacade{cache: build(), clock: clock}
	methods := f.methods()
	methods["row"] = cacheRowMethod(cache.NewFileStore(path))
	methods["reopen"] = func(context.Context, []json.RawMessage) (any, error) {
		f.replace(build())
		return nil, nil
	}
	// file() → the parsed file ({format:1, rows:[…]}), or null before the first write.
	methods["file"] = func(context.Context, []json.RawMessage) (any, error) {
		raw, err := os.ReadFile(path)
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		var value any
		return value, json.Unmarshal(raw, &value)
	}
	return conformance.Instance{Methods: methods, Close: func() error { return os.RemoveAll(dir) }}, nil
}

// cacheDynamoSubject: DynamoCache on a fresh DynamoDB Local table, deleted on close.
func cacheDynamoSubject(ctx context.Context, endpoint string, init json.RawMessage) (conformance.Instance, error) {
	config, err := parseCacheInit(init)
	if err != nil {
		return conformance.Instance{}, err
	}
	client := ddb.New(ddb.Options{
		Region:           "us-east-1",
		BaseEndpoint:     aws.String(endpoint),
		Credentials:      credentials.NewStaticCredentialsProvider(envOr("AWS_ACCESS_KEY_ID", "local"), envOr("AWS_SECRET_ACCESS_KEY", "local"), ""),
		RetryMaxAttempts: 3,
		HTTPClient:       &http.Client{Timeout: 8 * time.Second},
	})
	table := uniqueTable()
	_, err = client.CreateTable(ctx, &ddb.CreateTableInput{
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
		return conformance.Instance{}, err
	}
	closeAll := cleanup(func(ctx context.Context) error {
		_, err := client.DeleteTable(ctx, &ddb.DeleteTableInput{TableName: aws.String(table)})
		return err
	})
	clock := newMsClock(config.Now)
	adapter, err := dynamocache.New(client, table, config.namespace(), cache.WithClock(clock.Now))
	if err != nil {
		_ = closeAll()
		return conformance.Instance{}, err
	}
	f := &cacheFacade{cache: cache.New(adapter), clock: clock}
	methods := f.methods()
	methods["row"] = cacheRowMethod(adapter.Store())
	return conformance.Instance{Methods: methods, Close: closeAll}, nil
}
