// Package health serves liveness, readiness and an owner-only dependency report, with the
// behavior of the TypeScript reference (@gsalgadotoledo/rt-app-health) and the health contract.
//
// Checks runs dependency probes in parallel, each bounded by a timeout (its context is cancelled
// when it runs out), never exposes failure details and caches the report:
//
//	checks, err := health.New([]health.Probe{{ID: "database", Check: func(ctx context.Context) error {
//		_, err := store.Get(ctx, "SCHEMA", "users")
//		return err
//	}}})
//	app, err := web.New([]web.Feature{checks.Feature()})
//
// Monitor alerts outages and recoveries from an independent scheduler and HTTPProbe checks
// another service over HTTP. The package-level Feature is the earlier liveness/readiness
// feature without dependency checks, kept for compatibility.
package health

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net/http"
	"sync"
	"time"

	"rt.local/core-go/apperr"
	"rt.local/core-go/web"
)

// MaxProbes is the largest number of probes a Checks accepts.
const MaxProbes = 20

// Check statuses.
const (
	Up   = "up"
	Down = "down"
)

// ErrInvalidConfig is returned by New for invalid probes, timeouts or cache durations.
var ErrInvalidConfig = errors.New("Invalid health configuration")

// ErrUnavailable is the readiness error (503) when a required check is down.
var ErrUnavailable = apperr.New(http.StatusServiceUnavailable, "Service unavailable")

// Probe is one dependency check. Check returns an error when the dependency is unhealthy and
// should stop when ctx is done (the timeout). Optional probes never fail readiness (the
// TypeScript `required: false`).
type Probe struct {
	ID       string
	Optional bool
	Check    func(ctx context.Context) error
}

// CheckResult is one entry of a Report.
type CheckResult struct {
	ID         string `json:"id"`
	Required   bool   `json:"required"`
	Status     string `json:"status"`
	DurationMs int64  `json:"durationMs"`
}

// Report is the owner report. OK is true when every required check is up.
type Report struct {
	OK     bool          `json:"ok"`
	At     string        `json:"at"`
	Checks []CheckResult `json:"checks"`
}

func (r Report) clone() Report {
	r.Checks = append(make([]CheckResult, 0, len(r.Checks)), r.Checks...)
	return r
}

// Option configures Checks.
type Option func(*Checks)

// WithTimeout bounds each probe (default 1 s; at least 1 ms).
func WithTimeout(d time.Duration) Option { return func(c *Checks) { c.timeout = d } }

// WithCache sets how long a report is reused (default 10 s; 0 runs the probes on every report).
func WithCache(d time.Duration) Option { return func(c *Checks) { c.cache = d } }

// WithClock sets the clock of Report.At and the cache expiry (default time.Now).
func WithClock(now func() time.Time) Option { return func(c *Checks) { c.now = now } }

// Checks runs probes and serves the health endpoints. It is safe for concurrent use.
type Checks struct {
	probes  []Probe
	timeout time.Duration
	cache   time.Duration
	now     func() time.Time

	mu       sync.Mutex
	snapshot *Report
	expires  float64 // epoch milliseconds
	flight   flight[Report]
}

// New validates the probes (at most 20, unique ids) and options.
func New(probes []Probe, options ...Option) (*Checks, error) {
	c := &Checks{probes: append([]Probe(nil), probes...), timeout: time.Second, cache: 10 * time.Second, now: time.Now}
	for _, option := range options {
		option(c)
	}
	ids := make(map[string]bool, len(probes))
	for _, probe := range probes {
		ids[probe.ID] = true
	}
	if len(probes) > MaxProbes || len(ids) != len(probes) || c.timeout < time.Millisecond || c.cache < 0 || c.now == nil {
		return nil, ErrInvalidConfig
	}
	return c, nil
}

func (c *Checks) nowMs() float64 { return float64(c.now().UnixMilli()) }

// Report returns a copy of the cached report, or runs the probes once for all concurrent
// callers. Probes run on a context detached from ctx; ctx only bounds the wait.
func (c *Checks) Report(ctx context.Context) (Report, error) {
	c.mu.Lock()
	if c.snapshot != nil && c.expires > c.nowMs() {
		report := c.snapshot.clone()
		c.mu.Unlock()
		return report, nil
	}
	c.mu.Unlock()
	report, err := c.flight.do(ctx, func() (Report, error) { return c.run(context.WithoutCancel(ctx)), nil })
	return report.clone(), err
}

