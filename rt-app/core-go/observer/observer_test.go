package observer_test

import (
	"context"
	"errors"
	"fmt"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"rt.local/core-go/apperr"
	"rt.local/core-go/nosql"
	"rt.local/core-go/observer"
	"rt.local/core-go/web"
)

var t0 = time.UnixMilli(1_772_600_767_890).UTC() // 2026-03-04T05:06:07.890Z

type recorder struct {
	id, behavior string
	mu           sync.Mutex
	events       []observer.Event
	aborted      bool
}

func (r *recorder) ID() string { return r.id }

func (r *recorder) Write(ctx context.Context, event observer.Event) error {
	switch r.behavior {
	case "fail":
		return errors.New("password=hunter2")
	case "hang":
		<-ctx.Done()
		r.mu.Lock()
		r.aborted = true
		r.mu.Unlock()
		return ctx.Err()
	case "panic":
		panic("broken output")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, event)
	return nil
}

func (r *recorder) list() []observer.Event {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]observer.Event(nil), r.events...)
}

type fixture struct {
	mu  sync.Mutex
	now time.Time
	ids int
}

func (f *fixture) clock() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.now
}

func (f *fixture) advance(d time.Duration) {
	f.mu.Lock()
	f.now = f.now.Add(d)
	f.mu.Unlock()
}

func (f *fixture) observer(t *testing.T, outputs []observer.Output, options ...observer.Option) *observer.Observer {
	t.Helper()
	options = append([]observer.Option{observer.WithClock(f.clock), observer.WithIDs(func() string {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.ids++
		return fmt.Sprintf("e%d", f.ids)
	})}, options...)
	o, err := observer.New(outputs, options...)
	if err != nil {
		t.Fatal(err)
	}
	return o
}

func TestSanitize(t *testing.T) {
	got := observer.Sanitize(map[string]any{"password": "x", "zip": 1.0, "name": "me@example.com", "note": "Bearer abc token=1", "\u017fecret": "kept"})
	want := map[string]any{"password": "[redacted]", "zip": "[redacted]", "name": "[email]", "note": "Bearer [redacted] token=[redacted]", "\u017fecret": "kept"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("got %v", got)
	}
	if s := observer.Sanitize(strings.Repeat("😀", 501)).(string); s != strings.Repeat("😀", 500) {
		t.Fatalf("UTF-16 cut: %d runes", len([]rune(s)))
	}
	if s := observer.Sanitize("Bearer\u00a0x"); s != "Bearer [redacted]" {
		t.Fatalf("JavaScript whitespace: %v", s)
	}
	deep := observer.Sanitize(map[string]any{"a": map[string]any{"b": map[string]any{"c": map[string]any{"d": map[string]any{"e": 1.0}}}}})
	if fmt.Sprint(deep) != "map[a:map[b:map[c:map[d:map[e:[truncated]]]]]]" {
		t.Fatalf("depth: %v", deep)
	}
	if keys := observer.OrderedKeys(map[string]any{"b": 1, "10": 2, "2": 3, "01": 4}); strings.Join(keys, ",") != "2,10,01,b" {
		t.Fatalf("order: %v", keys)
	}
	if got := observer.Sanitize(errors.New("secret")); fmt.Sprint(got) != "map[name:Error]" {
		t.Fatalf("errors: %v", got)
	}
}

func TestSafePath(t *testing.T) {
	for in, want := range map[string]string{"https://u:p@h.test/a b/../c?q#f": "/c", "../x": "/x", "/{^}": "/%7B%5E%7D", "http://[::1]:80/p": "/p"} {
		if got, err := observer.SafePath(in); err != nil || got != want {
			t.Errorf("SafePath(%q) = %q, %v", in, got, err)
		}
	}
	for in, want := range map[string]error{"javascript:x": observer.ErrNotHTTP, "http://": observer.ErrInvalidURL, "http://h:99999/": observer.ErrInvalidURL} {
		if _, err := observer.SafePath(in); err != want {
			t.Errorf("SafePath(%q) error = %v", in, err)
		}
	}
}

