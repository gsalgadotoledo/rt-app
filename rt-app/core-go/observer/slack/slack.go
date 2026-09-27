// Package slack is the Observer output that posts a plain-text message per event to a Slack
// incoming webhook owned by the operator (TypeScript SlackOutput).
package slack

import (
	"context"
	"errors"
	"strings"

	"rt.local/core-go/observer"
)

// ErrInvalidWebhook is returned by New for URLs that are not Slack incoming webhooks.
var ErrInvalidWebhook = errors.New("Invalid Slack incoming webhook")

// Output posts {"text": "[<level>] <category or source>: <message>\nRequest: <requestId or id>",
// "mrkdwn": false}.
type Output struct {
	webhook   string
	transport observer.Transport
}

// New accepts only https://hooks.slack.com/services/… and https://hooks.slack-gov.com/services/…
// (after WHATWG parsing: lowercase host, no port change). A nil transport sends with
// observer.HTTPTransport(nil).
func New(webhook string, transport observer.Transport) (*Output, error) {
	u, err := observer.ParseURL(webhook)
	if err != nil {
		return nil, err
	}
	if u.Scheme != "https" || u.Host != "hooks.slack.com" && u.Host != "hooks.slack-gov.com" || !strings.HasPrefix(u.Pathname(), "/services/") {
		return nil, ErrInvalidWebhook
	}
	return &Output{webhook: webhook, transport: transport}, nil
}

// ID is "slack".
func (o *Output) ID() string { return "slack" }

// Write delivers one message; an empty category or request id falls back to the source or the
// event id.
func (o *Output) Write(ctx context.Context, event observer.Event) error {
	label, request := event.Category, event.RequestID
	if label == "" {
		label = event.Source
	}
	if request == "" {
		request = event.ID
	}
	text := "[" + event.Level + "] " + label + ": " + event.Message + "\nRequest: " + request
	body := observer.Stringify(observer.Object{{Key: "text", Value: text}, {Key: "mrkdwn", Value: false}}, 0)
	return observer.PostOutput(ctx, o.webhook, body, map[string]string{"Content-Type": "application/json"}, o.transport)
}
