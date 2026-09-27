package main

import (
	"rt.local/core-go/featureflags"
	"rt.local/core-go/web"
)

func init() {
	register(func(c *Components) ([]web.Feature, error) {
		store, err := c.Store.Get()
		if err != nil {
			return nil, err
		}
		return []web.Feature{featureflags.New(store).Feature()}, nil
	})
}
