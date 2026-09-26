package conformance

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"rt.local/core-go/apperr"
)

func TestWireValues(t *testing.T) {
	when := time.Date(2026, 1, 2, 3, 4, 5, 678_000_000, time.UTC)
	encoded, err := json.Marshal(Encode(map[string]any{
		"when": when, "raw": []byte("hi"), "big": big.NewInt(1 << 62), "list": []any{when}, "n": 1.5, "nil": nil,
	}))
	if err != nil {
		t.Fatal(err)
	}
	want := `{"big":{"$bigint":"4611686018427387904"},"list":[{"$date":"2026-01-02T03:04:05.678Z"}],"n":1.5,"nil":null,"raw":{"$bytes":"aGk="},"when":{"$date":"2026-01-02T03:04:05.678Z"}}`
	if string(encoded) != want {
		t.Fatalf("encode\n got %s\nwant %s", encoded, want)
	}
	decoded, err := Decode(encoded)
	if err != nil {
		t.Fatal(err)
	}
	m := decoded.(map[string]any)
	if !m["when"].(time.Time).Equal(when) || string(m["raw"].([]byte)) != "hi" || m["big"].(*big.Int).Int64() != 1<<62 || m["n"].(float64) != 1.5 {
		t.Fatalf("decode: %#v", m)
	}
	// Tags only apply to single-key objects.
	plain, _ := Decode(json.RawMessage(`{"$date":"x","other":1}`))
	if _, ok := plain.(map[string]any)["$date"].(string); !ok {
		t.Fatalf("two-key object was untagged: %#v", plain)
	}
}

type closer struct{ closed bool }

func testHost(c *closer) *Host {
	return NewHost("go", map[string]Subject{
		"counter": func(_ context.Context, init json.RawMessage) (Instance, error) {
			var config struct{ Start *int }
			if err := json.Unmarshal(init, &config); err != nil {
				return Instance{}, err
			}
			if config.Start == nil {
				return Instance{}, errors.New("start is required")
			}
			n := *config.Start
			return Instance{
				Methods: map[string]Method{
					"add": func(_ context.Context, args []json.RawMessage) (any, error) {
						var d int
						if len(args) == 0 || json.Unmarshal(args[0], &d) != nil {
							return nil, apperr.BadRequest("Invalid amount")
						}
						n += d
						return n, nil
					},
					"_secret": func(context.Context, []json.RawMessage) (any, error) { return "no", nil },
				},
				Close: func() error { c.closed = true; return nil },
			}, nil
		},
	})
}

func request(t *testing.T, h http.Handler, method, path, body string, header ...string) (int, string) {
	t.Helper()
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	if len(header) == 2 {
		r.Header.Set(header[0], header[1])
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w.Code, w.Body.String()
}

func TestHostProtocol(t *testing.T) {
	c := &closer{}
	h := testHost(c)
	steps := []struct {
		method, path, body string
		status             int
		want               string
	}{
		{"GET", Base, "", 200, `"language":"go","protocol":1`},
		{"POST", Base + "/instances", `{"subject":"nope"}`, 404, `{"protocolError":"Unknown subject: nope"}`},
		{"POST", Base + "/instances", `{"subject":"counter"}`, 200, `{"error":{"type":"errorString","message":"start is required"},"ok":false}`},
		{"POST", Base + "/instances", `{"subject":"counter","init":{"start":1}}`, 200, `{"id":"1","ok":true}`},
		{"POST", Base + "/instances/1/add", `{"args":[2]}`, 200, `{"ok":true,"value":3}`},
		{"POST", Base + "/instances/1/add", `{"args":["x"]}`, 200, `{"error":{"type":"HTTPError","status":400,"message":"Invalid amount"},"ok":false}`},
		{"POST", Base + "/instances/1/add", `{"args":{}}`, 400, `{"protocolError":"args must be a list"}`},
		{"POST", Base + "/instances/1/_secret", `{}`, 404, `{"protocolError":"Unknown method: _secret"}`},
		{"POST", Base + "/instances/1/missing", `{}`, 404, `{"protocolError":"Unknown method: missing"}`},
		{"POST", Base + "/instances/9/add", `{}`, 404, `{"protocolError":"Unknown instance: 9"}`},
		{"POST", Base + "/instances", `{bad`, 400, `{"protocolError":"Invalid JSON"}`},
		{"GET", "/elsewhere", "", 404, `{"protocolError":"Not a contract host path"}`},
		{"DELETE", Base + "/instances/1", "", 200, `{"ok":true}`},
		{"POST", Base + "/instances/1/add", `{"args":[1]}`, 404, `{"protocolError":"Unknown instance: 1"}`},
	}
	for _, s := range steps {
		status, body := request(t, h, s.method, s.path, s.body)
		if status != s.status || !strings.Contains(body, s.want) {
			t.Errorf("%s %s %s: got %d %s", s.method, s.path, s.body, status, body)
		}
	}
	if !c.closed {
		t.Error("DELETE did not close the instance")
	}
	if status, body := request(t, h, "GET", Base, "", "Origin", "http://evil.test"); status != 403 || !strings.Contains(body, "protocolError") {
		t.Errorf("Origin: got %d %s", status, body)
	}
}

func TestRunAnnouncesReadiness(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	out := &syncBuffer{ready: make(chan struct{})}
	done := make(chan error, 1)
	go func() { done <- Run(ctx, testHost(&closer{}), out) }()
	<-out.ready
	line := strings.TrimSpace(out.String())
	url, ok := strings.CutPrefix(line, Ready+" ")
	if !ok || !strings.HasPrefix(url, "http://127.0.0.1:") || !strings.HasSuffix(url, Base) {
		t.Fatalf("ready line %q", line)
	}
	res, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if !bytes.Contains(body, []byte(`"subjects":["counter"]`)) {
		t.Fatalf("info: %s", body)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

type syncBuffer struct {
	bytes.Buffer
	ready chan struct{}
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	n, err := b.Buffer.Write(p)
	close(b.ready)
	return n, err
}
