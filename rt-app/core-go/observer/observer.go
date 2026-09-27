// Package observer captures logs, request metrics, page views and timings and delivers them to
// outputs, with the behavior of the TypeScript reference (@gsalgadotoledo/rt-app-observer) and
// the observer contracts (rt-app/spec/contracts/observer*.contract.yaml).
//
// New builds an Observer over output subscriptions. Each call builds one sanitized Event and
// delivers it to every subscribed output in parallel, each bounded by a timeout and a per-minute
// budget; failures only count in Health and never reach the caller. Store keeps events in daily
// NoSQL partitions with a seven-day TTL and answers reports and log searches; Feature serves them
// (GET /admin/app/observer/report|logs for the owner, POST /observer/events for page views):
//
//	storage := observer.NewStore(db, nil)
//	o, err := observer.New([]observer.Output{{Handler: storage}, {Handler: console.New(nil), Levels: []string{"info", "warn", "error"}}})
//	ctx = o.WithContext(ctx, map[string]string{"requestId": id})
//	o.Error(ctx, "Payment declined", map[string]any{"category": "payments"})
//	feature := observer.Feature(o, storage, nil, nil)
//
// The log context (category, requestId, sessionId) travels in context.Context, so concurrent
// requests never mix their fields. *Observer satisfies analytics.Observer.
package observer

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"math"
	"strings"
	"sync"
	"time"

	"rt.local/core-go/analytics"
	"rt.local/core-go/internal/uuid"
)

// Levels and kinds of events.
var (
	Levels = []string{"debug", "info", "warn", "error"}
	Kinds  = []string{"log", "request", "pageview", "timing", "analytics"}
)

// Limits of the reference implementation.
const (
	DefaultTimeout   = 1500 * time.Millisecond
	DefaultPerMinute = 600
	MaxInFlight      = 32
)

// ErrDuplicateOutput is returned by New when two outputs share a handler id.
var ErrDuplicateOutput = errors.New("Duplicate observer output id")

// ErrInvalidMetric is returned by RecordRequest for an invalid duration or status.
var ErrInvalidMetric = errors.New("Invalid request metric")

// Event is one observation. Category is always set by the Observer; RequestID and SessionID come
// from the log context. Data holds sanitized JSON values.
type Event struct {
	Category  string         `json:"category"`
	ID        string         `json:"id"`
	At        string         `json:"at"`
	Level     string         `json:"level"`
	Kind      string         `json:"kind"`
	Source    string         `json:"source"`
	Message   string         `json:"message"`
	Data      map[string]any `json:"data"`
	RequestID string         `json:"requestId,omitempty"`
	SessionID string         `json:"sessionId,omitempty"`
}

// Map is the event as a JSON object (how Store keeps it).
func (e Event) Map() map[string]any {
	m := map[string]any{"category": e.Category, "id": e.ID, "at": e.At, "level": e.Level, "kind": e.Kind, "source": e.Source, "message": e.Message, "data": e.Data}
	if e.RequestID != "" {
		m["requestId"] = e.RequestID
	}
	if e.SessionID != "" {
		m["sessionId"] = e.SessionID
	}
	return m
}

// JSON is JSON.stringify(event, null, indent): keys in event order, JavaScript escapes and numbers.
func (e Event) JSON(indent int) string { return Stringify(e, indent) }

// Clone returns a deep copy (every output and filter gets its own).
func (e Event) Clone() Event {
	e.Data, _ = cloneJSON(e.Data).(map[string]any)
	return e
}

func cloneJSON(v any) any {
	switch x := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, item := range x {
			out[k] = cloneJSON(item)
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i, item := range x {
			out[i] = cloneJSON(item)
		}
		return out
	default:
		return v
	}
}

// Handler is an output destination. Write gets its own copy of the event; ctx is cancelled when
// the Observer stops waiting (timeout).
type Handler interface {
	ID() string
	Write(ctx context.Context, event Event) error
}

// Output subscribes a Handler. Nil lists mean every level, kind, source or category (an empty
// non-nil list matches nothing). Filter is trusted server code; a panic counts as a failure.
// MaxPerMinute defaults to 600 per clock minute (PerMinute(0) drops everything).
type Output struct {
	Handler      Handler
	Disabled     bool
	Levels       []string
	Kinds        []string
	Sources      []string
	Categories   []string
	MaxPerMinute *int
	Filter       func(Event) bool
}

