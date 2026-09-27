package main

import (
	"rt.local/core-go/observer"
	"rt.local/core-go/web"
)

// Observer: POST /observer/events (guests, page views); GET /admin/app/observer/report and
// /admin/app/observer/logs (owner only, served under /admin/app only). Events are kept in the
// shared store (OBSERVER#<day> partitions, seven-day TTL). Add outputs here, e.g.
// {Handler: console.New(nil), Levels: []string{"info", "warn", "error"}} or a webhook; remote
// outputs are server configuration and never come from clients.
func init() {
	register(func(c *Components) ([]web.Feature, error) {
		store, err := c.Store.Get()
		if err != nil {
			return nil, err
		}
		storage := observer.NewStore(store, nil)
		o, err := observer.New([]observer.Output{{Handler: storage}})
		if err != nil {
			return nil, err
		}
		return []web.Feature{observer.Feature(o, storage, nil, nil)}, nil
	})
}
