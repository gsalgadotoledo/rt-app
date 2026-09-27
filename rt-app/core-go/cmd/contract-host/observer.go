package main

// Subjects: observer, observer-rules, observer-console, observer-webhook, observer-slack,
// observer-email, observer-email-local, observer-sms. Each subject is a small facade with the
// surface of spec/hosts/node/observer.mjs; helpers are documented in the contracts and
// docs/polyglot/observer.md. Transports are fakes configured by init: nothing leaves the host.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"slices"
	"strings"
	"sync"
	"time"

	"rt.local/core-go/conformance"
	"rt.local/core-go/internal/uuid"
	"rt.local/core-go/observer"
	"rt.local/core-go/observer/console"
	"rt.local/core-go/observer/email"
	"rt.local/core-go/observer/slack"
	"rt.local/core-go/observer/sms"
	"rt.local/core-go/observer/webhook"
	"rt.local/core-go/web"
)

func init() {
	register("observer", observerSubject)
	register("observer-rules", observerRulesSubject)
	register("observer-console", observerConsoleSubject)
	register("observer-webhook", observerWebhookSubject)
	register("observer-slack", observerSlackSubject)
	register("observer-email", observerEmailSubject)
	register("observer-email-local", observerLocalEmailSubject)
	register("observer-sms", observerSMSSubject)
}

// advance moves the subject clock forward (measure operations).
func (c *clock) advance(ms float64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	at := time.Now()
	if c.fixed != nil {
		at = *c.fixed
	}
	at = at.Add(time.Duration(ms * float64(time.Millisecond)))
	c.fixed = &at
}

// scriptedOutput is an output with a behavior: ok, fail (a secret-looking error), hang (until its
// context is done), slow (20 ms) or mutate (records, then changes its copy).
type scriptedOutput struct {
	id        string
	mu        sync.Mutex
	behavior  string
	delivered []observer.Event
	hung      context.Context
}

func (s *scriptedOutput) ID() string { return s.id }

func (s *scriptedOutput) Write(ctx context.Context, event observer.Event) error {
	s.mu.Lock()
	behavior := s.behavior
	s.hung = nil
	if behavior == "hang" {
		s.hung = ctx
	}
	s.mu.Unlock()
	switch behavior {
	case "fail":
		return errors.New("password=hunter2 at hooks.internal")
	case "hang":
		<-ctx.Done()
		return ctx.Err()
	case "slow":
		time.Sleep(20 * time.Millisecond)
	}
	s.mu.Lock()
	s.delivered = append(s.delivered, event.Clone())
	s.mu.Unlock()
	if behavior == "mutate" {
		event.Message = "mutated by output"
		event.Data["mutated"] = true
	}
	return nil
}

type outputSpec struct {
	ID           string   `json:"id"`
	Type         string   `json:"type"`
	Behavior     string   `json:"behavior"`
	Enabled      *bool    `json:"enabled"`
	Levels       []string `json:"levels"`
	Kinds        []string `json:"kinds"`
	Sources      []string `json:"sources"`
	Categories   []string `json:"categories"`
	MaxPerMinute *float64 `json:"maxPerMinute"`
	Filter       *struct {
		MessageIncludes *string `json:"messageIncludes"`
		Throws          bool    `json:"throws"`
		Mutates         bool    `json:"mutates"`
	} `json:"filter"`
}

func filterFrom(spec outputSpec) func(observer.Event) bool {
	switch {
	case spec.Filter == nil:
		return nil
	case spec.Filter.Throws:
		return func(observer.Event) bool { panic("filter failed") }
	case spec.Filter.Mutates:
		return func(e observer.Event) bool {
			e.Message = "mutated by filter"
			e.Data["mutated"] = true
			return true
		}
	case spec.Filter.MessageIncludes != nil:
		text := *spec.Filter.MessageIncludes
		return func(e observer.Event) bool { return strings.Contains(e.Message, text) }
	}
	return nil
}

// stringFields keeps the string values of a wire object (the log context of Go is map[string]string).
func stringFields(value any) map[string]string {
	object, _ := value.(map[string]any)
	fields := map[string]string{}
	for k, v := range object {
		if s, ok := v.(string); ok {
			fields[k] = s
		}
	}
	return fields
}

func rawArgs(values []any) []json.RawMessage {
	out := make([]json.RawMessage, len(values))
	for i, v := range values {
		out[i], _ = json.Marshal(v)
	}
	return out
}

