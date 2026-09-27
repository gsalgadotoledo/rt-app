package health

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"rt.local/core-go/apperr"
	"rt.local/core-go/web"
)

var t0 = time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)

func failing(context.Context) error { return errors.New("password=secret") }
func passing(context.Context) error { return nil }

func TestReportRedactsFailuresAndKeepsOrder(t *testing.T) {
	checks, err := New([]Probe{{ID: "db", Check: failing}, {ID: "search", Optional: true, Check: passing}}, WithClock(func() time.Time { return t0 }))
	if err != nil {
		t.Fatal(err)
	}
	report, err := checks.Report(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if report.OK || report.At != "2030-01-01T00:00:00.000Z" || len(report.Checks) != 2 {
		t.Fatalf("report = %+v", report)
	}
	if c := report.Checks[0]; c.ID != "db" || !c.Required || c.Status != Down {
		t.Errorf("db = %+v", c)
	}
	if c := report.Checks[1]; c.ID != "search" || c.Required || c.Status != Up {
		t.Errorf("search = %+v", c)
	}
}

func TestCacheUsesTheClock(t *testing.T) {
	now, calls := t0, atomic.Int32{}
	checks, _ := New([]Probe{{ID: "db", Check: func(context.Context) error { calls.Add(1); return nil }}},
		WithCache(time.Second), WithClock(func() time.Time { return now }))
	ctx := context.Background()
	first, _ := checks.Report(ctx)
	first.Checks[0].Status = Down // callers get copies
	now = t0.Add(999 * time.Millisecond)
	if r, _ := checks.Report(ctx); r.Checks[0].Status != Up || calls.Load() != 1 {
		t.Fatalf("cached report = %+v, calls %d", r, calls.Load())
	}
	now = t0.Add(time.Second)
	if r, _ := checks.Report(ctx); r.At != "2030-01-01T00:00:01.000Z" || calls.Load() != 2 {
		t.Fatalf("expired report = %+v, calls %d", r, calls.Load())
	}
}

func TestTimeoutsCancelAndProbesRunInParallel(t *testing.T) {
	var cancelled atomic.Bool
	probes := []Probe{{ID: "hang", Optional: true, Check: func(ctx context.Context) error {
		<-ctx.Done()
		cancelled.Store(true)
		return ctx.Err()
	}}}
	for _, id := range []string{"a", "b", "c", "d", "e"} {
		probes = append(probes, Probe{ID: id, Check: func(context.Context) error { time.Sleep(50 * time.Millisecond); return nil }})
	}
	checks, _ := New(probes, WithTimeout(200*time.Millisecond), WithCache(0))
	report, _ := checks.Report(context.Background())
	if !report.OK || report.Checks[0].Status != Down {
		t.Fatalf("report = %+v", report)
	}
	for _, c := range report.Checks[1:] {
		if c.Status != Up {
			t.Errorf("%s = %s", c.ID, c.Status)
		}
	}
	time.Sleep(10 * time.Millisecond)
	if !cancelled.Load() {
		t.Error("the timed-out probe was not cancelled")
	}
}

func TestConcurrentCallersShareOneRun(t *testing.T) {
	var calls atomic.Int32
	checks, _ := New([]Probe{{ID: "db", Check: func(context.Context) error {
		calls.Add(1)
		time.Sleep(50 * time.Millisecond)
		return nil
	}}}, WithCache(0))
	var wg sync.WaitGroup
	for range 4 {
		wg.Go(func() { _, _ = checks.Report(context.Background()) })
	}
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatalf("calls = %d", calls.Load())
	}
}

func TestPanickingProbesAreDown(t *testing.T) {
	checks, _ := New([]Probe{{ID: "p", Check: func(context.Context) error { panic("boom") }}, {ID: "nil"}})
	report, _ := checks.Report(context.Background())
	if report.OK || report.Checks[0].Status != Down || report.Checks[1].Status != Down {
		t.Fatalf("report = %+v", report)
	}
}

