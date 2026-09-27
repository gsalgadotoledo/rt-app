package main

// Subscriptions: owner endpoints under /admin/app/subscriptions/admin/* (local owner), the
// personal /subscriptions/* endpoints (need a session: 401 "Sign in" in local mode) and the
// guest webhook. Local mode wires the payment simulator (LocalBilling) like the TypeScript
// framework; there is no Stripe catalog or mailer here. Real Lambda deployments (-mode=lambda)
// never use the simulator.

import (
	"rt.local/core-go/subscriptions"
	"rt.local/core-go/web"
)

func init() {
	register(func(c *Components) ([]web.Feature, error) {
		store, err := c.Store.Get()
		if err != nil {
			return nil, err
		}
		billing, err := subscriptions.NewLocalBilling(store, nil)
		if err != nil {
			return nil, err
		}
		return []web.Feature{subscriptions.New(store, subscriptions.WithProvider(billing)).Feature()}, nil
	})
}