// PerMinute returns a budget for Output.MaxPerMinute.
func PerMinute(n int) *int { return &n }

// Health counts failed (errors, timeouts, broken filters) and dropped (budget, in-flight limit)
// deliveries of this instance.
type Health struct {
	Failed  int `json:"failed"`
	Dropped int `json:"dropped"`
}

// *Observer is the Observer analytics.New expects.
var _ analytics.Observer = (*Observer)(nil)

// View is a page view: URL (path or absolute URL), APIURL (optional metadata) and Source ("" is "spa").
type View = analytics.View

// RequestMetric is one API request. Status is a number so that fractions can be rejected.
type RequestMetric struct {
	Method     string  `json:"method"`
	URL        string  `json:"url"`
	DurationMs float64 `json:"durationMs"`
	Status     float64 `json:"status"`
}

// Option configures an Observer.
type Option func(*Observer)

// WithTimeout bounds each delivery (1.5 s by default).
func WithTimeout(d time.Duration) Option { return func(o *Observer) { o.timeout = d } }

// WithClock injects the clock of event times, budgets and Measure durations.
func WithClock(now func() time.Time) Option { return func(o *Observer) { o.now = now } }

// WithIDs injects the event id generator (random UUIDs by default).
func WithIDs(next func() string) Option { return func(o *Observer) { o.newID = next } }

// Observer is safe for concurrent use.
type Observer struct {
	outputs []Output
	timeout time.Duration
	now     func() time.Time
	newID   func() string

	mu       sync.Mutex
	health   Health
	inFlight int
	budgets  map[string]budget
}

type budget struct {
	minute int64
	count  int
}

// New returns an Observer over outputs; handler ids must be unique.
func New(outputs []Output, options ...Option) (*Observer, error) {
	seen := map[string]bool{}
	for _, output := range outputs {
		if seen[output.Handler.ID()] {
			return nil, ErrDuplicateOutput
		}
		seen[output.Handler.ID()] = true
	}
	o := &Observer{outputs: outputs, timeout: DefaultTimeout, newID: uuid.New, budgets: map[string]budget{}}
	for _, option := range options {
		option(o)
	}
	return o, nil
}

// Outputs returns the subscriptions.
func (o *Observer) Outputs() []Output { return o.outputs }

// Health returns a snapshot of the delivery counters.
func (o *Observer) Health() Health {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.health
}

func (o *Observer) clock() time.Time {
	if o.now != nil {
		return o.now()
	}
	return time.Now()
}

func (o *Observer) count(failed, dropped int) {
	o.mu.Lock()
	o.health.Failed += failed
	o.health.Dropped += dropped
	o.mu.Unlock()
}

// ---------------------------------------------------------------- log context

type contextKey struct{}

// LogContext returns the log fields of ctx.
func LogContext(ctx context.Context) map[string]string {
	fields, _ := ctx.Value(contextKey{}).(map[string]string)
	return maps.Clone(fields)
}

// WithContext returns ctx with fields merged over its log context (category, requestId and
// sessionId end up in events; other fields are kept but ignored).
func (o *Observer) WithContext(ctx context.Context, fields map[string]string) context.Context {
	merged := LogContext(ctx)
	if merged == nil {
		merged = map[string]string{}
	}
	maps.Copy(merged, fields)
	return context.WithValue(ctx, contextKey{}, merged)
}

// ---------------------------------------------------------------- delivery

// Emit builds one sanitized event and delivers it to the subscribed outputs. Delivery failures
// only count in Health: Emit always returns nil.
func (o *Observer) Emit(ctx context.Context, level, kind, source, message string, data map[string]any) error {
	enabled := false
	for _, output := range o.outputs {
		enabled = enabled || !output.Disabled
	}
	if !enabled {
		return nil
	}
	o.mu.Lock()
	if o.inFlight >= MaxInFlight {
		o.health.Dropped++
		o.mu.Unlock()
		return nil
	}
	o.inFlight++
	o.mu.Unlock()
	defer func() {
		o.mu.Lock()
		o.inFlight--
		o.mu.Unlock()
	}()
	event := o.event(ctx, level, kind, source, message, data)
	var waits []func()
	for _, output := range o.outputs {
		if wait := o.deliver(ctx, output, level, kind, source, event); wait != nil {
			waits = append(waits, wait)
		}
	}
	for _, wait := range waits {
		wait()
	}
	return nil
}

