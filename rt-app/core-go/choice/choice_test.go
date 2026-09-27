package choice_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"rt.local/core-go/apperr"
	"rt.local/core-go/choice"
)

type fake struct {
	prediction choice.Prediction
	err        error
	hook       func()
	calls      []choice.Input
}

func (f *fake) ID() string { return "fake" }

func (f *fake) Predict(_ context.Context, input choice.Input) (choice.Prediction, error) {
	f.calls = append(f.calls, input)
	if f.hook != nil {
		f.hook()
	}
	return f.prediction, f.err
}

func ptr(f float64) *float64 { return &f }

func input() map[string]any {
	return map[string]any{
		"context":  "Refund",
		"question": "Which team?",
		"options":  []any{map[string]any{"id": "billing", "description": "Invoices"}, map[string]any{"id": "sales"}},
	}
}

func calibrated() choice.Prediction {
	return choice.Prediction{Probabilities: map[string]float64{"billing": 0.9, "sales": 0.1}, Model: "test", Semantics: choice.ModelProbabilities, Confidence: ptr(0.7)}
}

func TestDecideAcceptsAndAbstains(t *testing.T) {
	ctx := context.Background()
	d, err := choice.New(&fake{prediction: calibrated()}).Decide(ctx, input(), choice.Policy{})
	if err != nil || d.Selected != "billing" || !d.Accepted || d.RequiresReview || *d.Confidence != 0.7 || d.Provider != "fake" {
		t.Fatalf("decide = %+v, %v", d, err)
	}
	if d, _ := choice.New(&fake{prediction: calibrated()}).Decide(ctx, input(), choice.Policy{MinProbability: ptr(0.99)}); d.Accepted {
		t.Fatal("minProbability 0.99 must abstain")
	}
	uncalibrated := calibrated()
	uncalibrated.Semantics = choice.UncalibratedScores
	if d, _ := choice.New(&fake{prediction: uncalibrated}).Decide(ctx, input(), choice.Policy{}); d.Accepted {
		t.Fatal("uncalibrated scores must abstain by default")
	}
	if d, _ := choice.New(&fake{prediction: uncalibrated}).Decide(ctx, input(), choice.Policy{AllowUncalibrated: true}); !d.Accepted {
		t.Fatal("allowUncalibrated must accept")
	}
	three := map[string]any{"question": "q", "options": []any{map[string]any{"id": "a"}, map[string]any{"id": "b"}, map[string]any{"id": "c"}}}
	margin := choice.Prediction{Probabilities: map[string]float64{"a": 0.5, "b": 0.4, "c": 0.1}, Model: "m", Semantics: choice.ModelProbabilities}
	if d, _ := choice.New(&fake{prediction: margin}).Decide(ctx, three, choice.Policy{MinProbability: ptr(0.5)}); d.Accepted {
		t.Fatal("0.5 - 0.4 < 0.1 in float64")
	}
	tie := choice.Prediction{Probabilities: map[string]float64{"billing": 0.5, "sales": 0.5}, Model: "m", Semantics: choice.ModelProbabilities}
	if d, _ := choice.New(&fake{prediction: tie}).Decide(ctx, input(), choice.Policy{MinProbability: ptr(0), MinMargin: ptr(0)}); d.Accepted || d.Selected != "billing" {
		t.Fatalf("tie = %+v", d)
	}
}

