package main

import (
	"rt.local/core-go/tasks"
	"rt.local/core-go/web"
)

func init() {
	register(func(c *Components) ([]web.Feature, error) {
		store, err := c.Store.Get()
		if err != nil {
			return nil, err
		}
		return []web.Feature{tasks.New(store).Feature()}, nil
	})
}