func TestInvalidConfiguration(t *testing.T) {
	many := make([]Probe, 21)
	for i := range many {
		many[i] = Probe{ID: string(rune('a' + i))}
	}
	for name, c := range map[string]struct {
		probes  []Probe
		options []Option
	}{
		"timeout 0":      {nil, []Option{WithTimeout(0)}},
		"timeout 0.5 ms": {nil, []Option{WithTimeout(500 * time.Microsecond)}},
		"negative cache": {nil, []Option{WithCache(-1)}},
		"duplicate ids":  {[]Probe{{ID: "db"}, {ID: "db"}}, nil},
		"21 probes":      {many, nil},
	} {
		if _, err := New(c.probes, c.options...); !errors.Is(err, ErrInvalidConfig) {
			t.Errorf("%s: err = %v", name, err)
		}
	}
	if _, err := New(many[:20], WithTimeout(time.Millisecond), WithCache(0)); err != nil {
		t.Error(err)
	}
}

func TestEndpoints(t *testing.T) {
	checks, _ := New([]Probe{{ID: "db", Check: failing}}, WithCache(0))
	app, err := web.New([]web.Feature{checks.Feature()}, web.WithLocalAdmin())
	if err != nil {
		t.Fatal(err)
	}
	for path, want := range map[string]int{"/health/live": 200, "/health/ready": 503, "/health/report": 404, "/admin/app/health/report": 200} {
		rec := httptest.NewRecorder()
		app.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
		if rec.Code != want {
			t.Errorf("GET %s = %d %s", path, rec.Code, rec.Body)
		}
	}
	if e, ok := apperr.As(ErrUnavailable); !ok || e.Status != 503 || e.Message != "Service unavailable" {
		t.Error(ErrUnavailable)
	}
	if len(Feature().Endpoints) != 2 {
		t.Error("the compatibility feature serves live and ready only")
	}
}

func TestMonitorAlertsTransitionsAndRetries(t *testing.T) {
	var down, failNext atomic.Bool
	down.Store(true)
	var alerts []string
	checks, _ := New([]Probe{{ID: "api", Check: func(context.Context) error {
		if down.Load() {
			return errors.New("down")
		}
		return nil
	}}}, WithCache(0))
	monitor := NewMonitor(checks, func(_ context.Context, a Alert) error {
		if failNext.Swap(false) {
			return errors.New("mail offline")
		}
		alerts = append(alerts, a.Service+":"+a.Status)
		return nil
	})
	ctx := context.Background()
	_, _ = monitor.Poll(ctx)
	_, _ = monitor.Poll(ctx)
	down.Store(false)
	failNext.Store(true)
	if _, err := monitor.Poll(ctx); err == nil || err.Error() != "mail offline" {
		t.Fatalf("err = %v", err)
	}
	_, _ = monitor.Poll(ctx)
	if strings.Join(alerts, ",") != "api:down,api:up" {
		t.Fatalf("alerts = %v", alerts)
	}
}

func TestHTTPProbe(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/ok":
			w.WriteHeader(200)
		case "/redirect":
			http.Redirect(w, r, "/ok", http.StatusFound)
		default:
			w.WriteHeader(503)
		}
	}))
	defer server.Close()
	ctx := context.Background()
	for path, healthy := range map[string]bool{"/ok": true, "/redirect": false, "/fail": false} {
		probe, err := HTTPProbe("svc", server.URL+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		if err := probe.Check(ctx); (err == nil) != healthy {
			t.Errorf("%s: err = %v", path, err)
		}
	}
	for url, want := range map[string]error{
		"ftp://example.test": ErrInvalidHealthURL, "mailto:a@b.test": ErrInvalidHealthURL,
		"https://user:pass@example.test": ErrInvalidHealthURL, "https://:secret@example.test": ErrInvalidHealthURL,
		"https://user@example.test": ErrInvalidHealthURL, "": ErrInvalidURL, "relative/path": ErrInvalidURL,
		"/abs": ErrInvalidURL, "http://": ErrInvalidURL, "https://example.test:99999": ErrInvalidURL,
		"https://@example.test": nil, "https://:@example.test": nil, "HTTPS://EXAMPLE.TEST/": nil,
	} {
		if _, err := HTTPProbe("x", url, nil); !errors.Is(err, want) {
			t.Errorf("%q: err = %v, want %v", url, err, want)
		}
	}
}