type step struct {
	Call string `json:"call"`
	Args []any  `json:"args"`
}

func observerSubject(ctx context.Context, init json.RawMessage) (conformance.Instance, error) {
	now, err := newClock(init)
	if err != nil {
		return conformance.Instance{}, err
	}
	var config struct {
		IDs       []string     `json:"ids"`
		TimeoutMs *float64     `json:"timeoutMs"`
		Outputs   []outputSpec `json:"outputs"`
	}
	if err := json.Unmarshal(init, &config); err != nil {
		return conformance.Instance{}, fmt.Errorf("init: %w", err)
	}
	db, err := memoryStore(ctx, init)
	if err != nil {
		return conformance.Instance{}, err
	}
	storage := observer.NewStore(db, now.Now)
	outputs := []observer.Output{}
	scriptedOutputs := map[string]*scriptedOutput{}
	for _, spec := range config.Outputs {
		output := observer.Output{
			Disabled: spec.Enabled != nil && !*spec.Enabled, Levels: spec.Levels, Kinds: spec.Kinds,
			Sources: spec.Sources, Categories: spec.Categories, Filter: filterFrom(spec),
		}
		if spec.MaxPerMinute != nil {
			output.MaxPerMinute = observer.PerMinute(int(*spec.MaxPerMinute))
		}
		if spec.Type == "store" {
			output.Handler = storage
		} else {
			behavior := spec.Behavior
			if behavior == "" {
				behavior = "ok"
			}
			handler := &scriptedOutput{id: spec.ID, behavior: behavior, delivered: []observer.Event{}}
			scriptedOutputs[spec.ID] = handler
			output.Handler = handler
		}
		outputs = append(outputs, output)
	}
	var idMu sync.Mutex
	ids := config.IDs
	options := []observer.Option{observer.WithClock(now.Now), observer.WithIDs(func() string {
		idMu.Lock()
		defer idMu.Unlock()
		if len(ids) == 0 {
			return uuid.New()
		}
		id := ids[0]
		ids = ids[1:]
		return id
	})}
	if config.TimeoutMs != nil {
		options = append(options, observer.WithTimeout(time.Duration(*config.TimeoutMs*float64(time.Millisecond))))
	}
	o, err := observer.New(outputs, options...)
	if err != nil {
		return conformance.Instance{}, err
	}
	feature := observer.Feature(o, storage, nil, now.Now)
	handle := func(ctx context.Context, method, path string, request web.Request) (any, error) {
		for _, e := range feature.Endpoints {
			if e.Method == method && e.Path == path {
				request.Method, request.Path = method, path
				return e.Handle(&web.Context{Ctx: ctx, Request: request, Params: map[string]string{}})
			}
		}
		return nil, fmt.Errorf("no endpoint %s %s", method, path)
	}
	find := func(id string) (*scriptedOutput, error) {
		if s, ok := scriptedOutputs[id]; ok {
			return s, nil
		}
		return nil, fmt.Errorf("Unknown output %s", id)
	}
	logMethod := func(log func(context.Context, ...any) error) conformance.Method {
		return func(ctx context.Context, args []json.RawMessage) (any, error) {
			values := make([]any, len(args))
			for i := range args {
				values[i] = argAny(args, i)
			}
			return nil, log(ctx, values...)
		}
	}
	queryOf := func(args []json.RawMessage) map[string]string {
		query := map[string]string{}
		object, _ := argAny(args, 0).(map[string]any)
		for k, v := range object {
			if s, ok := v.(string); ok {
				query[k] = s
			}
		}
		return query
	}
	ingest := func(ctx context.Context, body map[string]any, ip any) (any, error) {
		address, ok := ip.(string)
		if !ok {
			address = "unknown" // web.Request.IP of a request without a peer address
		}
		if body == nil {
			body = map[string]any{}
		}
		return handle(ctx, "POST", "/observer/events", web.Request{Body: body, IP: address})
	}
	methods := map[string]conformance.Method{}
	call := func(ctx context.Context, s step) (any, error) {
		method, ok := methods[s.Call]
		if !ok {
			return nil, fmt.Errorf("Unknown method %s", s.Call)
		}
		return method(ctx, rawArgs(s.Args))
	}
	table := map[string]conformance.Method{
		"emit": func(ctx context.Context, args []json.RawMessage) (any, error) {
			data, _ := argAny(args, 4).(map[string]any)
			return nil, o.Emit(ctx, argString(args, 0), argString(args, 1), argString(args, 2), argString(args, 3), data)
		},
		"write": func(ctx context.Context, args []json.RawMessage) (any, error) {
			data, _ := argAny(args, 3).(map[string]any)
			return nil, o.Write(ctx, argString(args, 0), argString(args, 1), stringFields(argAny(args, 2)), data)
		},
		"log":     logMethod(o.Log),
		"info":    logMethod(o.Info),
		"debug":   logMethod(o.Debug),
		"warn":    logMethod(o.Warn),
		"warning": logMethod(o.Warning),
		"error":   logMethod(o.Error),
		"countView": func(ctx context.Context, args []json.RawMessage) (any, error) {
			options, _ := argAny(args, 1).(map[string]any)
			view := observer.View{}
			view.URL, _ = options["url"].(string)
			view.APIURL, _ = options["apiUrl"].(string)
			view.Source, _ = options["source"].(string)
			return nil, o.CountView(ctx, argString(args, 0), view)
		},
		// recordRequest({method, url, durationMs, status}): durations and statuses that are not
		// numbers are invalid metrics (Go types them).
		"recordRequest": func(ctx context.Context, args []json.RawMessage) (any, error) {
			metric, _ := argAny(args, 0).(map[string]any)
			duration, okDuration := metric["durationMs"].(float64)
			status, okStatus := metric["status"].(float64)
			if !okDuration || !okStatus {
				return nil, observer.ErrInvalidMetric
			}
			method, _ := metric["method"].(string)
			url, _ := metric["url"].(string)
			return nil, o.RecordRequest(ctx, observer.RequestMetric{Method: method, URL: url, DurationMs: duration, Status: status})
		},
		// measure(name, {value?, fail?, advanceMs?}, {source?}?)
		"measure": func(ctx context.Context, args []json.RawMessage) (any, error) {
			operation, _ := argAny(args, 1).(map[string]any)
			options, _ := argAny(args, 2).(map[string]any)
			source, _ := options["source"].(string)
			return observer.Measure(ctx, o, argString(args, 0), source, func(context.Context) (any, error) {
				if ms, ok := operation["advanceMs"].(float64); ok && ms != 0 {
					now.advance(ms)
				}
				if fail, ok := operation["fail"].(string); ok {
					return nil, errors.New(fail)
				}
				return operation["value"], nil
			})
		},
		// withContext(context, [{call, args}]) → the results of the steps, run inside the context.
		"withContext": func(ctx context.Context, args []json.RawMessage) (any, error) {
			var steps []step
			if err := decodeArgs(args[min(len(args), 1):], &steps); err != nil {
				return nil, err
			}
			inner := o.WithContext(ctx, stringFields(argAny(args, 0)))
			results := []any{}
			for _, s := range steps {
				value, err := call(inner, s)
				if err != nil {
					return nil, err
				}
				results = append(results, value)
			}
			return results, nil
		},
		// parallel([{context, delayMs, steps}]) → null: concurrent branches, each in its context.
		"parallel": func(ctx context.Context, args []json.RawMessage) (any, error) {
			var branches []struct {
				Context map[string]any `json:"context"`
				DelayMs float64        `json:"delayMs"`
				Steps   []step         `json:"steps"`
			}
			if err := decodeArgs(args, &branches); err != nil {
				return nil, err
			}
			errs := make([]error, len(branches))
			var wg sync.WaitGroup
			for i, branch := range branches {
				wg.Go(func() {
					inner := o.WithContext(ctx, stringFields(branch.Context))
					time.Sleep(time.Duration(branch.DelayMs * float64(time.Millisecond)))
					for _, s := range branch.Steps {
						if _, err := call(inner, s); err != nil {
							errs[i] = err
							return
						}
					}
				})
			}
			wg.Wait()
			return nil, errors.Join(errs...)
		},
		// burst(count, level, message) → null: count emits started together.
		"burst": func(ctx context.Context, args []json.RawMessage) (any, error) {
			count, _ := argAny(args, 0).(float64)
			var start, done sync.WaitGroup
			start.Add(1)
			for range int(count) {
				done.Go(func() {
					start.Wait()
					_ = o.Emit(ctx, argString(args, 1), "log", "app", argString(args, 2), map[string]any{})
				})
			}
			start.Done()
			done.Wait()
			return nil, nil
		},
		// emitMany(count, level, message) → null: count emits one after the other.
		"emitMany": func(ctx context.Context, args []json.RawMessage) (any, error) {
			count, _ := argAny(args, 0).(float64)
			for range int(count) {
				_ = o.Emit(ctx, argString(args, 1), "log", "app", argString(args, 2), map[string]any{})
			}
			return nil, nil
		},
		"delivered": func(_ context.Context, args []json.RawMessage) (any, error) {
			s, err := find(argString(args, 0))
			if err != nil {
				return nil, err
			}
			s.mu.Lock()
			defer s.mu.Unlock()
			return slices.Clone(s.delivered), nil
		},
		"aborted": func(_ context.Context, args []json.RawMessage) (any, error) {
			s, err := find(argString(args, 0))
			if err != nil {
				return nil, err
			}
			s.mu.Lock()
			defer s.mu.Unlock()
			return s.hung != nil && s.hung.Err() != nil, nil
		},
		"setBehavior": func(_ context.Context, args []json.RawMessage) (any, error) {
			s, err := find(argString(args, 0))
			if err != nil {
				return nil, err
			}
			s.mu.Lock()
			s.behavior = argString(args, 1)
			s.mu.Unlock()
			return nil, nil
		},
		"health": func(context.Context, []json.RawMessage) (any, error) { return o.Health(), nil },
		"setNow": now.setNow,
		// Storage (Store over the memory store holding init.rows).
		"search": func(ctx context.Context, args []json.RawMessage) (any, error) {
			values, _ := argAny(args, 0).(map[string]any)
			q, err := observer.ParseLogQuery(values)
			if err != nil {
				return nil, err
			}
			return storage.Search(ctx, q)
		},
		"storeReport": func(ctx context.Context, args []json.RawMessage) (any, error) {
			return storage.Report(ctx, argString(args, 0))
		},
		"storeWrite": func(ctx context.Context, args []json.RawMessage) (any, error) {
			var event observer.Event
			if err := decodeArgs(args, &event); err != nil {
				return nil, err
			}
			return nil, storage.Write(ctx, event)
		},
		"list": func(ctx context.Context, args []json.RawMessage) (any, error) {
			return db.List(ctx, argString(args, 0), argString(args, 1))
		},
		// Endpoint handlers (Feature with the same clock).
		"report": func(ctx context.Context, args []json.RawMessage) (any, error) {
			return handle(ctx, "GET", "/observer/report", web.Request{Query: queryOf(args)})
		},
		"logs": func(ctx context.Context, args []json.RawMessage) (any, error) {
			return handle(ctx, "GET", "/observer/logs", web.Request{Query: queryOf(args)})
		},
		"ingest": func(ctx context.Context, args []json.RawMessage) (any, error) {
			body, _ := argAny(args, 0).(map[string]any)
			return ingest(ctx, body, argAny(args, 1))
		},
		"ingestEach": func(ctx context.Context, args []json.RawMessage) (any, error) {
			ips, _ := argAny(args, 0).([]any)
			body, _ := argAny(args, 1).(map[string]any)
			for _, ip := range ips {
				if _, err := ingest(ctx, body, ip); err != nil {
					return nil, err
				}
			}
			return nil, nil
		},
		"endpoints": func(context.Context, []json.RawMessage) (any, error) {
			routes := []map[string]string{}
			for _, e := range feature.Endpoints {
				routes = append(routes, map[string]string{"method": e.Method, "path": e.Path, "resource": e.Resource, "access": e.Access})
			}
			return routes, nil
		},
		"admin": func(context.Context, []json.RawMessage) (any, error) { return observer.AdminPage, nil },
	}
	for name, method := range table {
		methods[name] = method
	}
	return conformance.Instance{Methods: methods}, nil
}

