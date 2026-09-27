package main

// Subjects: choice, choice-jev, choice-transformers (mirrors spec/hosts/node/choice.mjs).
// Providers are faked from init so no network or model is used. Wire null means "not given".
// Go providers are typed: wire values a typed answer cannot hold are rejected by the fakes with
// the error the reference ends with (see rt-app/docs/polyglot/choice.md).

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strings"
	"sync"
	"time"

	"rt.local/core-go/choice"
	"rt.local/core-go/choice/jev"
	"rt.local/core-go/choice/transformers"
	"rt.local/core-go/conformance"
	"rt.local/core-go/web"
)

func init() {
	register("choice", choiceSubject)
	register("choice-jev", jevSubject)
	register("choice-transformers", transformersSubject)
}

// choiceValue decodes a wire value (numbers are float64); missing or invalid JSON is nil.
func choiceValue(args []json.RawMessage, i int) any {
	var value any
	if i < len(args) && json.Unmarshal(args[i], &value) == nil {
		return value
	}
	return nil
}

func choiceInit(raw json.RawMessage) (map[string]any, error) {
	var init map[string]any
	if err := json.Unmarshal(raw, &init); err != nil {
		return nil, fmt.Errorf("init: %w", err)
	}
	return init, nil
}

// choicePolicy reads a wire policy: null fields are defaults; non-numbers become NaN (invalid,
// like the reference's Number.isFinite check); only true allows uncalibrated scores.
func choicePolicy(value any) choice.Policy {
	fields, _ := value.(map[string]any)
	number := func(name string) *float64 {
		raw, present := fields[name]
		if !present || raw == nil {
			return nil
		}
		n, ok := raw.(float64)
		if !ok {
			n = math.NaN()
		}
		return &n
	}
	allow, _ := fields["allowUncalibrated"].(bool)
	return choice.Policy{MinProbability: number("minProbability"), MinMargin: number("minMargin"), AllowUncalibrated: allow}
}

// choiceAbortable returns a context cancelled "before" the call, or one the fakes cancel "during" it.
func choiceAbortable(when any) (context.Context, context.CancelFunc, error) {
	ctx, cancel := context.WithCancel(context.Background())
	switch when {
	case "before":
		cancel()
	case "during":
	default:
		cancel()
		return nil, nil, errors.New(`when must be "before" or "during"`)
	}
	return ctx, cancel, nil
}

// fakeProvider answers init.prediction (or fails with init.error) and records every snapshot.
type fakeProvider struct {
	mu     sync.Mutex
	id     string
	init   map[string]any
	calls  []choice.Input
	during context.CancelFunc
}

func (f *fakeProvider) ID() string { return f.id }

func (f *fakeProvider) Predict(_ context.Context, input choice.Input) (choice.Prediction, error) {
	f.mu.Lock()
	f.calls = append(f.calls, input)
	during := f.during
	f.mu.Unlock()
	if during != nil {
		during()
	}
	if message, ok := f.init["error"].(string); ok {
		return choice.Prediction{}, errors.New(message)
	}
	return choice.ParsePrediction(f.init["prediction"])
}