func TestEventsContextAndHelpers(t *testing.T) {
	f := &fixture{now: t0}
	spy := &recorder{id: "spy"}
	o := f.observer(t, []observer.Output{{Handler: spy}})
	ctx := o.WithContext(context.Background(), map[string]string{"requestId": "r1", "category": "payments"})
	_ = o.Error(ctx, "Declined", map[string]any{"email": "a@b.co"})
	_ = o.Info(context.Background(), map[string]any{"a": 1.0})
	_ = o.CountView(ctx, "Home", observer.View{URL: "https://h.test/home?token=1", APIURL: "/v1"})
	_ = o.RecordRequest(context.Background(), observer.RequestMetric{Method: "get", URL: "/users/:id?x", DurationMs: 3, Status: 404})
	events := spy.list()
	first := events[0]
	if first.Category != "payments" || first.RequestID != "r1" || first.At != "2026-03-04T05:06:07.890Z" || fmt.Sprint(first.Data) != "map[values:[map[email:[redacted]]]]" {
		t.Fatalf("first: %+v", first)
	}
	if events[1].Message != "Application log" || events[2].Category != "analytics" || events[2].Source != "spa" || fmt.Sprint(events[2].Data) != "map[endpointPath:/v1 path:/home]" {
		t.Fatalf("helpers: %+v", events[1:3])
	}
	if events[3].Level != "warn" || events[3].Data["method"] != "GET" || events[3].Data["path"] != "/users/:id" {
		t.Fatalf("request: %+v", events[3])
	}
	if err := o.RecordRequest(context.Background(), observer.RequestMetric{Method: "GET", URL: "/", DurationMs: 1, Status: 200.5}); err != observer.ErrInvalidMetric {
		t.Fatalf("metric: %v", err)
	}
	if got := first.JSON(0); got != `{"category":"payments","id":"e1","at":"2026-03-04T05:06:07.890Z","level":"error","kind":"log","source":"app","message":"Declined","data":{"values":[{"email":"[redacted]"}]},"requestId":"r1"}` {
		t.Fatalf("JSON: %s", got)
	}
}

func TestMeasure(t *testing.T) {
	f := &fixture{now: t0}
	spy := &recorder{id: "spy"}
	o := f.observer(t, []observer.Output{{Handler: spy}})
	value, err := observer.Measure(context.Background(), o, "op", "", func(context.Context) (int, error) {
		f.advance(25 * time.Millisecond)
		return 42, nil
	})
	failure := errors.New("private")
	_, got := observer.Measure(context.Background(), o, "op", "worker", func(context.Context) (int, error) { return 0, failure })
	events := spy.list()
	if value != 42 || err != nil || got != failure || events[0].Data["durationMs"] != 25.0 || events[1].Level != "error" || events[1].Source != "worker" {
		t.Fatalf("measure: %v %v %v %+v", value, err, got, events)
	}
}

func TestSubscriptionsFiltersFailuresAndBudgets(t *testing.T) {
	f := &fixture{now: t0}
	errorsOnly, broken, hanging, pager, panicking := &recorder{id: "errors"}, &recorder{id: "broken", behavior: "fail"}, &recorder{id: "hanging", behavior: "hang"}, &recorder{id: "pager"}, &recorder{id: "panics", behavior: "panic"}
	o := f.observer(t, []observer.Output{
		{Handler: errorsOnly, Levels: []string{"error"}, Filter: func(e observer.Event) bool { return strings.Contains(e.Message, "page") }},
		{Handler: broken},
		{Handler: hanging},
		{Handler: pager, MaxPerMinute: observer.PerMinute(1)},
		{Handler: panicking, Filter: func(observer.Event) bool { panic("filter") }},
		{Handler: &recorder{id: "off"}, Disabled: true},
	}, observer.WithTimeout(30*time.Millisecond))
	_ = o.Error(context.Background(), "page me")
	_ = o.Error(context.Background(), "ignored")
	if len(errorsOnly.list()) != 1 || o.Health() != (observer.Health{Failed: 6, Dropped: 1}) {
		t.Fatalf("health %+v, events %v", o.Health(), errorsOnly.list())
	}
	f.advance(time.Minute)
	_ = o.Error(context.Background(), "next minute")
	if len(pager.list()) != 2 {
		t.Fatalf("budget: %d", len(pager.list()))
	}
	if _, err := observer.New([]observer.Output{{Handler: &recorder{id: "x"}}, {Handler: &recorder{id: "x"}}}); err != observer.ErrDuplicateOutput {
		t.Fatalf("duplicates: %v", err)
	}
}

func TestInFlightLimit(t *testing.T) {
	f := &fixture{now: t0}
	o := f.observer(t, []observer.Output{{Handler: &recorder{id: "hang", behavior: "hang"}}}, observer.WithTimeout(200*time.Millisecond))
	var start, done sync.WaitGroup
	start.Add(1)
	for range 33 {
		done.Go(func() {
			start.Wait()
			_ = o.Info(context.Background(), "x")
		})
	}
	start.Done()
	done.Wait()
	if o.Health() != (observer.Health{Failed: 32, Dropped: 1}) {
		t.Fatalf("health: %+v", o.Health())
	}
}