// queryFrom reads a wire log query without validating it (matchesLog takes any query).
func queryFrom(value any) observer.LogQuery {
	object, _ := value.(map[string]any)
	text := func(key string) string { s, _ := object[key].(string); return s }
	return observer.LogQuery{Day: text("day"), Level: text("level"), Category: text("category"), RequestID: text("requestId"), SessionID: text("sessionId"), Text: text("text"), Cursor: text("cursor")}
}

func observerRulesSubject(context.Context, json.RawMessage) (conformance.Instance, error) {
	return conformance.Instance{Methods: map[string]conformance.Method{
		"sanitize": func(_ context.Context, args []json.RawMessage) (any, error) {
			return observer.Sanitize(argAny(args, 0)), nil
		},
		"safePath": func(_ context.Context, args []json.RawMessage) (any, error) {
			return observer.SafePath(argString(args, 0))
		},
		"validateLogQuery": func(_ context.Context, args []json.RawMessage) (any, error) {
			values, _ := argAny(args, 0).(map[string]any)
			_, err := observer.ParseLogQuery(values)
			return nil, err
		},
		"matchesLog": func(_ context.Context, args []json.RawMessage) (any, error) {
			event, _ := argAny(args, 0).(map[string]any)
			return observer.MatchesLog(event, queryFrom(argAny(args, 1))), nil
		},
	}}, nil
}

