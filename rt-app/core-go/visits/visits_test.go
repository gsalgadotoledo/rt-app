package visits

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"rt.local/core-go/nosql"
	"rt.local/core-go/web"
)

const (
	secret  = "visits-contract-secret-0123456789"
	t0      = int64(1_893_456_000_000)
	firstID = "00000000-0000-4000-8000-000000000001"
	// Issued by the TypeScript reference (spec/contracts/visits.contract.yaml).
	tsToken = "eyJpZCI6IjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMSIsInN0YXJ0ZWRBdCI6MTg5MzQ1NjAwMDAwMH0.PfLXHltgXNxsnYwLyX4alqkZ7PY2HR4GaG8zdsHjc-U"
)

var point = map[string]any{"type": "click", "path": "/", "t": 5.0, "x": 20.0, "y": 30.0}

type fixture struct {
	now   int64
	store *nosql.MemoryStore
	v     *Visits
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	f := &fixture{now: t0, store: nosql.NewMemoryStore()}
	next := 0
	v, err := New(f.store, secret, WithClock(func() time.Time { return time.UnixMilli(f.now) }), WithIDs(func() string {
		next++
		return fmt.Sprintf("00000000-0000-4000-8000-%012d", next)
	}))
	if err != nil {
		t.Fatal(err)
	}
	f.v = v
	return f
}

func (f *fixture) start(t *testing.T, ip string) string {
	t.Helper()
	started, err := f.v.Start(context.Background(), ip)
	if err != nil {
		t.Fatal(err)
	}
	return started.Token
}

func batch(token string, sequence float64, points ...any) map[string]any {
	return map[string]any{"token": token, "sequence": sequence, "points": points}
}

func TestTokensMatchTheTypeScriptReference(t *testing.T) {
	if token := newFixture(t).start(t, "ip"); token != tsToken {
		t.Fatalf("token = %s", token)
	}
}

