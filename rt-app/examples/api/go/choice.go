package main

import (
	"context"
	"encoding/json"
	"errors"

	"rt.local/core-go/choice"
	"rt.local/core-go/web"
)

// POST /admin/app/choice/decide with a local provider (rt-app/spec/contracts/choice-api.contract.yaml).
// localChoice is for local development and the HTTP contracts only; in a real app swap it here,
// e.g. jev.New(os.Getenv("TYPESAFE_API_KEY")) from rt.local/core-go/choice/jev.
func init() {
	register(func(*Components) ([]web.Feature, error) {
		return []web.Feature{choice.New(localChoice{}).Feature()}, nil
	})
}

// localChoice never runs in production: a context object with a "prediction" field is the
// answer ("fail" makes it fail); otherwise every option gets 1/n as uncalibrated scores, so
// decisions abstain.
type localChoice struct{}

func (localChoice) ID() string { return "local" }

func (localChoice) Predict(_ context.Context, input choice.Input) (choice.Prediction, error) {
	var fields map[string]any
	if input.Context != nil {
		_ = json.Unmarshal(input.Context, &fields) // not an object: no prediction
	}
	if prediction, ok := fields["prediction"]; ok {
		if prediction == "fail" {
			return choice.Prediction{}, errors.New("Local choice provider failure")
		}
		return choice.ParsePrediction(prediction)
	}
	share := 1 / float64(len(input.Options))
	probabilities := make(map[string]float64, len(input.Options))
	for _, o := range input.Options {
		probabilities[o.ID] = share
	}
	return choice.Prediction{Model: "local", Semantics: choice.UncalibratedScores, Probabilities: probabilities}, nil
}