func choiceSubject(_ context.Context, raw json.RawMessage) (conformance.Instance, error) {
	init, err := choiceInit(raw)
	if err != nil {
		return conformance.Instance{}, err
	}
	provider := &fakeProvider{id: "fake", init: init}
	if id, ok := init["id"].(string); ok && id != "" {
		provider.id = id
	}
	module := choice.New(provider)
	return conformance.Instance{Methods: map[string]conformance.Method{
		// validateChoice(input) → snapshot | 400
		"validateChoice": func(_ context.Context, args []json.RawMessage) (any, error) {
			return choice.Validate(choiceValue(args, 0))
		},
		// decide(input, policy?) → decision
		"decide": func(ctx context.Context, args []json.RawMessage) (any, error) {
			return module.Decide(ctx, choiceValue(args, 0), choicePolicy(choiceValue(args, 1)))
		},
		// decideAborted(input, policy, "before" | "during") → error
		"decideAborted": func(_ context.Context, args []json.RawMessage) (any, error) {
			ctx, cancel, err := choiceAbortable(choiceValue(args, 2))
			if err != nil {
				return nil, err
			}
			defer cancel()
			if choiceValue(args, 2) == "during" {
				provider.mu.Lock()
				provider.during = cancel
				provider.mu.Unlock()
			}
			return module.Decide(ctx, choiceValue(args, 0), choicePolicy(choiceValue(args, 1)))
		},
		// calls() → snapshots the provider received
		"calls": func(context.Context, []json.RawMessage) (any, error) {
			provider.mu.Lock()
			defer provider.mu.Unlock()
			return append([]choice.Input{}, provider.calls...), nil
		},
		// feature() → endpoint metadata (web.Endpoint has no explicitGrant/tool fields yet)
		"feature": func(context.Context, []json.RawMessage) (any, error) {
			feature := module.Feature()
			endpoints := make([]map[string]any, len(feature.Endpoints))
			for i, e := range feature.Endpoints {
				endpoints[i] = map[string]any{
					"method": e.Method, "path": e.Path, "resource": e.Resource, "access": e.Access,
					"explicitGrant": choice.ExplicitGrant, "tool": choice.Tool,
				}
			}
			return map[string]any{"id": feature.ID, "migrations": []any{}, "endpoints": endpoints}, nil
		},
		// handle(body) → the endpoint's result
		"handle": func(ctx context.Context, args []json.RawMessage) (any, error) {
			body, _ := choiceValue(args, 0).(map[string]any)
			endpoint := module.Feature().Endpoints[0]
			return endpoint.Handle(&web.Context{Ctx: ctx, Request: web.Request{Method: endpoint.Method, Path: endpoint.Path, Body: body}})
		},
	}}, nil
}

// fakeJev answers init.responses in order and records what was sent.
type fakeJev struct {
	mu        sync.Mutex
	responses []map[string]any
	sent      []map[string]any
}

