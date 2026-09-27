// Package webhook is the Observer output that posts each event as JSON to a trusted HTTPS
// receiver configured in server code (TypeScript WebhookOutput).
package webhook

import (
	"context"
	"errors"
	"maps"

	"rt.local/core-go/observer"
)

// ErrNotHTTPS is returned by New for destinations that are not https:.
var ErrNotHTTPS = errors.New("Webhook output requires HTTPS")

// Output posts event.JSON(0) with Content-Type: application/json followed by the configured
// headers (which may replace it), through observer.PostOutput.
type Output struct {
	id        string
	url       string
	headers   map[string]string
	transport observer.Transport
}

// New returns a webhook output; url must parse (observer.ErrInvalidURL) and use https:. A nil
// transport sends with observer.HTTPTransport(nil).
func New(id, url string, headers map[string]string, transport observer.Transport) (*Output, error) {
	u, err := observer.ParseURL(url)
	if err != nil {
		return nil, err
	}
	if u.Scheme != "https" {
		return nil, ErrNotHTTPS
	}
	return &Output{id: id, url: url, headers: maps.Clone(headers), transport: transport}, nil
}

// ID is the configured id.
func (o *Output) ID() string { return o.id }

// Write delivers one event; errors name the status only.
func (o *Output) Write(ctx context.Context, event observer.Event) error {
	headers := map[string]string{"Content-Type": "application/json"}
	maps.Copy(headers, o.headers)
	return observer.PostOutput(ctx, o.url, event.JSON(0), headers, o.transport)
}
