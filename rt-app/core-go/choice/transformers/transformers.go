// Package transformers is the Choice provider over an injected zero-shot classifier (port of
// @gsalgadotoledo/rt-app-choice-transformers; contract
// rt-app/spec/contracts/choice-transformers.contract.yaml).
//
// Go has no Transformers runtime: inject a ZeroShot function backed by whatever serves the model
// (an inference server, ONNX Runtime bindings…). It receives the text, one label per option and
// MultiLabel false, and returns the labels (any order) with their scores. NLI label scores are
// uncalibrated, so choice.Choice abstains by default even with a high score. ctx is checked before
// and after inference; interrupting a running model is up to the ZeroShot function.
package transformers

import (
	"context"
	"errors"
	"slices"

	"rt.local/core-go/choice"
)

// ErrInvalidResponse is returned when the classifier's labels do not match the labels sent.
var ErrInvalidResponse = errors.New("Invalid classifier response") //nolint:staticcheck // text of the reference

// Options are the pipeline options; MultiLabel is always false (one winner).
type Options struct {
	MultiLabel bool `json:"multi_label"`
}

// Result is a zero-shot classification: Labels (a permutation of the labels sent) and Scores.
type Result struct {
	Labels []string
	Scores []float64
}

// ZeroShot classifies text against labels (a zero-shot-classification pipeline).
type ZeroShot func(ctx context.Context, text string, labels []string, options Options) (Result, error)

// Provider implements choice.Provider over a ZeroShot classifier.
type Provider struct {
	pipeline ZeroShot
	model    string
}

// New returns a provider reporting model as the prediction's model (not validated here;
// choice.Choice rejects an empty one).
func New(pipeline ZeroShot, model string) *Provider {
	return &Provider{pipeline: pipeline, model: model}
}

// ID is "transformers".
func (p *Provider) ID() string { return "transformers" }

// Labels returns one label per option: the id, or "id: description" for a non-empty description.
func Labels(input choice.Input) []string {
	labels := make([]string, len(input.Options))
	for i, o := range input.Options {
		labels[i] = o.ID
		if o.Description != nil && *o.Description != "" {
			labels[i] += ": " + *o.Description
		}
	}
	return labels
}

// Text is question + "\n\n" + JSON.stringify(context); "undefined" when there is no context.
func Text(input choice.Input) string {
	context := "undefined"
	if input.Context != nil {
		context = string(input.Context)
	}
	return input.Question + "\n\n" + context
}

// Predict classifies a validated input (from choice.Validate; Choice.Decide does that).
func (p *Provider) Predict(ctx context.Context, input choice.Input) (choice.Prediction, error) {
	if err := choice.CheckAborted(ctx); err != nil {
		return choice.Prediction{}, err
	}
	labels := Labels(input)
	result, err := p.pipeline(ctx, Text(input), labels, Options{MultiLabel: false})
	if err != nil {
		return choice.Prediction{}, err
	}
	if err := choice.CheckAborted(ctx); err != nil {
		return choice.Prediction{}, err
	}
	if len(result.Labels) != len(labels) || len(result.Scores) != len(labels) {
		return choice.Prediction{}, ErrInvalidResponse
	}
	seen := make(map[string]bool, len(labels))
	for _, label := range result.Labels {
		if seen[label] || !slices.Contains(labels, label) {
			return choice.Prediction{}, ErrInvalidResponse
		}
		seen[label] = true
	}
	probabilities := make(map[string]float64, len(labels))
	for i, o := range input.Options {
		probabilities[o.ID] = result.Scores[slices.Index(result.Labels, labels[i])]
	}
	return choice.Prediction{Model: p.model, Semantics: choice.UncalibratedScores, Probabilities: probabilities}, nil
}