func (o *Observer) event(ctx context.Context, level, kind, source, message string, data map[string]any) Event {
	if data == nil {
		data = map[string]any{}
	}
	sanitized, _ := Sanitize(data).(map[string]any)
	event := Event{
		Category: "app",
		ID:       o.newID(),
		At:       ISOTime(o.clock()),
		Level:    level,
		Kind:     kind,
		Source:   cut(source, 80),
		Message:  sanitizeString(message),
		Data:     sanitized,
	}
	fields := LogContext(ctx)
	if v, ok := fields["category"]; ok {
		event.Category = cut(sanitizeString(v), 120)
	}
	if v, ok := fields["requestId"]; ok {
		event.RequestID = cut(sanitizeString(v), 120)
	}
	if v, ok := fields["sessionId"]; ok {
		event.SessionID = cut(sanitizeString(v), 120)
	}
	return event
}

// deliver runs the checks in order (subscription, filter, budget) and starts the write; the
// returned function waits for it at most the timeout.
func (o *Observer) deliver(ctx context.Context, output Output, level, kind, source string, event Event) func() {
	if output.Disabled || !allows(output.Levels, level) || !allows(output.Kinds, kind) ||
		!allows(output.Sources, source) || !allows(output.Categories, event.Category) {
		return nil
	}
	if output.Filter != nil {
		keep, ok := runFilter(output.Filter, event.Clone())
		if !ok {
			o.count(1, 0)
			return nil
		}
		if !keep {
			return nil
		}
	}
	if !o.spend(output) {
		return nil
	}
	// The delivery is not tied to the caller's cancellation, only to the timeout.
	deliveryCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), o.timeout)
	type outcome struct {
		err    error
		onTime bool // finished before the timeout (a Promise.race won by the write)
	}
	done := make(chan outcome, 1)
	copied := event.Clone()
	go func() {
		defer func() {
			if r := recover(); r != nil {
				done <- outcome{err: fmt.Errorf("observer output panicked"), onTime: deliveryCtx.Err() == nil}
			}
		}()
		err := output.Handler.Write(deliveryCtx, copied)
		done <- outcome{err: err, onTime: deliveryCtx.Err() == nil}
	}()
	return func() {
		defer cancel()
		var result outcome
		select {
		case result = <-done:
		case <-deliveryCtx.Done():
			// Outputs are awaited one after the other: a write that finished in time while an
			// earlier output was being awaited still counts as delivered.
			select {
			case result = <-done:
			default:
			}
		}
		if result.err != nil || !result.onTime {
			o.count(1, 0)
		}
	}
}

func allows(list []string, value string) bool {
	if list == nil {
		return true
	}
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}

func runFilter(filter func(Event) bool, event Event) (keep, ok bool) {
	defer func() {
		if recover() != nil {
			keep, ok = false, false
		}
	}()
	return filter(event), true
}