// eventArg decodes an event argument.
func eventArg(args []json.RawMessage) (observer.Event, error) {
	var event observer.Event
	err := decodeArgs(args, &event)
	return event, err
}

func writeMethod(output observer.Handler) conformance.Method {
	return func(ctx context.Context, args []json.RawMessage) (any, error) {
		event, err := eventArg(args)
		if err != nil {
			return nil, err
		}
		return nil, output.Write(ctx, event)
	}
}

func observerConsoleSubject(context.Context, json.RawMessage) (conformance.Instance, error) {
	var mu sync.Mutex
	lines := []map[string]string{}
	output := console.New(func(level, line string) {
		mu.Lock()
		lines = append(lines, map[string]string{"level": level, "line": line})
		mu.Unlock()
	})
	return conformance.Instance{Methods: map[string]conformance.Method{
		"id":    func(context.Context, []json.RawMessage) (any, error) { return output.ID(), nil },
		"write": writeMethod(output),
		"lines": func(context.Context, []json.RawMessage) (any, error) {
			mu.Lock()
			defer mu.Unlock()
			return slices.Clone(lines), nil
		},
	}}, nil
}

// fakeTransport records requests and answers status (200) or fails with a message.
type fakeTransport struct {
	mu       sync.Mutex
	requests []observer.OutputRequest
	status   int
	failure  *string
}