func TestIngestListDetailRemove(t *testing.T) {
	f, ctx := newFixture(t), context.Background()
	token := f.start(t, "ip")
	f.now += 1234
	extra := map[string]any{"type": "click", "path": "/", "t": 5.0, "x": 20.0, "y": 30.0, "text": "secret"}
	if r, err := f.v.Ingest(ctx, batch(token, 1, extra, point), "ip"); err != nil || !r.Recorded {
		t.Fatalf("ingest = %+v %v", r, err)
	}
	if r, err := f.v.Ingest(ctx, batch(token, 1, point), "ip"); err != nil || r.Recorded {
		t.Fatalf("replay = %+v %v", r, err)
	}
	list, _ := f.v.List(ctx)
	want := Summary{ID: firstID, StartedAt: t0, UpdatedAt: t0 + 1234, Sequence: 1, Events: 2, Pages: []string{"/"}}
	if len(list.Items) != 1 || fmt.Sprint(list.Items[0]) != fmt.Sprint(want) || list.Limit != 10 || list.MaxPoints != 120 {
		t.Fatalf("list = %+v", list)
	}
	row, _ := f.store.Get(ctx, Partition, SortKey)
	if row.Version != 2 || *row.TTL != 1_893_542_402 {
		t.Fatalf("row = %+v", row)
	}
	if s, err := f.v.Detail(ctx, firstID); err != nil || len(s.Points) != 2 || s.Points[0] != (Point{"click", "/", 5, 20, 30}) {
		t.Fatalf("detail = %+v %v", s, err)
	}
	if _, err := f.v.Remove(ctx, firstID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.v.Detail(ctx, firstID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v", err)
	}
}

func TestKeepsTenNewestSessionsAndMaxPoints(t *testing.T) {
	f, ctx := newFixture(t), context.Background()
	var tokens []string
	for i := range 11 {
		f.now++
		tokens = append(tokens, f.start(t, fmt.Sprint("ip", i)))
		if _, err := f.v.Ingest(ctx, batch(tokens[i], 1, point), fmt.Sprint("ip", i)); err != nil {
			t.Fatal(err)
		}
	}
	list, _ := f.v.List(ctx)
	if len(list.Items) != 10 || list.Items[0].StartedAt != t0+11 || list.Items[9].StartedAt != t0+2 {
		t.Fatalf("list = %+v", list.Items)
	}
	if r, _ := f.v.Ingest(ctx, batch(tokens[0], 2, point), "x"); r.Recorded {
		t.Fatal("the oldest session was recorded")
	}
	twenty := make([]any, 20)
	for i := range twenty {
		twenty[i] = point
	}
	for sequence := 2.0; sequence < 10; sequence++ {
		if _, err := f.v.Ingest(ctx, batch(tokens[10], sequence, twenty...), "y"); err != nil {
			t.Fatal(err)
		}
	}
	if s, _ := f.v.Detail(ctx, "00000000-0000-4000-8000-000000000011"); len(s.Points) != MaxPoints {
		t.Fatalf("points = %d", len(s.Points))
	}
}

func TestValidation(t *testing.T) {
	f, ctx := newFixture(t), context.Background()
	token := f.start(t, "ip")
	with := func(key string, value any) map[string]any {
		b := batch(token, 1, point)
		b[key] = value
		return b
	}
	for _, b := range []map[string]any{with("sequence", 0.0), with("sequence", true), with("sequence", 1.5), with("points", []any{}), with("points", "x")} {
		if _, err := f.v.Ingest(ctx, b, "ip"); !errors.Is(err, ErrInvalidBatch) {
			t.Errorf("%v: err = %v", b, err)
		}
	}
	for _, p := range []any{nil, "x", map[string]any{"type": "hover", "path": "/", "t": 0.0, "x": 0.0, "y": 0.0},
		map[string]any{"type": "click", "path": "/x", "t": 0.0, "x": 0.0, "y": 0.0}, map[string]any{"type": "click", "path": "/", "t": 0.0, "x": 101.0, "y": 0.0},
		map[string]any{"type": "click", "path": "/", "t": 0.0, "x": 1.5, "y": 0.0}, map[string]any{"type": "click", "path": "/", "t": 1_800_001.0, "x": 0.0, "y": 0.0}} {
		if _, err := f.v.Ingest(ctx, batch(token, 1, p), "ip"); !errors.Is(err, ErrInvalidPoint) {
			t.Errorf("%v: err = %v", p, err)
		}
	}
	for _, bad := range []any{nil, "x", token + "x", token + ".x", strings.Repeat("a", 501)} {
		if _, err := f.v.Ingest(ctx, with("token", bad), "ip"); !errors.Is(err, ErrInvalidToken) {
			t.Errorf("%v: err = %v", bad, err)
		}
	}
	f.now += 1_800_001
	if _, err := f.v.Ingest(ctx, batch(token, 1, point), "ip2"); !errors.Is(err, ErrExpiredToken) {
		t.Errorf("err = %v", err)
	}
	if row, _ := f.store.Get(ctx, Partition, SortKey); row != nil {
		t.Errorf("row = %+v", row)
	}
}

func TestLenientBase64AndSignedPayloads(t *testing.T) {
	f, ctx := newFixture(t), context.Background()
	payload := "eyJpZCI6ImYiLCJzdGFydGVkQXQiOjE4OTM0NTYwMDAwMDAuMH0==" // {"id":"f","startedAt":1893456000000.0}
	if _, err := f.v.Ingest(ctx, batch(f.v.Sign(payload), 1, point), "ip"); err != nil {
		t.Fatal(err)
	}
	if s, err := f.v.Detail(ctx, "f"); err != nil || s.StartedAt != t0 {
		t.Fatalf("detail = %+v %v", s, err)
	}
	if _, err := f.v.Ingest(ctx, batch(f.v.Sign("bm90IGpzb24"), 1, point), "ip"); !errors.Is(err, ErrExpiredToken) {
		t.Fatalf("err = %v", err)
	}
}

func TestSessionsExpireAfterADay(t *testing.T) {
	f, ctx := newFixture(t), context.Background()
	token := f.start(t, "ip")
	_, _ = f.v.Ingest(ctx, batch(token, 1, point), "ip")
	f.now += maxAge
	if list, _ := f.v.List(ctx); len(list.Items) != 0 {
		t.Fatalf("list = %+v", list)
	}
	if row, _ := f.store.Get(ctx, Partition, SortKey); row.Version != 2 {
		t.Fatalf("row = %+v", row)
	}
}

func TestRateLimits(t *testing.T) {
	f, ctx := newFixture(t), context.Background()
	for range 60 {
		f.start(t, "a")
	}
	if _, err := f.v.Start(ctx, "a"); !errors.Is(err, ErrRateLimit) {
		t.Fatalf("err = %v", err)
	}
	f.now += rateWindow
	f.start(t, "a")
	for i := range 1999 {
		f.start(t, fmt.Sprint("c", i))
	}
	if _, err := f.v.Start(ctx, "new"); !errors.Is(err, ErrBusy) {
		t.Fatalf("err = %v", err)
	}
}

func TestConfiguration(t *testing.T) {
	store := nosql.NewMemoryStore()
	if _, err := New(store, strings.Repeat("s", 31)); !errors.Is(err, ErrShortSecret) {
		t.Error(err)
	}
	if _, err := New(store, strings.Repeat("🔑", 16)); err != nil {
		t.Error(err)
	}
	for _, pages := range [][]string{{"about"}, {"/a\n"}, {"/café"}, {strings.Repeat("/", 81)}, make([]string, 31)} {
		if _, err := New(store, secret, WithPages(pages)); !errors.Is(err, ErrInvalidPages) {
			t.Errorf("%q: err = %v", pages, err)
		}
	}
}

func TestEndpoints(t *testing.T) {
	f := newFixture(t)
	app, err := web.New([]web.Feature{f.v.Feature()}, web.WithLocalAdmin())
	if err != nil {
		t.Fatal(err)
	}
	do := func(method, path, body string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		app.ServeHTTP(rec, httptest.NewRequest(method, path, strings.NewReader(body)))
		return rec
	}
	started := do("POST", "/visits/start", "")
	token := strings.Split(strings.Split(started.Body.String(), `"token":"`)[1], `"`)[0]
	if rec := do("POST", "/visits/events", `{"token":"`+token+`","sequence":1,"points":[{"type":"page","path":"/","t":0,"x":0,"y":0}]}`); rec.Body.String() != `{"ok":true,"recorded":true}` {
		t.Fatalf("events = %d %s", rec.Code, rec.Body)
	}
	for path, want := range map[string]int{"/visits": http.StatusNotFound, "/admin/app/visits": 200, "/admin/app/visits/" + firstID: 200, "/admin/app/visits/missing": 404} {
		if rec := do("GET", path, ""); rec.Code != want {
			t.Errorf("GET %s = %d %s", path, rec.Code, rec.Body)
		}
	}
	if rec := do("DELETE", "/admin/app/visits/"+firstID, ""); rec.Body.String() != `{"ok":true}` {
		t.Errorf("delete = %s", rec.Body)
	}
}
