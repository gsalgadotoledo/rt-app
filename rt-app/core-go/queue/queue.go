// Package queue is at-least-once background work with an in-memory adapter (port of
// @gsalgadotoledo/rt-app-queue).
//
// Compose it in main.go like any component:
//
//	adapter, _ := queue.NewMemory(1000, 30*time.Second)
//	q := queue.New(adapter)
//	id, err := q.Send(ctx, "email", map[string]any{"to": "a@example.com"})
//	n, err := q.WorkOnce(ctx, handle, queue.DefaultWorkerOptions)   // handle returns an error to retry
//	features := []web.Feature{q.Feature()}                            // owner DLQ endpoints
//
// Rules shared with TypeScript (see rt-app/docs/polyglot/queue.md and the queue contract):
//   - Messages are JSON envelopes validated like TypeScript (MessageFrom, Message.Validate);
//     the canonical JSON is at most 240000 UTF-8 bytes.
//   - Memory keeps publish order, leases received messages and has no deduplication. A delivery
//     is stale once redelivered, retried, settled or at its lease expiry (ErrStale).
//   - WorkOnce runs handlers concurrently, acknowledges successes, retries failures with
//     jittered exponential backoff and dead-letters them at MaxAttempts.
//   - Time comes from an injectable clock (WithClock), jitter from WithRandom.
package queue

import (
	"context"
	"errors"
	"fmt"
	"math"
	"math/rand/v2"
	"sync"
	"time"

	"rt.local/core-go/internal/js"
	"rt.local/core-go/internal/uuid"
)

// Capabilities an adapter declares.
type Capabilities struct {
	DelayedRetry bool `json:"delayedRetry"`
	LeaseRenewal bool `json:"leaseRenewal"`
	Durable      bool `json:"durable"`
	FailedAdmin  bool `json:"failedAdmin"`
}

// Delivery is one received message. Settle it once: Ack, Retry or DeadLetter.
type Delivery interface {
	Message() Message
	Attempts() int
	Ack(ctx context.Context) error
	// Retry makes the message visible again after delay (whole seconds, 0 to MaxDelay).
	Retry(ctx context.Context, delay time.Duration) error
	DeadLetter(ctx context.Context) error
	// Extend renews long work explicitly. Unsupported brokers fail rather than pretend.
	Extend(ctx context.Context, lease time.Duration) error
}

// Adapter is a broker: Memory here; the SQS and RabbitMQ adapters implement the same surface.
type Adapter interface {
	Capabilities() Capabilities
	Publish(ctx context.Context, message Message) error
	Receive(ctx context.Context, limit int) ([]Delivery, error)
}

// FailureAdmin is the optional dead-letter administration of an adapter (FailedAdmin).
type FailureAdmin interface {
	InspectFailures(ctx context.Context, limit int) ([]FailedMessage, error)
	RetryFailure(ctx context.Context, token string) error
}

// FailedMessage is one inspected dead letter.
type FailedMessage struct {
	Token     string   `json:"token"`
	ID        string   `json:"id"`
	Message   *Message `json:"message"`
	Retryable bool     `json:"retryable"`
	ExpiresAt string   `json:"expiresAt,omitempty"`
}

// Worker errors with the TypeScript messages.
var (
	ErrWorkerLimits = errors.New("Invalid worker limits")
	ErrWorking      = errors.New("Worker already receiving")
	ErrPollInterval = errors.New("Invalid poll interval")
)

// SettlementError collects the acknowledgement, retry and dead-letter failures of one batch.
type SettlementError struct{ Errs []error }

func (e *SettlementError) Error() string   { return "Queue settlement failed" }
func (e *SettlementError) Unwrap() []error { return e.Errs }

// Option configures a Queue or a Memory adapter.
type Option func(*options)

type options struct {
	now    func() time.Time
	random func() float64
}

// WithClock sets the clock (default time.Now): createdAt, visibility and leases.
func WithClock(now func() time.Time) Option { return func(o *options) { o.now = now } }