func newFakeTransport(init json.RawMessage) (*fakeTransport, error) {
	var config struct {
		Status *float64 `json:"status"`
		Fail   *string  `json:"fail"`
	}
	if err := json.Unmarshal(init, &config); err != nil {
		return nil, fmt.Errorf("init: %w", err)
	}
	t := &fakeTransport{requests: []observer.OutputRequest{}, status: 200, failure: config.Fail}
	if config.Status != nil {
		t.status = int(*config.Status)
	}
	return t, nil
}

func (t *fakeTransport) send(_ context.Context, r observer.OutputRequest) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.requests = append(t.requests, r)
	if t.failure != nil {
		return 0, errors.New(*t.failure)
	}
	return t.status, nil
}

func (t *fakeTransport) methods(output observer.Handler) map[string]conformance.Method {
	return map[string]conformance.Method{
		"id":    func(context.Context, []json.RawMessage) (any, error) { return output.ID(), nil },
		"write": writeMethod(output),
		"requests": func(context.Context, []json.RawMessage) (any, error) {
			t.mu.Lock()
			defer t.mu.Unlock()
			return slices.Clone(t.requests), nil
		},
		"setStatus": func(_ context.Context, args []json.RawMessage) (any, error) {
			status, _ := argAny(args, 0).(float64)
			t.mu.Lock()
			t.status = int(status)
			t.mu.Unlock()
			return nil, nil
		},
		"setFailure": func(_ context.Context, args []json.RawMessage) (any, error) {
			t.mu.Lock()
			defer t.mu.Unlock()
			if message, ok := argAny(args, 0).(string); ok {
				t.failure = &message
			} else {
				t.failure = nil
			}
			return nil, nil
		},
	}
}

func observerWebhookSubject(_ context.Context, init json.RawMessage) (conformance.Instance, error) {
	var config struct {
		ID      string            `json:"id"`
		URL     string            `json:"url"`
		Headers map[string]string `json:"headers"`
	}
	if err := json.Unmarshal(init, &config); err != nil {
		return conformance.Instance{}, fmt.Errorf("init: %w", err)
	}
	transport, err := newFakeTransport(init)
	if err != nil {
		return conformance.Instance{}, err
	}
	output, err := webhook.New(config.ID, config.URL, config.Headers, transport.send)
	if err != nil {
		return conformance.Instance{}, err
	}
	return conformance.Instance{Methods: transport.methods(output)}, nil
}

