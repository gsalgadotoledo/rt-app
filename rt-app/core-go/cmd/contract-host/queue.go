package main

// Subject: queue. A facade over queue.New(adapter, WithClock, WithRandom) on a queue.Memory with
// the surface of spec/hosts/node/queue.mjs; see docs/polyglot/queue.md. The facade adapter
// numbers every delivery it hands out (receive, workOnce, run) 0, 1, 2…

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"slices"
	"sync"
	"time"

	"rt.local/core-go/conformance"
	"rt.local/core-go/internal/js"
	"rt.local/core-go/queue"
)

func init() {
	register("queue", queueSubject)
}

// queueAdapter delegates to the memory adapter, records deliveries and may declare other
// capabilities (init.capabilities).
type queueAdapter struct {
	memory *queue.Memory
	caps   queue.Capabilities

	mu         sync.Mutex
	deliveries []queue.Delivery
}

func (a *queueAdapter) Capabilities() queue.Capabilities { return a.caps }
func (a *queueAdapter) Publish(ctx context.Context, m queue.Message) error {
	return a.memory.Publish(ctx, m)
}
func (a *queueAdapter) Receive(ctx context.Context, limit int) ([]queue.Delivery, error) {
	list, err := a.memory.Receive(ctx, limit)
	a.mu.Lock()
	a.deliveries = append(a.deliveries, list...)
	a.mu.Unlock()
	return list, err
}
func (a *queueAdapter) InspectFailures(ctx context.Context, limit int) ([]queue.FailedMessage, error) {
	return a.memory.InspectFailures(ctx, limit)
}
func (a *queueAdapter) RetryFailure(ctx context.Context, token string) error {
	return a.memory.RetryFailure(ctx, token)
}

func (a *queueAdapter) number(d queue.Delivery) int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return slices.Index(a.deliveries, d)
}

func (a *queueAdapter) delivery(v any) (queue.Delivery, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	f, ok := js.Integer(v)
	if !ok || f < 0 || int(f) >= len(a.deliveries) {
		return nil, fmt.Errorf("Unknown delivery %v", v)
	}
	return a.deliveries[int(f)], nil
}

// wireInt converts a wire integer; anything else becomes invalid (0) so the module reports it.
func wireInt(v any) int {
	if f, ok := js.Integer(v); ok && math.Abs(f) < 1<<53 {
		return int(f)
	}
	return 0
}

// wireSeconds converts wire seconds to a duration; non-numbers become invalid (-1 s) so the
// module reports them after its own checks.
func wireSeconds(v any) time.Duration {
	if f, ok := v.(float64); ok && math.Abs(f) < 1e9 {
		return time.Duration(f * float64(time.Second))
	}
	return -time.Second
}

type handledEntry struct {
	Delivery int            `json:"delivery"`
	ID       string         `json:"id"`
	Attempts int            `json:"attempts"`
	Nested   map[string]any `json:"nested,omitempty"`
}