func (f *fakeJev) Do(req *http.Request) (*http.Response, error) {
	text, err := io.ReadAll(req.Body)
	if err != nil {
		return nil, err
	}
	var body any
	if err := json.Unmarshal(text, &body); err != nil {
		return nil, err
	}
	headers := map[string]any{}
	for name, values := range req.Header {
		headers[strings.ToLower(name)] = values[0]
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = append(f.sent, map[string]any{"url": req.URL.String(), "method": req.Method, "headers": headers, "body": body, "text": string(text)})
	if len(f.responses) == 0 {
		return nil, errors.New("No fake response left")
	}
	next := f.responses[0]
	f.responses = f.responses[1:]
	if message, ok := next["error"].(string); ok {
		return nil, errors.New(message)
	}
	payload := ""
	if text, ok := next["text"].(string); ok {
		payload = text
	} else if value, present := next["json"]; present {
		encoded, err := json.Marshal(value)
		if err != nil {
			return nil, err
		}
		payload = string(encoded)
	}
	status := http.StatusOK
	if s, ok := next["status"].(float64); ok && s != 0 {
		status = int(s)
	}
	return &http.Response{StatusCode: status, Body: io.NopCloser(bytes.NewBufferString(payload)), Header: http.Header{}, Request: req}, nil
}

func jevSubject(_ context.Context, raw json.RawMessage) (conformance.Instance, error) {
	init, err := choiceInit(raw)
	if err != nil {
		return conformance.Instance{}, err
	}
	fake := &fakeJev{}
	if list, ok := init["responses"].([]any); ok {
		for _, item := range list {
			response, _ := item.(map[string]any)
			fake.responses = append(fake.responses, response)
		}
	}
	apiKey, _ := init["apiKey"].(string)
	options := []jev.Option{jev.WithClient(fake)}
	if model, present := init["model"]; present && model != nil {
		name, _ := model.(string)
		options = append(options, jev.WithModel(name))
	}
	if timeout, present := init["timeoutMs"]; present && timeout != nil {
		ms, ok := timeout.(float64)
		if !ok {
			ms = 0 // not a number: invalid, like Number.isFinite in the reference
		}
		options = append(options, jev.WithTimeout(time.Duration(ms*float64(time.Millisecond))))
	}
	provider, err := jev.New(apiKey, options...)
	if err != nil {
		return conformance.Instance{}, err
	}
	module := choice.New(provider)
	return conformance.Instance{Methods: map[string]conformance.Method{
		"id": func(context.Context, []json.RawMessage) (any, error) { return provider.ID(), nil },
		// predict(input) validates like the reference (Go providers take a validated Input).
		"predict": func(ctx context.Context, args []json.RawMessage) (any, error) {
			input, err := choice.Validate(choiceValue(args, 0))
			if err != nil {
				return nil, err
			}
			return provider.Predict(ctx, input)
		},
		"decide": func(ctx context.Context, args []json.RawMessage) (any, error) {
			return module.Decide(ctx, choiceValue(args, 0), choicePolicy(choiceValue(args, 1)))
		},
		"requests": func(context.Context, []json.RawMessage) (any, error) {
			fake.mu.Lock()
			defer fake.mu.Unlock()
			return append([]map[string]any{}, fake.sent...), nil
		},
	}}, nil
}

// fakeZeroShot answers init.results in order and records every call. Wire values a typed
// Result cannot hold fail with the provider's own ErrInvalidResponse; non-number scores are NaN.
type fakeZeroShot struct {
	mu      sync.Mutex
	results []any
	calls   []map[string]any
	during  context.CancelFunc
}

func (f *fakeZeroShot) classify(_ context.Context, text string, labels []string, options transformers.Options) (transformers.Result, error) {
	f.mu.Lock()
	f.calls = append(f.calls, map[string]any{"text": text, "labels": append([]string{}, labels...), "options": options})
	during := f.during
	if len(f.results) == 0 {
		f.mu.Unlock()
		return transformers.Result{}, errors.New("No fake result left")
	}
	next := f.results[0]
	f.results = f.results[1:]
	f.mu.Unlock()
	if during != nil {
		during()
	}
	fields, ok := next.(map[string]any)
	if !ok {
		return transformers.Result{}, transformers.ErrInvalidResponse // e.g. null
	}
	if message, ok := fields["error"].(string); ok {
		return transformers.Result{}, errors.New(message)
	}
	var result transformers.Result
	if raw, present := fields["labels"]; present {
		list, ok := raw.([]any)
		if !ok {
			return transformers.Result{}, transformers.ErrInvalidResponse
		}
		for _, item := range list {
			label, ok := item.(string)
			if !ok {
				return transformers.Result{}, transformers.ErrInvalidResponse
			}
			result.Labels = append(result.Labels, label)
		}
	}
	if raw, present := fields["scores"]; present {
		list, ok := raw.([]any)
		if !ok {
			return transformers.Result{}, transformers.ErrInvalidResponse
		}
		for _, item := range list {
			score, ok := item.(float64)
			if !ok {
				score = math.NaN()
			}
			result.Scores = append(result.Scores, score)
		}
	}
	return result, nil
}

func transformersSubject(_ context.Context, raw json.RawMessage) (conformance.Instance, error) {
	init, err := choiceInit(raw)
	if err != nil {
		return conformance.Instance{}, err
	}
	fake := &fakeZeroShot{}
	fake.results, _ = init["results"].([]any)
	model, _ := init["model"].(string)
	provider := transformers.New(fake.classify, model)
	module := choice.New(provider)
	predict := func(ctx context.Context, value any) (any, error) {
		input, err := choice.Validate(value)
		if err != nil {
			return nil, err
		}
		return provider.Predict(ctx, input)
	}
	return conformance.Instance{Methods: map[string]conformance.Method{
		"id": func(context.Context, []json.RawMessage) (any, error) { return provider.ID(), nil },
		"predict": func(ctx context.Context, args []json.RawMessage) (any, error) {
			return predict(ctx, choiceValue(args, 0))
		},
		"predictAborted": func(_ context.Context, args []json.RawMessage) (any, error) {
			ctx, cancel, err := choiceAbortable(choiceValue(args, 1))
			if err != nil {
				return nil, err
			}
			defer cancel()
			if choiceValue(args, 1) == "during" {
				fake.mu.Lock()
				fake.during = cancel
				fake.mu.Unlock()
			}
			return predict(ctx, choiceValue(args, 0))
		},
		"decide": func(ctx context.Context, args []json.RawMessage) (any, error) {
			return module.Decide(ctx, choiceValue(args, 0), choicePolicy(choiceValue(args, 1)))
		},
		"calls": func(context.Context, []json.RawMessage) (any, error) {
			fake.mu.Lock()
			defer fake.mu.Unlock()
			return append([]map[string]any{}, fake.calls...), nil
		},
	}}, nil
}