func TestValidate(t *testing.T) {
	cases := map[string]struct {
		input   any
		message string
	}{
		"nil":             {nil, "Invalid choice question or options"},
		"blank":           {map[string]any{"question": "\u00a0\ufeff", "options": []any{}}, "Invalid choice question or options"},
		"long":            {map[string]any{"question": strings.Repeat("😀", 2001), "options": []any{map[string]any{"id": "a"}, map[string]any{"id": "b"}}}, "Invalid choice question or options"},
		"duplicate":       {map[string]any{"question": "q", "options": []any{map[string]any{"id": "a"}, map[string]any{"id": "a"}}}, "Invalid or duplicate option"},
		"newline":         {map[string]any{"question": "q", "options": []any{map[string]any{"id": "a\n"}, map[string]any{"id": "b"}}}, "Invalid or duplicate option"},
		"null desc":       {map[string]any{"question": "q", "options": []any{map[string]any{"id": "a", "description": nil}, map[string]any{"id": "b"}}}, "Invalid or duplicate option"},
		"too large bytes": {map[string]any{"question": "q", "context": strings.Repeat("é", 63969), "options": []any{map[string]any{"id": "a"}, map[string]any{"id": "b"}}}, "Choice input too large"},
	}
	for name, c := range cases {
		_, err := choice.Validate(c.input)
		if e, ok := apperr.As(err); !ok || e.Status != 400 || e.Message != c.message {
			t.Errorf("%s: %v", name, err)
		}
	}
	snapshot, err := choice.Validate(map[string]any{"question": "q", "context": map[string]any{"b": 1.0, "10": 2.0, "2": []any{1e21, "\u2028"}}, "options": []any{map[string]any{"id": "a"}, map[string]any{"id": "b"}}})
	if err != nil || string(snapshot.Context) != "{\"2\":[1e+21,\"\u2028\"],\"10\":2,\"b\":1}" {
		t.Fatalf("snapshot = %s, %v", snapshot.Context, err)
	}
}

func TestInvalidAnswersPolicyAndCancellation(t *testing.T) {
	ctx := context.Background()
	for _, p := range []choice.Prediction{
		{Probabilities: map[string]float64{"billing": 0.5, "sales": 0.2}, Model: "m", Semantics: choice.ModelProbabilities},
		{Probabilities: map[string]float64{"billing": 1, "other": 0}, Model: "m", Semantics: choice.ModelProbabilities},
		{Probabilities: map[string]float64{"billing": 1, "sales": 0}, Model: "", Semantics: choice.ModelProbabilities},
		{Probabilities: map[string]float64{"billing": 1, "sales": 0}, Model: "m", Semantics: "fake"},
		{Probabilities: map[string]float64{"billing": 1, "sales": 0}, Model: "m", Semantics: choice.ModelProbabilities, Confidence: ptr(2)},
	} {
		if _, err := choice.New(&fake{prediction: p}).Decide(ctx, input(), choice.Policy{}); !errors.Is(err, choice.ErrInvalidResponse) {
			t.Errorf("%+v: %v", p, err)
		}
	}
	f := &fake{prediction: calibrated()}
	if _, err := choice.New(f).Decide(ctx, input(), choice.Policy{MinMargin: ptr(-1)}); err == nil || err.Error() != "Invalid choice policy" || len(f.calls) != 0 {
		t.Fatalf("policy: %v", err)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := choice.New(f).Decide(cancelled, input(), choice.Policy{}); err == nil || err.Error() != "This operation was aborted" || !errors.Is(err, context.Canceled) {
		t.Fatalf("before: %v", err)
	}
	during, stop := context.WithCancel(ctx)
	defer stop()
	if _, err := choice.New(&fake{prediction: calibrated(), hook: stop}).Decide(during, input(), choice.Policy{}); err == nil || err.Error() != "This operation was aborted" {
		t.Fatalf("during: %v", err)
	}
	boom := errors.New("provider down")
	if _, err := choice.New(&fake{err: boom}).Decide(ctx, input(), choice.Policy{}); err != boom {
		t.Fatalf("provider errors propagate: %v", err)
	}
}

func TestParsePrediction(t *testing.T) {
	p, err := choice.ParsePrediction(map[string]any{"probabilities": []any{0.25, 0.75}, "model": "m", "semantics": "model-probabilities"})
	if err != nil || p.Probabilities["1"] != 0.75 || p.Confidence != nil {
		t.Fatalf("array = %+v, %v", p, err)
	}
	for _, bad := range []any{nil, "x", map[string]any{"probabilities": map[string]any{"a": "1"}, "model": "m", "semantics": "s"},
		map[string]any{"probabilities": map[string]any{}, "model": "m", "semantics": "s", "confidence": nil}} {
		if _, err := choice.ParsePrediction(bad); !errors.Is(err, choice.ErrInvalidResponse) {
			t.Errorf("%v: %v", bad, err)
		}
	}
}

func TestFeature(t *testing.T) {
	f := choice.New(&fake{prediction: calibrated()}).Feature()
	if f.ID != "choice" || f.Endpoints[0].Path != "/choice/decide" || f.Endpoints[0].Resource != "choice.decide" || f.Endpoints[0].Access != "permission" {
		t.Fatalf("feature = %+v", f)
	}
}
