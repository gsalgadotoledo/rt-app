// Package jev is the Choice provider for the TypeSafe Jev System One API (port of
// @gsalgadotoledo/rt-app-choice-jev; contract rt-app/spec/contracts/choice-jev.contract.yaml).
//
//	provider, err := jev.New(os.Getenv("TYPESAFE_API_KEY"))
//	provider, err := jev.New(key, jev.WithModel("jev-latest"), jev.WithTimeout(5*time.Second), jev.WithClient(client))
//
// One request per call, no implicit (billable) retries, redirects refused. Failures never echo
// the response body: "Jev request failed: HTTP <status>" or "Invalid Jev response".
package jev

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"rt.local/core-go/choice"
	"rt.local/core-go/choice/internal/jsjson"
	"rt.local/core-go/internal/js"
)

// URL is the System One endpoint.
const URL = "https://api.typesafe.ai/v1/systemone"

// Defaults of New.
const (
	DefaultModel   = "jev-latest"
	DefaultTimeout = 15 * time.Second
)

// ErrConfig is returned by New for a blank key or model or a timeout under 1 ms.
var ErrConfig = errors.New("Invalid Jev configuration") //nolint:staticcheck // text of the reference

// ErrInvalidResponse is returned for a body that is not JSON or holds no choice decision.
var ErrInvalidResponse = errors.New("Invalid Jev response") //nolint:staticcheck // text of the reference

// StatusError is a response outside 200-299; the body is never read.
type StatusError struct{ Status int }

func (e *StatusError) Error() string { return "Jev request failed: HTTP " + strconv.Itoa(e.Status) }

// Doer sends one request (*http.Client implements it). It must not follow redirects.
type Doer interface {
	Do(*http.Request) (*http.Response, error)
}

// Provider implements choice.Provider over the Jev API.
type Provider struct {
	apiKey  string
	model   string
	client  Doer
	timeout time.Duration
}

// Option configures New.
type Option func(*Provider)

// WithModel sets the model (default "jev-latest"); it must not be blank.
func WithModel(model string) Option { return func(p *Provider) { p.model = model } }

// WithTimeout sets the deadline of each request (default 15 s, at least 1 ms).
func WithTimeout(timeout time.Duration) Option { return func(p *Provider) { p.timeout = timeout } }

// WithClient replaces the HTTP client (default: one that refuses redirects).
func WithClient(client Doer) Option { return func(p *Provider) { p.client = client } }

// noRedirects is the default client: redirects are errors, like fetch's redirect: "error".
var noRedirects = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error {
	return errors.New("jev: redirects are refused")
}}

// New returns a provider; ErrConfig when the key or the model is blank (JavaScript trim) or
// the timeout is under 1 ms.
func New(apiKey string, options ...Option) (*Provider, error) {
	p := &Provider{apiKey: apiKey, model: DefaultModel, client: noRedirects, timeout: DefaultTimeout}
	for _, option := range options {
		option(p)
	}
	if js.Trim(p.apiKey) == "" || js.Trim(p.model) == "" || p.timeout < time.Millisecond || p.client == nil {
		return nil, ErrConfig
	}
	return p, nil
}

// ID is "jev".
func (p *Provider) ID() string { return "jev" }

// Body returns the request body, byte-identical to the reference: "state" is left out when
// the input has no context; criteria list array-index ids first, then the others in order.
func (p *Provider) Body(input choice.Input) string {
	criteria := make(jsjson.Pairs, len(input.Options))
	for i, o := range input.Options {
		criteria[i] = jsjson.Pair{Key: o.ID}
		if o.Description != nil {
			criteria[i].Value = *o.Description
		}
	}
	text, _ := jsjson.Stringify(criteria) // strings and nil only: cannot fail
	var b strings.Builder
	b.WriteString(`{"model":` + jsjson.Quote(p.model))
	if input.Context != nil {
		b.WriteString(`,"state":`)
		b.Write(input.Context)
	}
	b.WriteString(`,"questions":{"decision":{"type":"choice","instructions":` + jsjson.Quote(input.Question) + `,"criteria":` + text + `}}}`)
	return b.String()
}

// Predict sends one named Choice; choice.Choice validates the returned distribution. The input
// must come from choice.Validate (Choice.Decide does that).
func (p *Provider) Predict(ctx context.Context, input choice.Input) (choice.Prediction, error) {
	if err := choice.CheckAborted(ctx); err != nil {
		return choice.Prediction{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, p.timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, URL, bytes.NewBufferString(p.Body(input)))
	if err != nil {
		return choice.Prediction{}, err
	}
	req.Header.Set("Authorization", "Bearer "+p.apiKey)
	req.Header.Set("Content-Type", "application/json")
	res, err := p.client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return choice.Prediction{}, &choice.AbortError{Cause: ctx.Err()}
		}
		return choice.Prediction{}, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return choice.Prediction{}, &StatusError{Status: res.StatusCode}
	}
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		if ctx.Err() != nil {
			return choice.Prediction{}, &choice.AbortError{Cause: ctx.Err()}
		}
		return choice.Prediction{}, err
	}
	return Parse(raw)
}

// Parse maps a 2xx response body (Response.text(): a leading BOM is ignored) to a prediction.
func Parse(raw []byte) (choice.Prediction, error) {
	var data any
	if err := json.Unmarshal(bytes.TrimPrefix(raw, []byte("\xef\xbb\xbf")), &data); err != nil {
		return choice.Prediction{}, ErrInvalidResponse
	}
	body, _ := data.(map[string]any)
	answers, _ := body["answers"].(map[string]any)
	decision, _ := answers["decision"].(map[string]any)
	if kind, _ := decision["type"].(string); kind != "choice" {
		return choice.Prediction{}, ErrInvalidResponse
	}
	prediction := map[string]any{"semantics": choice.ModelProbabilities}
	for key, value := range map[string]map[string]any{"model": body, "probabilities": decision, "confidence": decision} {
		if v, present := value[key]; present {
			prediction[key] = v
		}
	}
	// The reference returns loosely typed fields and lets Choice reject them; a typed Go
	// prediction rejects them here with Choice's error.
	return choice.ParsePrediction(prediction)
}
