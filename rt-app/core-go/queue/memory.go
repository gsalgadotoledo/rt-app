package queue

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"sync"
	"time"

	"rt.local/core-go/apperr"
	"rt.local/core-go/internal/uuid"
)

// MaxDelay is the longest visibility delay (retry, extend): 12 hours.
const MaxDelay = 12 * time.Hour

// Memory adapter errors with the TypeScript messages.
var (
	ErrMemoryLimits       = errors.New("Invalid memory queue limits")
	ErrCapacity           = errors.New("Queue capacity exceeded")
	ErrReceiveLimit       = errors.New("Invalid receive limit")
	ErrStale              = errors.New("Stale queue receipt")
	ErrDelay              = errors.New("Invalid visibility delay")
	ErrDeadLetterCapacity = errors.New("Dead-letter capacity exceeded")
	ErrNotAvailable       = apperr.New(http.StatusConflict, "Message is no longer available; refresh the list")
	ErrRetryCapacity      = apperr.New(http.StatusConflict, "Queue capacity exceeded")
	ErrFailureLimit       = apperr.BadRequest("Limit must be between 1 and 10")
)

// ValidateFailureLimit keeps broker inspection bounded: 1 to 10 (400 otherwise).
func ValidateFailureLimit(limit int) error {
	if limit < 1 || limit > 10 {
		return ErrFailureLimit
	}
	return nil
}

// validDelay: whole seconds from 0 to MaxDelay.
func validDelay(d time.Duration) error {
	if d < 0 || d > MaxDelay || d%time.Second != 0 {
		return ErrDelay
	}
	return nil
}

type entry struct {
	message   Message
	attempts  int
	available int64 // epoch milliseconds
	receipt   string
}

type failed struct {
	token   string
	message Message
}

// Memory is the bounded ephemeral adapter for development (MemoryQueue): no durability across
// restarts. Entries keep publish order; there is no deduplication. Safe for concurrent use.
type Memory struct {
	capacity int
	lease    time.Duration
	now      func() time.Time

	mu      sync.Mutex
	entries []*entry
	failed  []failed
}

// NewMemory returns an adapter holding at most capacity pending or leased messages (and as many
// dead letters) that leases received messages for lease (whole seconds, at least 1 s).
func NewMemory(capacity int, lease time.Duration, opts ...Option) (*Memory, error) {
	if capacity < 1 || lease < time.Second || lease%time.Second != 0 {
		return nil, ErrMemoryLimits
	}
	return &Memory{capacity: capacity, lease: lease, now: configure(opts).now}, nil
}

func (m *Memory) millis() int64 { return m.now().UnixMilli() }

// Capabilities: delayed retry, lease renewal and failed-message admin; not durable.
func (m *Memory) Capabilities() Capabilities {
	return Capabilities{DelayedRetry: true, LeaseRenewal: true, Durable: false, FailedAdmin: true}
}

// Publish validates the message (after the capacity check) and makes it visible now.
func (m *Memory) Publish(_ context.Context, message Message) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.entries) >= m.capacity {
		return ErrCapacity
	}
	valid, err := message.Validate()
	if err != nil {
		return err
	}
	m.entries = append(m.entries, &entry{message: valid, available: m.millis()})
	return nil
}

// Receive leases up to limit (1-10) visible messages in publish order.
func (m *Memory) Receive(ctx context.Context, limit int) ([]Delivery, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if limit < 1 || limit > 10 {
		return nil, ErrReceiveLimit
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	now := m.millis()
	deliveries := []Delivery{}
	for _, e := range m.entries {
		if len(deliveries) == limit {
			break
		}
		if e.available > now {
			continue
		}
		e.receipt = uuid.New()
		e.attempts++
		e.available = m.millis() + m.lease.Milliseconds()
		deliveries = append(deliveries, &memoryDelivery{queue: m, entry: e, receipt: e.receipt, message: e.message.clone(), attempts: e.attempts})
	}
	return deliveries, nil
}

// InspectFailures is a non-destructive snapshot of the first limit dead letters.
func (m *Memory) InspectFailures(_ context.Context, limit int) ([]FailedMessage, error) {
	if err := ValidateFailureLimit(limit); err != nil {
		return nil, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	items := []FailedMessage{}
	for _, f := range m.failed[:min(limit, len(m.failed))] {
		message := f.message.clone()
		items = append(items, FailedMessage{Token: f.token, ID: f.message.ID, Message: &message, Retryable: true})
	}
	return items, nil
}

// RetryFailure moves a dead letter back to pending (attempts 0, visible now, at the end); a
// token works once (409 afterwards), and the queue capacity applies (409).
func (m *Memory) RetryFailure(_ context.Context, token string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	index := slices.IndexFunc(m.failed, func(f failed) bool { return f.token == token })
	if index < 0 {
		return ErrNotAvailable
	}
	if len(m.entries) >= m.capacity {
		return ErrRetryCapacity
	}
	m.entries = append(m.entries, &entry{message: m.failed[index].message, available: m.millis()})
	m.failed = slices.Delete(m.failed, index, index+1)
	return nil
}

// DeadLetters returns copies of the dead-lettered messages (diagnostics only).
func (m *Memory) DeadLetters() []Message {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Message, len(m.failed))
	for i, f := range m.failed {
		out[i] = f.message.clone()
	}
	return out
}

// remove drops an entry; the caller holds the lock.
func (m *Memory) remove(e *entry) {
	m.entries = slices.DeleteFunc(m.entries, func(x *entry) bool { return x == e })
}

type memoryDelivery struct {
	queue    *Memory
	entry    *entry
	receipt  string
	message  Message
	attempts int
}

func (d *memoryDelivery) Message() Message { return d.message }
func (d *memoryDelivery) Attempts() int    { return d.attempts }

// check fails with ErrStale when the receipt was replaced, the entry is gone or the lease
// ended (at its expiry exactly). The caller holds the lock.
func (d *memoryDelivery) check() error {
	if d.entry.receipt != d.receipt || !slices.Contains(d.queue.entries, d.entry) || d.entry.available <= d.queue.millis() {
		return ErrStale
	}
	return nil
}

func (d *memoryDelivery) Ack(context.Context) error {
	d.queue.mu.Lock()
	defer d.queue.mu.Unlock()
	if err := d.check(); err != nil {
		return err
	}
	d.queue.remove(d.entry)
	return nil
}

func (d *memoryDelivery) Retry(_ context.Context, delay time.Duration) error {
	d.queue.mu.Lock()
	defer d.queue.mu.Unlock()
	if err := d.check(); err != nil {
		return err
	}
	if err := validDelay(delay); err != nil {
		return err
	}
	d.entry.receipt = ""
	d.entry.available = d.queue.millis() + delay.Milliseconds()
	return nil
}

func (d *memoryDelivery) Extend(_ context.Context, lease time.Duration) error {
	d.queue.mu.Lock()
	defer d.queue.mu.Unlock()
	if err := d.check(); err != nil {
		return err
	}
	if err := validDelay(lease); err != nil {
		return err
	}
	d.entry.available = d.queue.millis() + lease.Milliseconds()
	return nil
}

func (d *memoryDelivery) DeadLetter(context.Context) error {
	d.queue.mu.Lock()
	defer d.queue.mu.Unlock()
	if err := d.check(); err != nil {
		return err
	}
	if len(d.queue.failed) >= d.queue.capacity {
		return ErrDeadLetterCapacity
	}
	d.queue.failed = append(d.queue.failed, failed{token: uuid.New(), message: d.entry.message})
	d.queue.remove(d.entry)
	return nil
}