func TestStoreReportAndSearch(t *testing.T) {
	f := &fixture{now: t0}
	db := nosql.NewMemoryStore()
	storage := observer.NewStore(db, f.clock)
	o := f.observer(t, []observer.Output{{Handler: storage}})
	ctx := context.Background()
	_ = o.RecordRequest(ctx, observer.RequestMetric{Method: "GET", URL: "/a", DurationMs: 0.125, Status: 500})
	_ = o.RecordRequest(ctx, observer.RequestMetric{Method: "GET", URL: "/a", DurationMs: 2.375, Status: 200})
	_ = o.CountView(ctx, "Home", observer.View{URL: "/"})
	_ = o.Debug(ctx, "hidden")
	row, err := db.Get(ctx, "OBSERVER#2026-03-04", "2026-03-04T05:06:07.890Z#e1")
	if err != nil || row == nil || *row.TTL != 1_773_205_567 {
		t.Fatalf("row: %+v %v", row, err)
	}
	report, err := storage.Report(ctx, "2026-03-04")
	if err != nil || report.Counts != (observer.Counts{Requests: 2, Errors: 1, SPA: 1}) || report.AverageMs != 1 || report.RequestMetrics[0].AverageMs != 1.25 || report.Hours[5] != (observer.Hour{Hour: 5, Requests: 2, Views: 1}) {
		t.Fatalf("report: %+v %v", report, err)
	}
	page, err := storage.Search(ctx, observer.LogQuery{Day: "2026-03-04"})
	if err != nil || len(page.Events) != 3 {
		t.Fatalf("search: %+v %v", page, err)
	}
	if _, err := storage.Report(ctx, "2026-02-29"); err != observer.ErrInvalidDay {
		t.Fatalf("day: %v", err)
	}
	if _, err := observer.ParseLogQuery(map[string]any{"day": "2026-03-04", "requestId": 5.0}); err != observer.ErrInvalidFilter {
		t.Fatalf("filter: %v", err)
	}
	f.advance(7 * 24 * time.Hour)
	if report, _ := storage.Report(ctx, "2026-03-04"); len(report.Events) != 0 {
		t.Fatalf("expired rows are skipped: %d", len(report.Events))
	}
}

func TestFeatureMountingAndRateLimit(t *testing.T) {
	f := &fixture{now: t0}
	storage := observer.NewStore(nosql.NewMemoryStore(), f.clock)
	spy := &recorder{id: "spy"}
	o := f.observer(t, []observer.Output{{Handler: storage}, {Handler: spy}})
	app, err := web.New([]web.Feature{observer.Feature(o, storage, nil, f.clock)}, web.WithLocalAdmin())
	if err != nil {
		t.Fatal(err)
	}
	call := func(method, path, body, ip string) (int, string) {
		t.Helper()
		request := httptest.NewRequest(method, path, strings.NewReader(body))
		request.RemoteAddr = ip + ":1234"
		response := httptest.NewRecorder()
		app.ServeHTTP(response, request)
		return response.Code, strings.TrimSpace(response.Body.String())
	}
	if status, _ := call("GET", "/observer/report", "", "1.1.1.1"); status != 404 {
		t.Fatalf("report outside /admin/app: %d", status)
	}
	if status, body := call("GET", "/admin/app/observer/report", "", "1.1.1.1"); status != 200 || !strings.Contains(body, `"day":"2026-03-04"`) || !strings.Contains(body, `"outputs":[{"id":"store"`) {
		t.Fatalf("report: %d %s", status, body)
	}
	if status, body := call("POST", "/observer/events", `{"source":"spa","path":"//evil.test/x"}`, "1.1.1.1"); status != 400 || !strings.Contains(body, "Invalid page event") {
		t.Fatalf("protocol-relative: %d %s", status, body)
	}
	for range 60 {
		if status, _ := call("POST", "/observer/events", `{"source":"spa","path":"/"}`, "1.1.1.1"); status != 200 {
			t.Fatalf("event: %d", status)
		}
	}
	if status, _ := call("POST", "/observer/events", `{"source":"spa","path":"/"}`, "1.1.1.1"); status != 429 {
		t.Fatalf("limit: %d", status)
	}
	f.advance(time.Minute)
	if status, _ := call("POST", "/observer/events", `{"source":"ssr","path":"/a","message":"Docs"}`, "1.1.1.1"); status != 200 {
		t.Fatalf("next minute: %d", status)
	}
	if last := spy.list()[len(spy.list())-1]; last.Message != "Docs" || last.Source != "ssr" {
		t.Fatalf("view: %+v", last)
	}
	if _, ok := apperr.As(observer.ErrTooManyEvents); !ok {
		t.Fatal("rate-limit errors carry a status")
	}
}