// WithRandom sets the retry jitter source in [0, 1) (default math/rand/v2).
func WithRandom(random func() float64) Option { return func(o *options) { o.random = random } }

func configure(opts []Option) options {
	o := options{now: time.Now, random: rand.Float64}
	for _, opt := range opts {
		opt(&o)
	}
	return o
}

// WorkerOptions bound one worker. Start from DefaultWorkerOptions.
type WorkerOptions struct {
	Concurrency int           // 1-10 messages per WorkOnce
	MaxAttempts int           // >= 1; failures at this attempt are dead-lettered
	BaseDelay   time.Duration // whole seconds, 0 to MaxDelay, <= MaxDelay below
	MaxDelay    time.Duration // whole seconds, 0 to MaxDelay
	Idle        time.Duration // Run's sleep when nothing was received, >= 1 ms
}

// DefaultWorkerOptions are the TypeScript defaults.
var DefaultWorkerOptions = WorkerOptions{Concurrency: 4, MaxAttempts: 5, BaseDelay: time.Second, MaxDelay: time.Minute, Idle: 250 * time.Millisecond}

func (o WorkerOptions) validate() error {
	if o.Concurrency < 1 || o.Concurrency > 10 || o.MaxAttempts < 1 || validDelay(o.BaseDelay) != nil || validDelay(o.MaxDelay) != nil || o.BaseDelay > o.MaxDelay {
		return ErrWorkerLimits
	}
	return nil
}

// WorkerOptionsFrom reads loosely typed options (decoded JSON with the TypeScript names
// concurrency, maxAttempts, baseDelaySeconds, maxDelaySeconds, idleMs): missing or null fields
// take the defaults, anything else that is not a number of the right kind is invalid.
func WorkerOptionsFrom(v map[string]any) WorkerOptions {
	o := DefaultWorkerOptions
	integer := func(name string, set func(int)) {
		if raw, ok := v[name]; ok && raw != nil {
			if f, ok := js.Integer(raw); ok && math.Abs(f) < 1<<53 {
				set(int(f))
			} else {
				set(-1)
			}
		}
	}
	seconds := func(name string, set func(time.Duration)) {
		if raw, ok := v[name]; ok && raw != nil {
			if f, ok := raw.(float64); ok && math.Abs(f) <= float64(MaxDelay/time.Second)+1 {
				set(time.Duration(f * float64(time.Second)))
			} else {
				set(-1)
			}
		}
	}
	integer("concurrency", func(n int) { o.Concurrency = n })
	integer("maxAttempts", func(n int) { o.MaxAttempts = n })
	seconds("baseDelaySeconds", func(d time.Duration) { o.BaseDelay = d })
	seconds("maxDelaySeconds", func(d time.Duration) { o.MaxDelay = d })
	if raw, ok := v["idleMs"]; ok && raw != nil {
		if f, ok := raw.(float64); ok && !math.IsInf(f, 0) && f < 1e12 {
			o.Idle = time.Duration(f * float64(time.Millisecond))
		} else {
			o.Idle = -1
		}
	}
	return o
}

// Handler does the work of one delivery; an error (or a panic) retries it.
type Handler func(ctx context.Context, delivery Delivery) error

// Queue sends messages and runs workers over an adapter. Handlers own business idempotency:
// delivery is at least once, and enqueue acceptance is not completion.
type Queue struct {
	adapter Adapter
	opts    options

	mu      sync.Mutex
	working bool
}

// New returns a queue over adapter.
func New(adapter Adapter, opts ...Option) *Queue {
	return &Queue{adapter: adapter, opts: configure(opts)}
}

// Adapter returns the queue's adapter.
func (q *Queue) Adapter() Adapter { return q.adapter }

// SendOption sets the logical id or the trace id of a sent message.
type SendOption func(*Message)

// WithID reuses a logical id (retries of the same send); brokers can still duplicate it.
func WithID(id string) SendOption { return func(m *Message) { m.ID = id } }

