package main

// Subjects: health, health-monitor, health-http-probe, analytics, visits. Each subject is a
// small facade with the surface of spec/hosts/node/monitoring.mjs; helpers are documented in
// the contracts and docs/polyglot/{health,analytics,visits}.md.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/http"
	"slices"
	"sync"
	"time"

	"rt.local/core-go/analytics"
	"rt.local/core-go/conformance"
	"rt.local/core-go/health"
	"rt.local/core-go/internal/uuid"
	"rt.local/core-go/visits"
	"rt.local/core-go/web"
)

func init() {
	register("health", healthSubject)
	register("health-monitor", healthMonitorSubject)
	register("health-http-probe", httpProbeSubject)
	register("analytics", analyticsSubject)
	register("visits", visitsSubject)
}

// scripted are probes with a behavior: up, down (a secret-looking failure), slow (up after
// 50 ms) and hang (until its context is done).
type scripted struct {
	mu     sync.Mutex
	state  map[string]*probeState
	probes []health.Probe
}

type probeState struct {
	behavior string
	calls    int
	aborted  bool
}

type probeSpec struct {
	ID       string `json:"id"`
	Required *bool  `json:"required"`
	Behavior string `json:"behavior"`
}

func newScripted(specs []probeSpec) *scripted {
	s := &scripted{state: map[string]*probeState{}}
	for _, spec := range specs {
		state := &probeState{behavior: spec.Behavior}
		if state.behavior == "" {
			state.behavior = "up"
		}
		s.state[spec.ID] = state
		s.probes = append(s.probes, health.Probe{
			ID:       spec.ID,
			Optional: spec.Required != nil && !*spec.Required,
			Check:    func(ctx context.Context) error { return s.check(ctx, state) },
		})
	}
	return s
}

func (s *scripted) check(ctx context.Context, state *probeState) error {
	s.mu.Lock()
	state.calls++
	behavior := state.behavior
	s.mu.Unlock()
	var err error
	switch behavior {
	case "down":
		err = errors.New("password=hunter2 at db.internal")
	case "slow":
		select {
		case <-time.After(50 * time.Millisecond):
		case <-ctx.Done():
		}
	case "hang":
		<-ctx.Done()
	}
	s.mu.Lock()
	state.aborted = ctx.Err() != nil
	s.mu.Unlock()
	return err
}

func (s *scripted) find(args []json.RawMessage) (*probeState, error) {
	id := argString(args, 0)
	state, ok := s.state[id]
	if !ok {
		return nil, fmt.Errorf("Unknown probe %s", id)
	}
	return state, nil
}

func (s *scripted) methods() map[string]conformance.Method {
	return map[string]conformance.Method{
		"setProbe": func(_ context.Context, args []json.RawMessage) (any, error) {
			state, err := s.find(args)
			if err != nil {
				return nil, err
			}
			behavior := argString(args, 1)
			if !slices.Contains([]string{"up", "down", "slow", "hang"}, behavior) {
				return nil, errors.New("Unknown probe behavior")
			}
			s.mu.Lock()
			state.behavior = behavior
			s.mu.Unlock()
			return nil, nil
		},
		"calls": func(_ context.Context, args []json.RawMessage) (any, error) {
			state, err := s.find(args)
			if err != nil {
				return nil, err
			}
			s.mu.Lock()
			defer s.mu.Unlock()
			return state.calls, nil
		},
		"aborted": func(_ context.Context, args []json.RawMessage) (any, error) {
			state, err := s.find(args)
			if err != nil {
				return nil, err
			}
			s.mu.Lock()
			defer s.mu.Unlock()
			return state.aborted, nil
		},
	}
}

// millis reads a JSON number of milliseconds (typeof number in JavaScript) as a duration; any
// other present value is an invalid configuration.
func millis(raw json.RawMessage, fallback time.Duration) (time.Duration, error) {
	switch v := decodeAny(raw).(type) {
	case nil:
		return fallback, nil
	case float64:
		return time.Duration(v * float64(time.Millisecond)), nil
	default:
		return 0, health.ErrInvalidConfig
	}
}

// healthChecks builds Checks from init {probes, timeoutMs?, cacheMs?, now}.
func healthChecks(init json.RawMessage, defaultCache time.Duration) (*health.Checks, *scripted, *clock, error) {
	now, err := newClock(init)
	if err != nil {
		return nil, nil, nil, err
	}
	var config struct {
		Probes    []probeSpec     `json:"probes"`
		TimeoutMs json.RawMessage `json:"timeoutMs"`
		CacheMs   json.RawMessage `json:"cacheMs"`
	}
	if err := json.Unmarshal(init, &config); err != nil {
		return nil, nil, nil, fmt.Errorf("init: %w", err)
	}
	timeout, err := millis(config.TimeoutMs, time.Second)
	if err != nil {
		return nil, nil, nil, err
	}
	cache, err := millis(config.CacheMs, defaultCache)
	if err != nil {
		return nil, nil, nil, err
	}
	probes := newScripted(config.Probes)
	checks, err := health.New(probes.probes, health.WithTimeout(timeout), health.WithCache(cache), health.WithClock(now.Now))
	return checks, probes, now, err
}

