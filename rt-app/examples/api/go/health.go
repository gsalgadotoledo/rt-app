package main

import (
	"rt.local/core-go/health"
	"rt.local/core-go/web"
)

func init() {
	register(func(*Components) ([]web.Feature, error) { return []web.Feature{health.Feature()}, nil })
}
