package main

import (
	"context"

	"rt.local/core-go/health"
	"rt.local/core-go/web"
)

// Health: GET /health/live and /health/ready (guests) and GET /admin/app/health/report (owner).
// The "database" probe reads one row of the shared store, like the TypeScript framework's default.
func init() {
	register(func(c *Components) ([]web.Feature, error) {
		checks, err := health.New([]health.Probe{{ID: "database", Check: func(ctx context.Context) error {
			store, err := c.Store.Get()
			if err != nil {
				return err
			}
			_, err = store.Get(ctx, "SCHEMA", "users")
			return err
		}}})
		if err != nil {
			return nil, err
		}
		return []web.Feature{checks.Feature()}, nil
	})
}
