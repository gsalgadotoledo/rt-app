package queue

import (
	"context"
	"net/http"

	"rt.local/core-go/apperr"
	"rt.local/core-go/internal/js"
	"rt.local/core-go/web"
)

// MaxTokenLength bounds retry tokens (UTF-16 units).
const MaxTokenLength = 400000

// Endpoint errors with the TypeScript messages.
var (
	ErrInspectUnsupported = apperr.New(http.StatusNotImplemented, "Failed-message inspection is not configured")
	ErrRetryUnsupported   = apperr.New(http.StatusNotImplemented, "Failed-message retry is not configured")
	ErrRetryToken         = apperr.BadRequest("Invalid retry token")
)

// Admin is the owner-only admin page manifest.
func Admin() map[string]any {
	return map[string]any{
		"id": "queue", "title": "Queue", "resource": "queue.read", "path": "/queue/status",
		"component": "queue", "ownerOnly": true, "fields": []any{}, "actions": []any{},
	}
}

// Status is GET /queue/status: {supported, capabilities}.
func (q *Queue) Status() map[string]any {
	caps := q.adapter.Capabilities()
	return map[string]any{"supported": caps.FailedAdmin, "capabilities": caps}
}

// admin returns the failure administration when the adapter declares and implements it.
func (q *Queue) admin() (FailureAdmin, bool) {
	admin, ok := q.adapter.(FailureAdmin)
	return admin, ok && q.adapter.Capabilities().FailedAdmin
}

// Inspect is POST /queue/failed/inspect with body {limit = 10} (decoded JSON): 501 when the
// adapter has no failure admin, 400 unless limit is an integer from 1 to 10.
func (q *Queue) Inspect(ctx context.Context, body map[string]any) (map[string]any, error) {
	admin, ok := q.admin()
	if !ok {
		return nil, ErrInspectUnsupported
	}
	limit := 10.0
	if raw := body["limit"]; raw != nil {
		f, ok := js.Integer(raw)
		if !ok {
			return nil, ErrFailureLimit
		}
		limit = f
	}
	if limit < 1 || limit > 10 {
		return nil, ErrFailureLimit
	}
	items, err := admin.InspectFailures(ctx, int(limit))
	if err != nil {
		return nil, err
	}
	if items == nil {
		items = []FailedMessage{}
	}
	return map[string]any{"items": items}, nil
}

// RetryFailed is POST /queue/failed/retry with body {token}: 501 without failure admin, 400
// unless token is a non-empty string of at most MaxTokenLength units.
func (q *Queue) RetryFailed(ctx context.Context, body map[string]any) (map[string]any, error) {
	admin, ok := q.admin()
	if !ok {
		return nil, ErrRetryUnsupported
	}
	token, ok := body["token"].(string)
	if !ok || token == "" || js.Len(token) > MaxTokenLength {
		return nil, ErrRetryToken
	}
	if err := admin.RetryFailure(ctx, token); err != nil {
		return nil, err
	}
	return map[string]any{"queued": true}, nil
}

// Feature registers the owner-only dead-letter controls. Inspection is POST because brokers may
// reserve messages while listing them.
func (q *Queue) Feature() web.Feature {
	return web.Feature{ID: "queue", Endpoints: []web.Endpoint{
		{Method: "GET", Path: "/queue/status", Access: web.Owner, Resource: "queue.read", Handle: func(*web.Context) (any, error) {
			return q.Status(), nil
		}},
		{Method: "POST", Path: "/queue/failed/inspect", Access: web.Owner, Resource: "queue.inspect", Handle: func(c *web.Context) (any, error) {
			return q.Inspect(c.Ctx, c.Request.Body)
		}},
		{Method: "POST", Path: "/queue/failed/retry", Access: web.Owner, Resource: "queue.retry", Handle: func(c *web.Context) (any, error) {
			return q.RetryFailed(c.Ctx, c.Request.Body)
		}},
	}}
}
