// Package choice makes typed decisions with explicit abstention (port of
// @gsalgadotoledo/rt-app-choice; contract rt-app/spec/contracts/choice.contract.yaml).
//
//	c := choice.New(jev.New(os.Getenv("TYPESAFE_API_KEY")))
//	d, err := c.Decide(ctx, map[string]any{"context": "Refund please", "question": "Route?",
//		"options": []any{map[string]any{"id": "billing"}, map[string]any{"id": "sales"}}}, choice.Policy{})
//
// A Provider turns a validated Input into a probability per option; Choice checks the answer and
// only accepts a clear winner. The probability is not measured accuracy: calibrate on your own
// labeled data. Inputs are decoded JSON (map[string]any), validated with JavaScript semantics:
// lengths count UTF-16 code units and blank means empty after JavaScript trim().
package choice

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"regexp"
	"sort"

	"rt.local/core-go/apperr"
	"rt.local/core-go/choice/internal/jsjson"
	"rt.local/core-go/internal/js"
	"rt.local/core-go/web"
)

// Limits of a Choice input.
const (
	MaxQuestion    = 4000   // UTF-16 code units
	MaxOptions     = 255    // options (at least 2)
	MaxDescription = 2000   // UTF-16 code units
	MaxInputBytes  = 128000 // UTF-8 bytes of the canonical JSON
)

// Semantics of a prediction's probabilities.
const (
	ModelProbabilities = "model-probabilities" // the model's own probabilities
	UncalibratedScores = "uncalibrated-scores" // scores that are not probabilities (e.g. NLI)
)

// Resource is the permission POST /choice/decide requires; ExplicitGrant means owners need it
// too. web.Endpoint has no ExplicitGrant field yet, so only the ACL of the app can enforce it.
const (
	Resource      = "choice.decide"
	ExplicitGrant = true
)

// Tool is the admin CLI/MCP metadata of POST /choice/decide.
var Tool = map[string]any{
	"name":        "choice_decide",
	"description": "Evaluate context against named options. May incur provider usage. Low-certainty decisions require review.",
	"example": map[string]any{"body": map[string]any{
		"context":  "Refund please",
		"question": "Route?",
		"options":  []any{map[string]any{"id": "billing"}, map[string]any{"id": "sales"}},
	}},
}

// ErrInvalidResponse is returned when a provider's answer is not a distribution over the options.
var ErrInvalidResponse = errors.New("Invalid choice provider response") //nolint:staticcheck // client-facing text of the reference

// AbortError is returned when ctx is done before or right after the provider call; it wraps
// ctx.Err(). Its text is the reference's DOMException message.
type AbortError struct{ Cause error }

func (e *AbortError) Error() string {
	if errors.Is(e.Cause, context.DeadlineExceeded) {
		return "The operation was aborted due to timeout"
	}
	return "This operation was aborted"
}

func (e *AbortError) Unwrap() error { return e.Cause }

// CheckAborted returns an *AbortError when ctx is done (signal.throwIfAborted()).
func CheckAborted(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return &AbortError{Cause: err}
	}
	return nil
}

// Option is one named answer; Description is nil when absent.
type Option struct {
	ID          string  `json:"id"`
	Description *string `json:"description,omitempty"`
}

// Input is a validated snapshot. Context is the JSON text of the context as JSON.stringify
// writes it (JavaScript key order), nil when the input has none.
type Input struct {
	Context  json.RawMessage `json:"context,omitempty"`
	Question string          `json:"question"`
	Options  []Option        `json:"options"`
}

// Prediction is a provider's answer; Confidence is nil when the provider gives none.
type Prediction struct {
	Probabilities map[string]float64 `json:"probabilities"`
	Confidence    *float64           `json:"confidence,omitempty"`
	Model         string             `json:"model"`
	Semantics     string             `json:"semantics"`
}