func healthSubject(_ context.Context, init json.RawMessage) (conformance.Instance, error) {
	checks, probes, now, err := healthChecks(init, 10*time.Second)
	if err != nil {
		return conformance.Instance{}, err
	}
	feature := checks.Feature()
	handler := func(path string) conformance.Method {
		for _, e := range feature.Endpoints {
			if e.Path == path {
				return func(ctx context.Context, _ []json.RawMessage) (any, error) { return e.Handle(&web.Context{Ctx: ctx}) }
			}
		}
		panic("no endpoint " + path)
	}
	methods := map[string]conformance.Method{
		"report": func(ctx context.Context, _ []json.RawMessage) (any, error) { return checks.Report(ctx) },
		// concurrentReports(n) → n reports requested at the same time
		"concurrentReports": func(ctx context.Context, args []json.RawMessage) (any, error) {
			n, _ := argAny(args, 0).(float64)
			reports, errs := make([]health.Report, int(n)), make([]error, int(n))
			var start, done sync.WaitGroup
			start.Add(1)
			for i := range reports {
				done.Go(func() {
					start.Wait()
					reports[i], errs[i] = checks.Report(ctx)
				})
			}
			start.Done()
			done.Wait()
			return reports, errors.Join(errs...)
		},
		"live":         handler("/health/live"),
		"ready":        handler("/health/ready"),
		"healthReport": handler("/health/report"),
		"endpoints": func(context.Context, []json.RawMessage) (any, error) {
			routes := []map[string]string{}
			for _, e := range feature.Endpoints {
				routes = append(routes, map[string]string{"method": e.Method, "path": e.Path, "resource": e.Resource, "access": e.Access})
			}
			return routes, nil
		},
		"setNow": now.setNow,
	}
	maps.Copy(methods, probes.methods())
	return conformance.Instance{Methods: methods}, nil
}

func healthMonitorSubject(_ context.Context, init json.RawMessage) (conformance.Instance, error) {
	checks, probes, now, err := healthChecks(init, 0)
	if err != nil {
		return conformance.Instance{}, err
	}
	var mu sync.Mutex
	alerts, failures := []health.Alert{}, 0
	monitor := health.NewMonitor(checks, func(_ context.Context, alert health.Alert) error {
		mu.Lock()
		defer mu.Unlock()
		if failures > 0 {
			failures--
			return errors.New("mail offline")
		}
		alerts = append(alerts, alert)
		return nil
	})
	methods := map[string]conformance.Method{
		"poll": func(ctx context.Context, _ []json.RawMessage) (any, error) { return monitor.Poll(ctx) },
		"alerts": func(context.Context, []json.RawMessage) (any, error) {
			mu.Lock()
			defer mu.Unlock()
			return slices.Clone(alerts), nil
		},
		"failNotifications": func(_ context.Context, args []json.RawMessage) (any, error) {
			n, _ := argAny(args, 0).(float64)
			mu.Lock()
			failures = int(n)
			mu.Unlock()
			return nil, nil
		},
		"setNow": now.setNow,
	}
	methods["setProbe"] = probes.methods()["setProbe"]
	return conformance.Instance{Methods: methods}, nil
}

// statusTransport answers every request with one status and an empty body.
type statusTransport int

func (s statusTransport) RoundTrip(*http.Request) (*http.Response, error) {
	return &http.Response{StatusCode: int(s), Body: io.NopCloser(http.NoBody), Header: http.Header{}}, nil
}

func httpProbeSubject(context.Context, json.RawMessage) (conformance.Instance, error) {
	return conformance.Instance{Methods: map[string]conformance.Method{
		// probe(id, url) → {id}
		"probe": func(_ context.Context, args []json.RawMessage) (any, error) {
			probe, err := health.HTTPProbe(argString(args, 0), argString(args, 1), nil)
			if err != nil {
				return nil, err
			}
			return map[string]string{"id": probe.ID}, nil
		},
		// check(url, status) → null, with a transport answering status
		"check": func(ctx context.Context, args []json.RawMessage) (any, error) {
			status, _ := argAny(args, 1).(float64)
			probe, err := health.HTTPProbe("probe", argString(args, 0), &http.Client{Transport: statusTransport(status)})
			if err != nil {
				return nil, err
			}
			return nil, probe.Check(ctx)
		},
	}}, nil
}

// spyObserver records every call with the log context of its ctx.
type spyObserver struct {
	mu    sync.Mutex
	calls []map[string]any
}

type logContextKey struct{}