func queueSubject(_ context.Context, init json.RawMessage) (conformance.Instance, error) {
	now, err := newClock(init)
	if err != nil {
		return conformance.Instance{}, err
	}
	config, _ := decodeAny(init).(map[string]any)
	capacity := 1000
	if v := config["capacity"]; v != nil {
		capacity = wireInt(v)
	}
	lease := 30 * time.Second
	if v := config["leaseSeconds"]; v != nil {
		if lease = wireSeconds(v); lease < 0 {
			lease = 0
		}
	}
	memory, err := queue.NewMemory(capacity, lease, queue.WithClock(now.Now))
	if err != nil {
		return conformance.Instance{}, err
	}
	adapter := &queueAdapter{memory: memory, caps: memory.Capabilities()}
	if caps, ok := config["capabilities"].(map[string]any); ok {
		flag := func(name string) bool { b, _ := caps[name].(bool); return b }
		adapter.caps = queue.Capabilities{DelayedRetry: flag("delayedRetry"), LeaseRenewal: flag("leaseRenewal"), Durable: flag("durable"), FailedAdmin: flag("failedAdmin")}
	}
	opts := []queue.Option{queue.WithClock(now.Now)}
	if r, ok := config["random"].(float64); ok {
		opts = append(opts, queue.WithRandom(func() float64 { return r }))
	}
	q := queue.New(adapter, opts...)
	feature := q.Feature()

	var logMu sync.Mutex
	var log []*handledEntry
	// handler follows outcomes[messageId]: "ok" (default), "fail", "ack" or "nested".
	handler := func(outcomes any, after func()) queue.Handler {
		table, _ := outcomes.(map[string]any)
		return func(ctx context.Context, d queue.Delivery) error {
			if after != nil {
				defer after()
			}
			entry := &handledEntry{Delivery: adapter.number(d), ID: d.Message().ID, Attempts: d.Attempts()}
			logMu.Lock()
			log = append(log, entry)
			logMu.Unlock()
			switch table[d.Message().ID] {
			case "fail":
				return errors.New("fail")
			case "ack":
				return d.Ack(ctx)
			case "nested":
				if _, err := q.WorkOnce(ctx, func(context.Context, queue.Delivery) error { return nil }, queue.DefaultWorkerOptions); err != nil {
					entry.Nested = map[string]any{"error": err.Error()}
				} else {
					entry.Nested = map[string]any{"value": "no error"}
				}
			}
			return nil
		}
	}
	options := func(v any) queue.WorkerOptions {
		m, _ := v.(map[string]any)
		return queue.WorkerOptionsFrom(m)
	}
	body := func(args []json.RawMessage) map[string]any {
		m, _ := argAny(args, 0).(map[string]any)
		if m == nil {
			m = map[string]any{}
		}
		return m
	}
	settle := func(do func(ctx context.Context, d queue.Delivery, args []json.RawMessage) error) conformance.Method {
		return func(ctx context.Context, args []json.RawMessage) (any, error) {
			d, err := adapter.delivery(argAny(args, 0))
			if err != nil {
				return nil, err
			}
			return nil, do(ctx, d, args)
		}
	}
	return conformance.Instance{Methods: map[string]conformance.Method{
		// publish(message) → null; the capacity is checked before the message, as in TypeScript.
		"publish": func(ctx context.Context, args []json.RawMessage) (any, error) {
			m, err := queue.MessageFrom(argAny(args, 0))
			if err != nil {
				if full := adapter.Publish(ctx, queue.Message{}); errors.Is(full, queue.ErrCapacity) {
					return nil, full
				}
				return nil, err
			}
			return nil, adapter.Publish(ctx, m)
		},
		// receive(limit) → [{delivery, attempts, message}]
		"receive": func(ctx context.Context, args []json.RawMessage) (any, error) {
			list, err := adapter.Receive(ctx, wireInt(argAny(args, 0)))
			if err != nil {
				return nil, err
			}
			out := make([]map[string]any, len(list))
			for i, d := range list {
				out[i] = map[string]any{"delivery": adapter.number(d), "attempts": d.Attempts(), "message": d.Message()}
			}
			return out, nil
		},
		"ack": settle(func(ctx context.Context, d queue.Delivery, _ []json.RawMessage) error { return d.Ack(ctx) }),
		"retry": settle(func(ctx context.Context, d queue.Delivery, args []json.RawMessage) error {
			return d.Retry(ctx, wireSeconds(argAny(args, 1)))
		}),
		"extend": settle(func(ctx context.Context, d queue.Delivery, args []json.RawMessage) error {
			return d.Extend(ctx, wireSeconds(argAny(args, 1)))
		}),
		"deadLetter": settle(func(ctx context.Context, d queue.Delivery, _ []json.RawMessage) error { return d.DeadLetter(ctx) }),
		"inspectFailures": func(ctx context.Context, args []json.RawMessage) (any, error) {
			return adapter.InspectFailures(ctx, wireInt(argAny(args, 0)))
		},
		"retryFailure": func(ctx context.Context, args []json.RawMessage) (any, error) {
			return nil, adapter.RetryFailure(ctx, argString(args, 0))
		},
		"deadLetters":  func(context.Context, []json.RawMessage) (any, error) { return memory.DeadLetters(), nil },
		"capabilities": func(context.Context, []json.RawMessage) (any, error) { return adapter.caps, nil },
		// send(type, payload, {id?, traceId?}) → id
		"send": func(ctx context.Context, args []json.RawMessage) (any, error) {
			var sendOpts []queue.SendOption
			if o, ok := argAny(args, 2).(map[string]any); ok {
				if id, present := o["id"]; present && id != nil {
					s, _ := id.(string) // a non-string id is kept and rejected: "" here
					sendOpts = append(sendOpts, queue.WithID(s))
				}
				if trace, ok := o["traceId"].(string); ok {
					sendOpts = append(sendOpts, queue.WithTraceID(trace))
				}
			}
			return q.Send(ctx, argString(args, 0), argAny(args, 1), sendOpts...)
		},
		// workOnce(outcomes, options) → number of deliveries
		"workOnce": func(ctx context.Context, args []json.RawMessage) (any, error) {
			return q.WorkOnce(ctx, handler(argAny(args, 0), nil), options(argAny(args, 1)))
		},
		// run(outcomes, options, stopAfter) → null; cancelled after stopAfter handled messages.
		"run": func(ctx context.Context, args []json.RawMessage) (any, error) {
			ctx, cancel := context.WithCancel(ctx)
			defer cancel()
			stopAfter, _ := argAny(args, 2).(float64)
			if !(stopAfter > 0) {
				cancel()
			}
			var mu sync.Mutex
			handled := 0.0
			after := func() {
				mu.Lock()
				defer mu.Unlock()
				if handled++; handled >= stopAfter {
					cancel()
				}
			}
			return nil, q.Run(ctx, handler(argAny(args, 0), after), options(argAny(args, 1)))
		},
		"handled": func(context.Context, []json.RawMessage) (any, error) {
			logMu.Lock()
			defer logMu.Unlock()
			out := slices.Clone(log)
			slices.SortStableFunc(out, func(a, b *handledEntry) int { return a.Delivery - b.Delivery })
			if out == nil {
				out = []*handledEntry{}
			}
			return out, nil
		},
		"status": func(context.Context, []json.RawMessage) (any, error) { return q.Status(), nil },
		"inspect": func(ctx context.Context, args []json.RawMessage) (any, error) {
			return q.Inspect(ctx, body(args))
		},
		"retryFailed": func(ctx context.Context, args []json.RawMessage) (any, error) {
			return q.RetryFailed(ctx, body(args))
		},
		"endpoints":  func(context.Context, []json.RawMessage) (any, error) { return routes(feature), nil },
		"admin":      func(context.Context, []json.RawMessage) (any, error) { return queue.Admin(), nil },
		"migrations": func(context.Context, []json.RawMessage) (any, error) { return []any{}, nil },
		"validateMessage": func(_ context.Context, args []json.RawMessage) (any, error) {
			return queue.MessageFrom(argAny(args, 0))
		},
		"validateFailureLimit": func(_ context.Context, args []json.RawMessage) (any, error) {
			return nil, queue.ValidateFailureLimit(wireInt(argAny(args, 0)))
		},
		"setNow": now.setNow,
	}}, nil
}