// Provider evaluates one validated Input.
type Provider interface {
	ID() string
	Predict(ctx context.Context, input Input) (Prediction, error)
}

// Policy tunes acceptance: MinProbability (default 0.8) and MinMargin (default 0.1) must be in
// [0, 1]; only AllowUncalibrated accepts uncalibrated scores.
type Policy struct {
	MinProbability    *float64
	MinMargin         *float64
	AllowUncalibrated bool
}

// Decision is the provider's answer plus the selection.
type Decision struct {
	Provider string `json:"provider"`
	Prediction
	Selected       string `json:"selected"`
	Accepted       bool   `json:"accepted"`
	RequiresReview bool   `json:"requiresReview"`
}

var optionID = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,80}$`)

func badInput() error  { return apperr.BadRequest("Invalid choice question or options") }
func badOption() error { return apperr.BadRequest("Invalid or duplicate option") }

// Validate rejects malformed input before a provider sees it (400 errors, in the reference
// order) and returns the snapshot.
func Validate(input any) (Input, error) {
	fields, _ := input.(map[string]any)
	question, ok := fields["question"].(string)
	options, isList := fields["options"].([]any)
	if !ok || js.Trim(question) == "" || js.Len(question) > MaxQuestion || !isList || len(options) < 2 || len(options) > MaxOptions {
		return Input{}, badInput()
	}
	snapshot := Input{Question: question, Options: make([]Option, len(options))}
	seen := make(map[string]bool, len(options))
	for i, item := range options {
		option, ok := item.(map[string]any)
		if !ok {
			return Input{}, badOption()
		}
		id, ok := option["id"].(string)
		if !ok || !optionID.MatchString(id) {
			return Input{}, badOption()
		}
		snapshot.Options[i].ID = id
		if raw, present := option["description"]; present { // null counts as present
			description, ok := raw.(string)
			if !ok || js.Len(description) > MaxDescription {
				return Input{}, badOption()
			}
			snapshot.Options[i].Description = &description
		}
		seen[id] = true
	}
	if len(seen) != len(options) {
		return Input{}, badOption()
	}
	canonical, err := jsjson.Canonical(input)
	if err != nil {
		return Input{}, err
	}
	if len(canonical) > MaxInputBytes {
		return Input{}, apperr.BadRequest("Choice input too large")
	}
	if raw, present := fields["context"]; present {
		text, err := jsjson.Stringify(raw)
		if err != nil {
			return Input{}, err
		}
		snapshot.Context = json.RawMessage(text)
	}
	return snapshot, nil
}

// ParsePrediction reads a provider answer decoded from JSON: probabilities is an object (or an
// array, read by index like JavaScript) of numbers, model and semantics are strings and
// confidence, when present, a number (null is invalid). Anything else is ErrInvalidResponse.
func ParsePrediction(value any) (Prediction, error) {
	fields, ok := value.(map[string]any)
	if !ok {
		return Prediction{}, ErrInvalidResponse
	}
	var p Prediction
	switch probabilities := fields["probabilities"].(type) {
	case map[string]any:
		p.Probabilities = make(map[string]float64, len(probabilities))
		for k, v := range probabilities {
			n, ok := v.(float64)
			if !ok {
				return Prediction{}, ErrInvalidResponse
			}
			p.Probabilities[k] = n
		}
	case []any:
		p.Probabilities = make(map[string]float64, len(probabilities))
		for i, v := range probabilities {
			n, ok := v.(float64)
			if !ok {
				return Prediction{}, ErrInvalidResponse
			}
			p.Probabilities[js.FormatNumber(float64(i))] = n
		}
	default:
		return Prediction{}, ErrInvalidResponse
	}
	if p.Model, ok = fields["model"].(string); !ok {
		return Prediction{}, ErrInvalidResponse
	}
	if p.Semantics, ok = fields["semantics"].(string); !ok {
		return Prediction{}, ErrInvalidResponse
	}
	if raw, present := fields["confidence"]; present {
		n, ok := raw.(float64)
		if !ok {
			return Prediction{}, ErrInvalidResponse
		}
		p.Confidence = &n
	}
	return p, nil
}

func unit(n float64) bool { return !math.IsNaN(n) && !math.IsInf(n, 0) && n >= 0 && n <= 1 }

// check validates a prediction against the option ids (in option order).
func check(p Prediction, keys []string) error {
	if len(p.Probabilities) != len(keys) {
		return ErrInvalidResponse
	}
	sum := 0.0
	for _, k := range keys {
		n, ok := p.Probabilities[k]
		if !ok || !unit(n) {
			return ErrInvalidResponse
		}
		sum += n
	}
	if math.Abs(sum-1) > 0.001 || p.Model == "" || (p.Semantics != ModelProbabilities && p.Semantics != UncalibratedScores) {
		return ErrInvalidResponse
	}
	if p.Confidence != nil && !unit(*p.Confidence) {
		return ErrInvalidResponse
	}
	return nil
}

// Choice decides with one provider. It is safe for concurrent use if the provider is.
type Choice struct {
	provider Provider
}

// New returns a Choice over provider.
func New(provider Provider) *Choice { return &Choice{provider: provider} }

// Decide validates the input and the policy, asks the provider and accepts only a clear,
// calibrated winner. Provider errors are returned unchanged; ctx cancellation before or right
// after the call returns an *AbortError.
func (c *Choice) Decide(ctx context.Context, input any, policy Policy) (Decision, error) {
	snapshot, err := Validate(input)
	if err != nil {
		return Decision{}, err
	}
	minimum, margin := 0.8, 0.1
	if policy.MinProbability != nil {
		minimum = *policy.MinProbability
	}
	if policy.MinMargin != nil {
		margin = *policy.MinMargin
	}
	if !unit(minimum) || !unit(margin) {
		return Decision{}, apperr.BadRequest("Invalid choice policy")
	}
	if err := CheckAborted(ctx); err != nil {
		return Decision{}, err
	}
	p, err := c.provider.Predict(ctx, snapshot)
	if err != nil {
		return Decision{}, err
	}
	if err := CheckAborted(ctx); err != nil {
		return Decision{}, err
	}
	keys := make([]string, len(snapshot.Options))
	for i, o := range snapshot.Options {
		keys[i] = o.ID
	}
	if err := check(p, keys); err != nil {
		return Decision{}, err
	}
	ranked := append([]string(nil), keys...)
	sort.SliceStable(ranked, func(i, j int) bool { return p.Probabilities[ranked[i]] > p.Probabilities[ranked[j]] })
	top, second := p.Probabilities[ranked[0]], p.Probabilities[ranked[1]]
	accepted := top >= minimum && top-second >= margin && top > second &&
		(p.Semantics != UncalibratedScores || policy.AllowUncalibrated)
	result := p
	result.Probabilities = make(map[string]float64, len(p.Probabilities))
	for k, v := range p.Probabilities {
		result.Probabilities[k] = v
	}
	if p.Confidence != nil {
		confidence := *p.Confidence
		result.Confidence = &confidence
	}
	return Decision{Provider: c.provider.ID(), Prediction: result, Selected: ranked[0], Accepted: accepted, RequiresReview: !accepted}, nil
}

// Feature exposes POST /choice/decide (permission Resource; the reference also requires an
// explicit grant, see ExplicitGrant) deciding the request body with the default policy.
func (c *Choice) Feature() web.Feature {
	return web.Feature{ID: "choice", Endpoints: []web.Endpoint{{
		Method:   "POST",
		Path:     "/choice/decide",
		Access:   web.Permission,
		Resource: Resource,
		Handle: func(ctx *web.Context) (any, error) {
			return c.Decide(ctx.Ctx, ctx.Request.Body, Policy{})
		},
	}}}
}