func observerSlackSubject(_ context.Context, init json.RawMessage) (conformance.Instance, error) {
	var config struct {
		Webhook string `json:"webhook"`
	}
	if err := json.Unmarshal(init, &config); err != nil {
		return conformance.Instance{}, fmt.Errorf("init: %w", err)
	}
	transport, err := newFakeTransport(init)
	if err != nil {
		return conformance.Instance{}, err
	}
	output, err := slack.New(config.Webhook, transport.send)
	if err != nil {
		return conformance.Instance{}, err
	}
	return conformance.Instance{Methods: transport.methods(output)}, nil
}

// recorder is a fake AWS client: it records each request or fails with init.fail.
type recorder struct {
	mu      sync.Mutex
	sent    []any
	failure *string
}

func (r *recorder) record(value any) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.failure != nil {
		return errors.New(*r.failure)
	}
	r.sent = append(r.sent, value)
	return nil
}

func (r *recorder) list(context.Context, []json.RawMessage) (any, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.sent), nil
}

func newRecorder(init json.RawMessage) (*recorder, error) {
	var config struct {
		Fail *string `json:"fail"`
	}
	if err := json.Unmarshal(init, &config); err != nil {
		return nil, fmt.Errorf("init: %w", err)
	}
	return &recorder{sent: []any{}, failure: config.Fail}, nil
}

func observerEmailSubject(_ context.Context, init json.RawMessage) (conformance.Instance, error) {
	var config struct {
		From string `json:"from"`
		To   string `json:"to"`
	}
	if err := json.Unmarshal(init, &config); err != nil {
		return conformance.Instance{}, fmt.Errorf("init: %w", err)
	}
	client, err := newRecorder(init)
	if err != nil {
		return conformance.Instance{}, err
	}
	output, err := email.New(config.From, config.To, email.ClientFunc(func(_ context.Context, input email.Input) error {
		return client.record(input)
	}))
	if err != nil {
		return conformance.Instance{}, err
	}
	return conformance.Instance{Methods: map[string]conformance.Method{
		"id":    func(context.Context, []json.RawMessage) (any, error) { return output.ID(), nil },
		"write": writeMethod(output),
		"sent":  client.list,
	}}, nil
}

func observerLocalEmailSubject(_ context.Context, init json.RawMessage) (conformance.Instance, error) {
	var config struct {
		From       string   `json:"from"`
		To         string   `json:"to"`
		Port       *float64 `json:"port"`
		Production bool     `json:"production"`
	}
	if err := json.Unmarshal(init, &config); err != nil {
		return conformance.Instance{}, fmt.Errorf("init: %w", err)
	}
	client, err := newRecorder(init)
	if err != nil {
		return conformance.Instance{}, err
	}
	port := 1025.0
	if config.Port != nil {
		port = *config.Port
	}
	// Go ports are ints: a fractional port is the same invalid port (after the production check).
	if port != math.Trunc(port) && !config.Production {
		return conformance.Instance{}, email.ErrPort
	}
	output, err := email.NewLocal(config.From, config.To, int(port), email.WithProduction(config.Production),
		email.WithSender(func(_ context.Context, mail email.Mail) error { return client.record(mail) }))
	if err != nil {
		return conformance.Instance{}, err
	}
	return conformance.Instance{Methods: map[string]conformance.Method{
		"id":    func(context.Context, []json.RawMessage) (any, error) { return output.ID(), nil },
		"write": writeMethod(output),
		"sent":  client.list,
		"setFailure": func(_ context.Context, args []json.RawMessage) (any, error) {
			client.mu.Lock()
			defer client.mu.Unlock()
			if message, ok := argAny(args, 0).(string); ok {
				client.failure = &message
			} else {
				client.failure = nil
			}
			return nil, nil
		},
	}}, nil
}

func observerSMSSubject(_ context.Context, init json.RawMessage) (conformance.Instance, error) {
	var config struct {
		Phone string `json:"phone"`
	}
	if err := json.Unmarshal(init, &config); err != nil {
		return conformance.Instance{}, fmt.Errorf("init: %w", err)
	}
	client, err := newRecorder(init)
	if err != nil {
		return conformance.Instance{}, err
	}
	output, err := sms.New(config.Phone, sms.ClientFunc(func(_ context.Context, phone, message string) error {
		return client.record(map[string]string{"PhoneNumber": phone, "Message": message})
	}))
	if err != nil {
		return conformance.Instance{}, err
	}
	return conformance.Instance{Methods: map[string]conformance.Method{
		"id":    func(context.Context, []json.RawMessage) (any, error) { return output.ID(), nil },
		"write": writeMethod(output),
		"sent":  client.list,
	}}, nil
}
