// Package health provides liveness and readiness endpoints.
package health

import "rt.local/core-go/web"

// Feature returns GET /health/live and GET /health/ready, both public, answering {"ok":true}.
func Feature() web.Feature {
	ok := func(*web.Context) (any, error) { return map[string]bool{"ok": true}, nil }
	return web.Feature{
		ID: "health",
		Endpoints: []web.Endpoint{
			{Method: "GET", Path: "/health/live", Access: web.Guest, Resource: "health.live", Handle: ok},
			{Method: "GET", Path: "/health/ready", Access: web.Guest, Resource: "health.ready", Handle: ok},
		},
	}
}
