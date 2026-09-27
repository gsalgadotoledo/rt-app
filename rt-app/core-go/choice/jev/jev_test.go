package jev_test

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"rt.local/core-go/choice"
	"rt.local/core-go/choice/jev"
)

type doer func(*http.Request) (*http.Response, error)

func (d doer) Do(r *http.Request) (*http.Response, error) { return d(r) }

func reply(status int, body string) doer {
	return func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: http.Header{}}, nil
	}
}

func snapshot(t *testing.T) choice.Input {
	t.Helper()
	input, err := choice.Validate(map[string]any{
		"context":  "Refund",
		"question": "Which team?",
		"options":  []any{map[string]any{"id": "billing", "description": "Invoices"}, map[string]any{"id": "sales"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	return input
}

func TestEnvelopeAndMapping(t *testing.T) {
	var sent *http.Request
	var body []byte
	client := doer(func(r *http.Request) (*http.Response, error) {
		sent, body = r, must(io.ReadAll(r.Body))
		return reply(200, `{"model":"jev-test","answers":{"decision":{"type":"choice","probabilities":{"billing":1,"sales":0},"confidence":1}}}`)(r)
	})
	provider, err := jev.New("key", jev.WithModel("m"), jev.WithClient(client))
	if err != nil {
		t.Fatal(err)
	}
	p, err := provider.Predict(context.Background(), snapshot(t))
	if err != nil || p.Model != "jev-test" || p.Probabilities["billing"] != 1 || *p.Confidence != 1 || p.Semantics != choice.ModelProbabilities {
		t.Fatalf("predict = %+v, %v", p, err)
	}
	if sent.URL.String() != jev.URL || sent.Method != "POST" || sent.Header.Get("Authorization") != "Bearer key" {
		t.Fatalf("request = %v %v %v", sent.Method, sent.URL, sent.Header)
	}
	want := `{"model":"m","state":"Refund","questions":{"decision":{"type":"choice","instructions":"Which team?","criteria":{"billing":"Invoices","sales":null}}}}`
	if string(body) != want {
		t.Fatalf("body = %s", body)
	}
	for _, options := range [][]jev.Option{{jev.WithModel(" ")}, {jev.WithTimeout(time.Microsecond)}} {
		if _, err := jev.New("key", options...); !errors.Is(err, jev.ErrConfig) {
			t.Errorf("config: %v", err)
		}
	}
	if _, err := jev.New(" \t"); !errors.Is(err, jev.ErrConfig) || err.Error() != "Invalid Jev configuration" {
		t.Errorf("blank key: %v", err)
	}
}

func TestPrivateFailures(t *testing.T) {
	for _, c := range []struct {
		status  int
		body    string
		message string
	}{
		{429, "secret", "Jev request failed: HTTP 429"},
		{200, "secret", "Invalid Jev response"},
		{200, "null", "Invalid Jev response"},
		{200, `{"answers":{"decision":{"type":"score"}}}`, "Invalid Jev response"},
		{200, `{"model":"m","answers":{"decision":{"type":"choice","probabilities":{"a":"1"}}}}`, "Invalid choice provider response"},
	} {
		provider, _ := jev.New("key", jev.WithClient(reply(c.status, c.body)))
		if _, err := provider.Predict(context.Background(), snapshot(t)); err == nil || err.Error() != c.message {
			t.Errorf("%d %s: %v", c.status, c.body, err)
		}
	}
	provider, _ := jev.New("key", jev.WithClient(reply(200, "\ufeff"+`{"model":"m","answers":{"decision":{"type":"choice","probabilities":{"billing":1,"sales":0}}}}`)))
	if _, err := provider.Predict(context.Background(), snapshot(t)); err != nil {
		t.Errorf("a BOM is ignored like Response.text(): %v", err)
	}
}

func TestDefaultClientRefusesRedirectsAndTimesOut(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/slow" {
			time.Sleep(200 * time.Millisecond)
		}
		http.Redirect(w, r, "/elsewhere", http.StatusFound)
	}))
	defer server.Close()
	// Route the fixed Jev URL to the test server.
	rewrite := doer(func(r *http.Request) (*http.Response, error) {
		target := server.URL + map[bool]string{true: "/slow", false: "/"}[r.Header.Get("X-Slow") != ""]
		out, _ := http.NewRequestWithContext(r.Context(), r.Method, target, bytes.NewReader(must(io.ReadAll(r.Body))))
		client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("jev: redirects are refused") }}
		return client.Do(out)
	})
	provider, _ := jev.New("key", jev.WithClient(rewrite))
	if _, err := provider.Predict(context.Background(), snapshot(t)); err == nil || !strings.Contains(err.Error(), "redirects are refused") {
		t.Fatalf("redirect: %v", err)
	}
	slow := doer(func(r *http.Request) (*http.Response, error) {
		r.Header.Set("X-Slow", "1")
		return rewrite(r)
	})
	provider, _ = jev.New("key", jev.WithClient(slow), jev.WithTimeout(20*time.Millisecond))
	var aborted *choice.AbortError
	if _, err := provider.Predict(context.Background(), snapshot(t)); !errors.As(err, &aborted) || err.Error() != "The operation was aborted due to timeout" {
		t.Fatalf("timeout: %v", err)
	}
}

func must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}