// run checks every probe in parallel, redacting errors and cancelling timed-out work.
func (c *Checks) run(ctx context.Context) Report {
	checks := make([]CheckResult, len(c.probes))
	var wg sync.WaitGroup
	for i, probe := range c.probes {
		wg.Go(func() { checks[i] = c.check(ctx, probe) })
	}
	wg.Wait()
	ok := true
	for _, check := range checks {
		if check.Required && check.Status != Up {
			ok = false
		}
	}
	report := Report{OK: ok, At: isoMillis(c.nowMs()), Checks: checks}
	c.mu.Lock()
	c.snapshot = &report
	c.expires = c.nowMs() + float64(c.cache)/float64(time.Millisecond)
	c.mu.Unlock()
	return report
}

func (c *Checks) check(parent context.Context, probe Probe) CheckResult {
	start := time.Now()
	ctx, cancel := context.WithTimeout(parent, c.timeout)
	defer cancel()
	result := make(chan error, 1)
	go func() {
		defer func() {
			if recover() != nil {
				result <- errors.New("probe panicked")
			}
		}()
		if probe.Check == nil {
			result <- errors.New("probe without check")
			return
		}
		result <- probe.Check(ctx)
	}()
	status := Down
	select {
	case err := <-result:
		if err == nil && ctx.Err() == nil {
			status = Up
		}
	case <-ctx.Done():
	}
	return CheckResult{
		ID:         probe.ID,
		Required:   !probe.Optional,
		Status:     status,
		DurationMs: int64(math.Floor(float64(time.Since(start))/float64(time.Millisecond) + 0.5)),
	}
}

// Feature serves GET /health/live and GET /health/ready (guests) and GET /health/report
// (owner, mounted under /admin/app). Public endpoints expose only availability.
func (c *Checks) Feature() web.Feature {
	return web.Feature{
		ID: "health",
		Endpoints: []web.Endpoint{
			{Method: "GET", Path: "/health/live", Access: web.Guest, Resource: "health.live", Handle: live},
			{Method: "GET", Path: "/health/ready", Access: web.Guest, Resource: "health.ready", Handle: func(ctx *web.Context) (any, error) {
				report, err := c.Report(ctx.Ctx)
				if err != nil {
					return nil, err
				}
				if !report.OK {
					return nil, ErrUnavailable
				}
				return map[string]bool{"ok": true}, nil
			}},
			{Method: "GET", Path: "/health/report", Access: web.Owner, Resource: "health.read", Handle: func(ctx *web.Context) (any, error) {
				return c.Report(ctx.Ctx)
			}},
		},
	}
}

func live(*web.Context) (any, error) { return map[string]bool{"ok": true}, nil }

// Feature returns GET /health/live and GET /health/ready, both public, answering {"ok":true}.
// Kept for compatibility; Checks.Feature adds dependency probes and the owner report.
func Feature() web.Feature {
	return web.Feature{
		ID: "health",
		Endpoints: []web.Endpoint{
			{Method: "GET", Path: "/health/live", Access: web.Guest, Resource: "health.live", Handle: live},
			{Method: "GET", Path: "/health/ready", Access: web.Guest, Resource: "health.ready", Handle: live},
		},
	}
}

// isoMillis is Date.prototype.toISOString of epoch milliseconds.
func isoMillis(ms float64) string {
	return time.UnixMilli(int64(ms)).UTC().Format("2006-01-02T15:04:05.000Z")
}

// flight shares one in-flight computation among concurrent callers (a pending Promise).
type flight[T any] struct {
	mu      sync.Mutex
	pending *call[T]
}

type call[T any] struct {
	done  chan struct{}
	value T
	err   error
}

func (f *flight[T]) do(ctx context.Context, compute func() (T, error)) (T, error) {
	f.mu.Lock()
	c := f.pending
	owner := c == nil
	if owner {
		c = &call[T]{done: make(chan struct{})}
		f.pending = c
	}
	f.mu.Unlock()
	if owner {
		func() {
			defer func() {
				if r := recover(); r != nil {
					c.err = fmt.Errorf("health: %v", r)
				}
				f.mu.Lock()
				f.pending = nil
				f.mu.Unlock()
				close(c.done)
			}()
			c.value, c.err = compute()
		}()
		return c.value, c.err
	}
	select {
	case <-c.done:
		return c.value, c.err
	case <-ctx.Done():
		var zero T
		return zero, ctx.Err()
	}
}