func logContext(ctx context.Context) map[string]string {
	fields, _ := ctx.Value(logContextKey{}).(map[string]string)
	return maps.Clone(fields)
}

func (s *spyObserver) WithContext(ctx context.Context, fields map[string]string) context.Context {
	merged := logContext(ctx)
	if merged == nil {
		merged = map[string]string{}
	}
	maps.Copy(merged, fields)
	return context.WithValue(ctx, logContextKey{}, merged)
}

func (s *spyObserver) record(call map[string]any) {
	s.mu.Lock()
	s.calls = append(s.calls, call)
	s.mu.Unlock()
}

func (s *spyObserver) Emit(ctx context.Context, level, kind, source, message string, data map[string]any) error {
	s.record(map[string]any{"method": "emit", "level": level, "kind": kind, "source": source, "message": message, "data": data, "context": logContext(ctx)})
	return nil
}

func (s *spyObserver) CountView(ctx context.Context, message string, view analytics.View) error {
	s.record(map[string]any{"method": "countView", "message": message, "options": view, "context": logContext(ctx)})
	return nil
}

func analyticsSubject(context.Context, json.RawMessage) (conformance.Instance, error) {
	spy := &spyObserver{calls: []map[string]any{}}
	tracker := analytics.New(spy)
	return conformance.Instance{Methods: map[string]conformance.Method{
		// track(name, properties?, source?) → null; names must be strings
		"track": func(ctx context.Context, args []json.RawMessage) (any, error) {
			name, ok := argAny(args, 0).(string)
			if !ok {
				return nil, analytics.ErrInvalidName
			}
			properties, _ := argAny(args, 1).(map[string]any)
			return nil, tracker.Track(ctx, name, properties, argString(args, 2))
		},
		// pageView(title, {url, apiUrl?, source?}) → null
		"pageView": func(ctx context.Context, args []json.RawMessage) (any, error) {
			var view analytics.View
			if err := decodeArgs(args[min(len(args), 1):], &view); err != nil {
				return nil, err
			}
			return nil, tracker.PageView(ctx, argString(args, 0), view)
		},
		"calls": func(context.Context, []json.RawMessage) (any, error) {
			spy.mu.Lock()
			defer spy.mu.Unlock()
			return slices.Clone(spy.calls), nil
		},
	}}, nil
}

func visitsSubject(ctx context.Context, init json.RawMessage) (conformance.Instance, error) {
	now, err := newClock(init)
	if err != nil {
		return conformance.Instance{}, err
	}
	var config struct {
		Secret string   `json:"secret"`
		Pages  []string `json:"pages"`
		IDs    []string `json:"ids"`
	}
	if err := json.Unmarshal(init, &config); err != nil {
		return conformance.Instance{}, fmt.Errorf("init: %w", err)
	}
	store, err := memoryStore(ctx, init)
	if err != nil {
		return conformance.Instance{}, err
	}
	var idMu sync.Mutex
	ids := config.IDs
	options := []visits.Option{visits.WithClock(now.Now), visits.WithIDs(func() string {
		idMu.Lock()
		defer idMu.Unlock()
		if len(ids) == 0 {
			return uuid.New()
		}
		id := ids[0]
		ids = ids[1:]
		return id
	})}
	if config.Pages != nil {
		options = append(options, visits.WithPages(config.Pages))
	}
	v, err := visits.New(store, config.Secret, options...)
	if err != nil {
		return conformance.Instance{}, err
	}
	return conformance.Instance{Methods: map[string]conformance.Method{
		"start": func(ctx context.Context, args []json.RawMessage) (any, error) {
			return v.Start(ctx, argString(args, 0))
		},
		"ingest": func(ctx context.Context, args []json.RawMessage) (any, error) {
			input, _ := argAny(args, 0).(map[string]any)
			return v.Ingest(ctx, input, argString(args, 1))
		},
		"list": func(ctx context.Context, _ []json.RawMessage) (any, error) { return v.List(ctx) },
		"detail": func(ctx context.Context, args []json.RawMessage) (any, error) {
			return v.Detail(ctx, argString(args, 0))
		},
		"remove": func(ctx context.Context, args []json.RawMessage) (any, error) {
			return v.Remove(ctx, argString(args, 0))
		},
		// Helpers: start once per ip, stored rows, clock and token signing.
		"startEach": func(ctx context.Context, args []json.RawMessage) (any, error) {
			ips, _ := argAny(args, 0).([]any)
			for _, ip := range ips {
				s, _ := ip.(string)
				if _, err := v.Start(ctx, s); err != nil {
					return nil, err
				}
			}
			return nil, nil
		},
		"row":    rowMethod(store),
		"setNow": now.setNow,
		"sign":   func(_ context.Context, args []json.RawMessage) (any, error) { return v.Sign(argString(args, 0)), nil },
	}}, nil
}
