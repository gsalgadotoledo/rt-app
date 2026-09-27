package main

// Subject: idempotency (mirrors spec/hosts/node/idempotency.mjs): an executor over a
// NoSQLStore on a MemoryStore holding init.rows, with a settable ISO clock, a log of the works
// that ran and store fault injection.

import (
	"context"
	"encoding/json"
	"errors"
	"sync"

	"rt.local/core-go/conformance"
	"rt.local/core-go/idempotency"
)

func init() {
	register("idempotency", idempotencySubject)
}

// idempotencyRequest decodes {scope, key, input} loosely: a non-string scope or key is invalid
// (sent as ""), and a missing input is undefined.
func idempotencyRequest(raw json.RawMessage) idempotency.Request {
	var fields map[string]any
	_ = json.Unmarshal(raw, &fields)
	scope, _ := fields["scope"].(string)
	key, _ := fields["key"].(string)
	input, has := fields["input"]
	return idempotency.Request{Scope: scope, Key: key, Input: input, NoInput: !has}
}

// workOutcome: {result} is returned, {error} is returned as an error, {during: [request,
// outcome]} runs a nested execute inside the work.
type workOutcome struct {
	Result any               `json:"result"`
	Error  *string           `json:"error"`
	During []json.RawMessage `json:"during"`
}

type idempotencyFacade struct {
	executor *idempotency.Executor
	mu       sync.Mutex
	log      []map[string]any
}

func (f *idempotencyFacade) work(raw json.RawMessage) idempotency.Work {
	var outcome workOutcome
	_ = json.Unmarshal(raw, &outcome)
	return func(ctx context.Context, c idempotency.Context) (any, error) {
		entry := map[string]any{"input": c.Input, "idempotencyKey": c.IdempotencyKey}
		f.mu.Lock()
		f.log = append(f.log, entry)
		f.mu.Unlock()
		if len(outcome.During) == 2 {
			value, err := f.executor.Execute(ctx, idempotencyRequest(outcome.During[0]), f.work(outcome.During[1]))
			var during map[string]any
			if err != nil {
				var coded interface{ Code() string }
				code := ""
				if errors.As(err, &coded) {
					code = coded.Code()
				}
				during = map[string]any{"error": map[string]any{"code": code, "message": err.Error()}}
			} else {
				during = map[string]any{"value": value}
			}
			f.mu.Lock()
			entry["during"] = during
			f.mu.Unlock()
		}
		if outcome.Error != nil {
			return nil, errors.New(*outcome.Error)
		}
		return outcome.Result, nil
	}
}

func idempotencySubject(ctx context.Context, init json.RawMessage) (conformance.Instance, error) {
	clock, err := newClock(init)
	if err != nil {
		return conformance.Instance{}, err
	}
	memory, err := memoryStore(ctx, init)
	if err != nil {
		return conformance.Instance{}, err
	}
	store := &faultyStore{Store: memory}
	adapter := idempotency.NewNoSQLStore(store, idempotency.WithClock(clock.Now))
	f := &idempotencyFacade{executor: idempotency.New(adapter)}
	if err := f.executor.Init(); err != nil {
		return conformance.Instance{}, err
	}
	claimArg := func(args []json.RawMessage) (idempotency.Claim, error) {
		var claim idempotency.Claim
		return claim, decodeArgs(args, &claim)
	}
	return conformance.Instance{Methods: map[string]conformance.Method{
		// execute(request, outcome) → result | replayed result | {code, message} error
		"execute": func(ctx context.Context, args []json.RawMessage) (any, error) {
			return f.executor.Execute(ctx, idempotencyRequest(arg(args, 0)), f.work(arg(args, 1)))
		},
		// calls() → [{input, idempotencyKey, during?}]
		"calls": func(context.Context, []json.RawMessage) (any, error) {
			f.mu.Lock()
			defer f.mu.Unlock()
			out := make([]map[string]any, len(f.log))
			copy(out, f.log)
			return out, nil
		},
		// claim(claim) → {state, result?}
		"claim": func(ctx context.Context, args []json.RawMessage) (any, error) {
			claim, err := claimArg(args)
			if err != nil {
				return nil, err
			}
			decision, err := adapter.Claim(ctx, claim)
			if err != nil {
				return nil, err
			}
			out := map[string]any{"state": decision.State}
			if decision.HasResult {
				out["result"] = decision.Result
			}
			return out, nil
		},
		// complete(claim, result) → null
		"complete": func(ctx context.Context, args []json.RawMessage) (any, error) {
			claim, err := claimArg(args)
			if err != nil {
				return nil, err
			}
			var result any
			if err := decodeArgs(args[min(len(args), 1):], &result); err != nil {
				return nil, err
			}
			return nil, adapter.Complete(ctx, claim, result)
		},
		// markUncertain(claim) → null
		"markUncertain": func(ctx context.Context, args []json.RawMessage) (any, error) {
			claim, err := claimArg(args)
			if err != nil {
				return nil, err
			}
			return nil, adapter.MarkUncertain(ctx, claim)
		},
		"row":          cacheRowMethod(store),
		"injectFaults": func(_ context.Context, args []json.RawMessage) (any, error) { return store.inject(args) },
		"setNow":       clock.setNow,
		// initUnconfigured() and executeUnconfigured(request): NOT_CONFIGURED without a store.
		"initUnconfigured": func(context.Context, []json.RawMessage) (any, error) {
			return nil, (&idempotency.Executor{}).Init()
		},
		"executeUnconfigured": func(ctx context.Context, args []json.RawMessage) (any, error) {
			return (&idempotency.Executor{}).Execute(ctx, idempotencyRequest(arg(args, 0)), f.work(json.RawMessage(`{"result":null}`)))
		},
	}}, nil
}