// spend takes one event from the output's budget of the current clock minute.
func (o *Observer) spend(output Output) bool {
	minute := int64(math.Floor(float64(o.clock().UnixMilli()) / 60000))
	limit := DefaultPerMinute
	if output.MaxPerMinute != nil {
		limit = *output.MaxPerMinute
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	id := output.Handler.ID()
	b, ok := o.budgets[id]
	if !ok || b.minute != minute {
		b = budget{minute: minute}
	}
	b.count++
	o.budgets[id] = b
	if b.count-1 >= limit {
		o.health.Dropped++
		return false
	}
	return true
}

// ---------------------------------------------------------------- helpers

// Write emits a structured log (kind "log", source "app") under fields.
func (o *Observer) Write(ctx context.Context, level, message string, fields map[string]string, data map[string]any) error {
	return o.Emit(o.WithContext(ctx, fields), level, "log", "app", message, data)
}

// writeLog: a string first value is the message and the rest go to data.values; otherwise the
// message is "Application log" and every value goes to data.values. String category, requestId
// and sessionId of a map second value become the log context.
func (o *Observer) writeLog(ctx context.Context, level string, values []any) error {
	var rest []any
	if len(values) > 0 {
		rest = values[1:]
	}
	fields := map[string]string{}
	if len(rest) > 0 {
		if metadata, ok := rest[0].(map[string]any); ok {
			for _, key := range []string{"category", "requestId", "sessionId"} {
				if s, ok := metadata[key].(string); ok {
					fields[key] = s
				}
			}
		}
	}
	message, items := "Application log", values
	if len(values) > 0 {
		if first, ok := values[0].(string); ok {
			message, items = first, rest
		}
	}
	list := make([]any, len(items))
	copy(list, items)
	return o.Emit(o.WithContext(ctx, fields), level, "log", "app", message, map[string]any{"values": list})
}

// Log is Info.
func (o *Observer) Log(ctx context.Context, values ...any) error {
	return o.writeLog(ctx, "info", values)
}

// Info logs at info level.
func (o *Observer) Info(ctx context.Context, values ...any) error {
	return o.writeLog(ctx, "info", values)
}

// Debug logs at debug level (hidden from log search by default).
func (o *Observer) Debug(ctx context.Context, values ...any) error {
	return o.writeLog(ctx, "debug", values)
}

// Warn logs at warn level.
func (o *Observer) Warn(ctx context.Context, values ...any) error {
	return o.writeLog(ctx, "warn", values)
}

// Warning is Warn.
func (o *Observer) Warning(ctx context.Context, values ...any) error {
	return o.writeLog(ctx, "warn", values)
}

// Error logs at error level.
func (o *Observer) Error(ctx context.Context, values ...any) error {
	return o.writeLog(ctx, "error", values)
}

// CountView records a page view in the analytics category: data {path, endpointPath?} with
// paths only (see SafePath). A URL that is not HTTP is an error and nothing is emitted.
func (o *Observer) CountView(ctx context.Context, message string, view View) error {
	path, err := SafePath(view.URL)
	if err != nil {
		return err
	}
	data := map[string]any{"path": path}
	if view.APIURL != "" {
		endpoint, err := SafePath(view.APIURL)
		if err != nil {
			return err
		}
		data["endpointPath"] = endpoint
	}
	source := view.Source
	if source == "" {
		source = "spa"
	}
	return o.Emit(o.WithContext(ctx, map[string]string{"category": "analytics"}), "info", "pageview", source, message, data)
}

// RecordRequest records an API request; the level follows the status (error >= 500, warn >= 400).
// Use route templates ("/users/:id"), never real identifiers.
func (o *Observer) RecordRequest(ctx context.Context, metric RequestMetric) error {
	d, s := metric.DurationMs, metric.Status
	if math.IsNaN(d) || math.IsInf(d, 0) || d < 0 || s != math.Trunc(s) || s < 100 || s > 599 {
		return ErrInvalidMetric
	}
	path, err := SafePath(metric.URL)
	if err != nil {
		return err
	}
	level := "info"
	switch {
	case s >= 500:
		level = "error"
	case s >= 400:
		level = "warn"
	}
	return o.Emit(ctx, level, "request", "api", "HTTP request", map[string]any{"method": strings.ToUpper(metric.Method), "path": path, "status": s, "durationMs": d})
}

// Measure returns the operation's result and error unchanged and records its duration (kind
// "timing", source "app" when empty) with the Observer's clock, or a monotonic clock by default.
func Measure[T any](ctx context.Context, o *Observer, name, source string, operation func(context.Context) (T, error)) (T, error) {
	start := o.elapsed()
	failed := true
	defer func() {
		level := "info"
		if failed {
			level = "error"
		}
		if source == "" {
			source = "app"
		}
		_ = o.Emit(ctx, level, "timing", source, name, map[string]any{"name": name, "durationMs": o.elapsed() - start, "failed": failed})
	}()
	value, err := operation(ctx)
	failed = err != nil
	return value, err
}

var monotonic = time.Now()

func (o *Observer) elapsed() float64 {
	if o.now != nil {
		return float64(o.now().UnixMilli())
	}
	return float64(time.Since(monotonic).Nanoseconds()) / 1e6
}

// ISOTime is Date.prototype.toISOString: UTC with milliseconds and Z.
func ISOTime(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}
