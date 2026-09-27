package transformers_test

import (
	"context"
	"errors"
	"slices"
	"testing"

	"rt.local/core-go/choice"
	"rt.local/core-go/choice/transformers"
)

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

func TestMapsReorderedLabelsWithoutCalibration(t *testing.T) {
	var gotText string
	var gotLabels []string
	pipeline := func(_ context.Context, text string, labels []string, options transformers.Options) (transformers.Result, error) {
		gotText, gotLabels = text, labels
		if options.MultiLabel {
			t.Error("multi_label must be false")
		}
		reversed := slices.Clone(labels)
		slices.Reverse(reversed)
		return transformers.Result{Labels: reversed, Scores: []float64{0.1, 0.9}}, nil
	}
	p, err := transformers.New(pipeline, "open-model").Predict(context.Background(), snapshot(t))
	if err != nil || p.Probabilities["billing"] != 0.9 || p.Probabilities["sales"] != 0.1 || p.Semantics != choice.UncalibratedScores {
		t.Fatalf("predict = %+v, %v", p, err)
	}
	if gotText != "Which team?\n\n\"Refund\"" || !slices.Equal(gotLabels, []string{"billing: Invoices", "sales"}) {
		t.Fatalf("pipeline got %q %q", gotText, gotLabels)
	}
	d, err := choice.New(transformers.New(pipeline, "m")).Decide(context.Background(), map[string]any{"question": "q", "options": []any{map[string]any{"id": "a"}, map[string]any{"id": "b"}}}, choice.Policy{})
	if err != nil || d.Accepted {
		t.Fatalf("uncalibrated scores must abstain: %+v %v", d, err)
	}
}

func TestInvalidResultsAndCancellation(t *testing.T) {
	for _, result := range []transformers.Result{
		{},
		{Labels: []string{"sales", "sales"}, Scores: []float64{0.5, 0.5}},
		{Labels: []string{"wrong", "sales"}, Scores: []float64{1, 0}},
		{Labels: []string{"billing: Invoices", "sales"}, Scores: []float64{1}},
	} {
		pipeline := func(context.Context, string, []string, transformers.Options) (transformers.Result, error) {
			return result, nil
		}
		if _, err := transformers.New(pipeline, "m").Predict(context.Background(), snapshot(t)); !errors.Is(err, transformers.ErrInvalidResponse) {
			t.Errorf("%+v: %v", result, err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	pipeline := func(context.Context, string, []string, transformers.Options) (transformers.Result, error) {
		cancel()
		return transformers.Result{}, nil
	}
	if _, err := transformers.New(pipeline, "m").Predict(ctx, snapshot(t)); err == nil || err.Error() != "This operation was aborted" {
		t.Fatalf("abort during inference: %v", err)
	}
	if got := transformers.Text(choice.Input{Question: "Q"}); got != "Q\n\nundefined" {
		t.Fatalf("missing context = %q", got)
	}
}
