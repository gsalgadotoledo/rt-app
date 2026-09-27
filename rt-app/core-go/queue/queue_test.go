package queue

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"rt.local/core-go/apperr"
	"rt.local/core-go/web"
)

var t0 = time.Date(2026, 1, 2, 3, 4, 5, 678_000_000, time.UTC)

type testClock struct {
	mu sync.Mutex
	at time.Time
}

func (c *testClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.at
}

func (c *testClock) add(d time.Duration) {
	c.mu.Lock()
	c.at = c.at.Add(d)
	c.mu.Unlock()
}

func newMemory(t *testing.T, capacity int) (*Memory, *testClock) {
	t.Helper()
	clock := &testClock{at: t0}
	m, err := NewMemory(capacity, 30*time.Second, WithClock(clock.now))
	if err != nil {
		t.Fatal(err)
	}
	return m, clock
}

func msg(id string) Message { return Message{ID: id, Type: "t", CreatedAt: "2026-01-02"} }

func TestMessageFromNormalizesAndKeepsExtras(t *testing.T) {
	var v any
	_ = json.Unmarshal([]byte(`{"id":"m","type":"t","createdAt":"2026-01-02","payload":{"z":[1.0,-0,1e21]},"x":true}`), &v)
	m, err := MessageFrom(v)
	if err != nil {
		t.Fatal(err)
	}
	out, _ := json.Marshal(m)
	if string(out) != `{"createdAt":"2026-01-02","id":"m","payload":{"z":[1,0,1e+21]},"type":"t","x":true}` {
		t.Fatalf("got %s", out)
	}
	for _, bad := range []string{`null`, `[]`, `{"id":"","type":"t","createdAt":"2026"}`, `{"id":"m","type":"t","createdAt":"2026","traceId":null}`, `{"id":" ","type":"t","createdAt":"2026"}`, `{"id":"m","type":"t","createdAt":"2026-13-01"}`} {
		_ = json.Unmarshal([]byte(bad), &v)
		if _, err := MessageFrom(v); !errors.Is(err, ErrInvalidMessage) {
			t.Errorf("%s: %v", bad, err)
		}
	}
	big := Message{ID: "m", Type: "t", CreatedAt: "2026-01-02T03:04:05.678Z", Payload: strings.Repeat("x", 239927)}
	if _, err := big.Validate(); err != nil {
		t.Fatal(err)
	}
	big.Payload = strings.Repeat("x", 239928)
	if _, err := big.Validate(); !errors.Is(err, ErrTooLarge) {
		t.Fatal(err)
	}
}

func TestParseDate(t *testing.T) {
	cases := map[string]int64{
		"2026-01-02T03:04:05.678Z":      1767323045678,
		"2026-01-02T05:04:05.678+02:00": 1767323045678,
		"-271821-04-20T00:00:00Z":       -8640000000000000,
		"2026-02-30":                    1772409600000,
		"-000001-12-31T23:59:59.999Z":   -62167219200001,
	}
	for s, want := range cases {
		if got, ok := ParseDate(s); !ok || got != want {
			t.Errorf("%s: %d %v", s, got, ok)
		}
	}
	for _, bad := range []string{"", "2026-01-02T24:00:01Z", "-000000-01-01", "20260102", "Jan 2 2026", "+275760-09-13T00:00:00.001Z"} {
		if _, ok := ParseDate(bad); ok {
			t.Errorf("%s accepted", bad)
		}
	}
}

func TestLeasesRetriesAndStaleReceipts(t *testing.T) {
	ctx := context.Background()
	m, clock := newMemory(t, 10)
	if _, err := NewMemory(1, 1500*time.Millisecond); !errors.Is(err, ErrMemoryLimits) {
		t.Fatal(err)
	}
	_ = m.Publish(ctx, msg("a"))
	_ = m.Publish(ctx, msg("b"))
	first, _ := m.Receive(ctx, 1)
	if err := first[0].Retry(ctx, 10*time.Second); err != nil {
		t.Fatal(err)
	}
	if err := first[0].Ack(ctx); !errors.Is(err, ErrStale) {
		t.Fatalf("ack after retry: %v", err)
	}
	second, _ := m.Receive(ctx, 10)
	if len(second) != 1 || second[0].Message().ID != "b" {
		t.Fatalf("got %v", second)
	}
	if err := second[0].Extend(ctx, 1500*time.Millisecond); !errors.Is(err, ErrDelay) {
		t.Fatal(err)
	}
	clock.add(30 * time.Second)
	if err := second[0].Ack(ctx); !errors.Is(err, ErrStale) {
		t.Fatal(err)
	}
	all, _ := m.Receive(ctx, 10)
	if len(all) != 2 || all[0].Message().ID != "a" || all[0].Attempts() != 2 {
		t.Fatalf("publish order: %v", all)
	}
	if _, err := m.Receive(ctx, 11); !errors.Is(err, ErrReceiveLimit) {
		t.Fatal(err)
	}
}

func TestDeadLettersAndRetryFailure(t *testing.T) {
	ctx := context.Background()
	m, _ := newMemory(t, 1)
	_ = m.Publish(ctx, msg("a"))
	if err := m.Publish(ctx, Message{}); !errors.Is(err, ErrCapacity) {
		t.Fatal("capacity is checked first:", err)
	}
	d, _ := m.Receive(ctx, 1)
	_ = d[0].DeadLetter(ctx)
	_ = m.Publish(ctx, msg("b"))
	d, _ = m.Receive(ctx, 1)
	if err := d[0].DeadLetter(ctx); !errors.Is(err, ErrDeadLetterCapacity) {
		t.Fatal(err)
	}
	items, _ := m.InspectFailures(ctx, 10)
	if err := m.RetryFailure(ctx, items[0].Token); err != ErrRetryCapacity {
		t.Fatal(err)
	}
	_ = d[0].Ack(ctx)
	if err := m.RetryFailure(ctx, items[0].Token); err != nil {
		t.Fatal(err)
	}
	if err := m.RetryFailure(ctx, items[0].Token); err != ErrNotAvailable {
		t.Fatal(err)
	}
	if _, err := m.InspectFailures(ctx, 0); err != ErrFailureLimit {
		t.Fatal(err)
	}
}