// WithTraceID sets the trace id; an empty one is ignored.
func WithTraceID(trace string) SendOption {
	return func(m *Message) {
		if trace != "" {
			m.TraceID = &trace
		}
	}
}

// Send validates and publishes a message and returns its id (a random UUID v4 by default);
// createdAt is the clock's time as toISOString().
func (q *Queue) Send(ctx context.Context, typ string, payload any, opts ...SendOption) (string, error) {
	m := Message{ID: uuid.New(), Type: typ, Payload: payload, CreatedAt: q.opts.now().UTC().Format("2006-01-02T15:04:05.000Z")}
	for _, opt := range opts {
		opt(&m)
	}
	valid, err := m.Validate()
	if err != nil {
		return "", err
	}
	if err := q.adapter.Publish(ctx, valid); err != nil {
		return "", err
	}
	return valid.ID, nil
}

// WorkOnce receives up to Concurrency messages and handles them concurrently: success
// acknowledges (strictly after the work), failure retries with jittered exponential backoff
// or dead-letters at MaxAttempts. It returns the number of deliveries; settlement failures are
// returned together, after every delivery settled, as *SettlementError.
func (q *Queue) WorkOnce(ctx context.Context, handler Handler, opts WorkerOptions) (int, error) {
	if err := opts.validate(); err != nil {
		return 0, err
	}
	q.mu.Lock()
	if q.working {
		q.mu.Unlock()
		return 0, ErrWorking
	}
	q.working = true
	q.mu.Unlock()
	defer func() {
		q.mu.Lock()
		q.working = false
		q.mu.Unlock()
	}()
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	deliveries, err := q.adapter.Receive(ctx, opts.Concurrency)
	if err != nil {
		return 0, err
	}
	delayed := q.adapter.Capabilities().DelayedRetry
	errs := make([]error, len(deliveries))
	var wg sync.WaitGroup
	for i, d := range deliveries {
		wg.Go(func() {
			if err := run(ctx, handler, d); err != nil {
				if d.Attempts() >= opts.MaxAttempts {
					errs[i] = d.DeadLetter(ctx)
				} else {
					errs[i] = d.Retry(ctx, q.backoff(delayed, d.Attempts(), opts))
				}
				return
			}
			// If acknowledgement fails, do not immediately retry a successful side effect.
			errs[i] = d.Ack(ctx)
		})
	}
	wg.Wait()
	var failures []error
	for _, err := range errs {
		if err != nil {
			failures = append(failures, err)
		}
	}
	if len(failures) > 0 {
		return 0, &SettlementError{Errs: failures}
	}
	return len(deliveries), nil
}

// backoff is floor(random * (min(max, base * 2^min(attempts-1, 20)) + 1)) seconds, or 0 when
// the adapter cannot delay retries.
func (q *Queue) backoff(delayed bool, attempts int, opts WorkerOptions) time.Duration {
	if !delayed {
		return 0
	}
	base, maximum := opts.BaseDelay.Seconds(), opts.MaxDelay.Seconds()
	ceiling := math.Min(maximum, base*math.Pow(2, float64(min(attempts-1, 20))))
	return time.Duration(math.Floor(q.opts.random()*(ceiling+1))) * time.Second
}

// run calls the handler; a panic counts as a failure.
func run(ctx context.Context, handler Handler, d Delivery) (err error) {
	defer func() {
		if p := recover(); p != nil {
			err = fmt.Errorf("queue: handler panic: %v", p)
		}
	}()
	return handler(ctx, d)
}

// Run works until ctx is done, sleeping Idle when nothing was received. Cancelling stops new
// pulls (current work drains) and returns nil; other errors are returned.
func (q *Queue) Run(ctx context.Context, handler Handler, opts WorkerOptions) error {
	if opts.Idle < time.Millisecond {
		return ErrPollInterval
	}
	for ctx.Err() == nil {
		n, err := q.WorkOnce(ctx, handler, opts)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		if n == 0 {
			select {
			case <-ctx.Done():
			case <-time.After(opts.Idle):
			}
		}
	}
	return nil
}