func TestWorkOnceBackoffAndDeadLetters(t *testing.T) {
	ctx := context.Background()
	m, clock := newMemory(t, 10)
	q := New(m, WithClock(clock.now), WithRandom(func() float64 { return 0.999999 }))
	if _, err := q.Send(ctx, "x", 1, WithID("bad")); err != nil {
		t.Fatal(err)
	}
	if _, err := q.Send(ctx, "x", 2, WithID("")); !errors.Is(err, ErrInvalidMessage) {
		t.Fatal("an explicit empty id is rejected:", err)
	}
	handler := func(context.Context, Delivery) error { return errors.New("boom") }
	opts := DefaultWorkerOptions
	opts.MaxAttempts = 2
	if n, err := q.WorkOnce(ctx, handler, opts); n != 1 || err != nil {
		t.Fatal(n, err)
	}
	clock.add(999 * time.Millisecond)
	if n, _ := q.WorkOnce(ctx, handler, opts); n != 0 {
		t.Fatal("retried before its backoff")
	}
	clock.add(time.Millisecond)
	if n, _ := q.WorkOnce(ctx, handler, opts); n != 1 {
		t.Fatal("not retried after 1 s")
	}
	if dl := m.DeadLetters(); len(dl) != 1 || dl[0].CreatedAt != "2026-01-02T03:04:05.678Z" {
		t.Fatalf("dead letters %v", dl)
	}
	opts.BaseDelay = 2 * time.Minute
	if _, err := q.WorkOnce(ctx, handler, opts); !errors.Is(err, ErrWorkerLimits) {
		t.Fatal(err)
	}
	if o := WorkerOptionsFrom(map[string]any{"concurrency": "4", "idleMs": 0.5}); o.validate() == nil || o.Idle >= time.Millisecond {
		t.Fatalf("loose options %+v", o)
	}
}

func TestSettlementFailuresAndBusyWorker(t *testing.T) {
	ctx := context.Background()
	m, clock := newMemory(t, 10)
	q := New(m, WithClock(clock.now))
	_, _ = q.Send(ctx, "x", 1)
	var nested error
	_, err := q.WorkOnce(ctx, func(ctx context.Context, d Delivery) error {
		_, nested = q.WorkOnce(ctx, func(context.Context, Delivery) error { return nil }, DefaultWorkerOptions)
		return d.Ack(ctx)
	}, DefaultWorkerOptions)
	var settlement *SettlementError
	if !errors.As(err, &settlement) || err.Error() != "Queue settlement failed" || !errors.Is(err, ErrStale) {
		t.Fatal(err)
	}
	if !errors.Is(nested, ErrWorking) {
		t.Fatal(nested)
	}
}

func TestRunStopsOnCancel(t *testing.T) {
	m, clock := newMemory(t, 10)
	q := New(m, WithClock(clock.now))
	ctx, cancel := context.WithCancel(context.Background())
	for range 3 {
		_, _ = q.Send(ctx, "x", 1)
	}
	count := 0
	opts := DefaultWorkerOptions
	opts.Concurrency, opts.Idle = 1, time.Millisecond
	err := q.Run(ctx, func(context.Context, Delivery) error {
		if count++; count == 3 {
			cancel()
		}
		return nil
	}, opts)
	if err != nil || count != 3 {
		t.Fatal(err, count)
	}
	opts.Idle = 0
	if err := q.Run(ctx, nil, opts); !errors.Is(err, ErrPollInterval) {
		t.Fatal(err)
	}
}

func TestEndpointsInLocalMode(t *testing.T) {
	m, _ := newMemory(t, 10)
	app, err := web.New([]web.Feature{New(m).Feature()}, web.WithLocalAdmin())
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct{ method, path, body, want string }{
		{"GET", "/admin/app/queue/status", "", `{"capabilities":{"delayedRetry":true,"leaseRenewal":true,"durable":false,"failedAdmin":true},"supported":true}`},
		{"GET", "/queue/status", "", `{"error":"Sign in"}`},
		{"POST", "/admin/app/queue/failed/inspect", `{}`, `{"items":[]}`},
		{"POST", "/admin/app/queue/failed/inspect", `{"limit":0}`, `{"error":"Limit must be between 1 and 10"}`},
		{"POST", "/admin/app/queue/failed/retry", `{"token":"x"}`, `{"error":"Message is no longer available; refresh the list"}`},
	}
	for _, c := range cases {
		r, _ := web.NewRequest(context.Background(), c.method, c.path, strings.NewReader(c.body))
		w := httptest.NewRecorder()
		app.ServeHTTP(w, r)
		if got := strings.TrimSpace(w.Body.String()); got != c.want {
			t.Errorf("%s %s: %s", c.method, c.path, got)
		}
	}
	unsupported := New(plain{})
	if _, err := unsupported.Inspect(context.Background(), map[string]any{"limit": 0.0}); err != ErrInspectUnsupported {
		t.Fatal(err)
	}
	if e, _ := apperr.As(ErrRetryUnsupported); e.Status != 501 {
		t.Fatal(e)
	}
}

type plain struct{}

func (plain) Capabilities() Capabilities                       { return Capabilities{Durable: true} }
func (plain) Publish(context.Context, Message) error           { return nil }
func (plain) Receive(context.Context, int) ([]Delivery, error) { return nil, nil }
