package main

import (
	"crypto/rand"
	"os"

	"rt.local/core-go/visits"
	"rt.local/core-go/web"
)

// Visits: POST /visits/start and /visits/events (guests); GET/DELETE /admin/app/visits (owner).
// Tokens are signed with RT_APP_SECRET (at least 32 characters). Without it a random secret is
// used, which is fine for one local process but not for several instances or Lambda cold starts.
func init() {
	register(func(c *Components) ([]web.Feature, error) {
		store, err := c.Store.Get()
		if err != nil {
			return nil, err
		}
		secret := os.Getenv("RT_APP_SECRET")
		if secret == "" {
			secret = rand.Text() + rand.Text()
		}
		v, err := visits.New(store, secret)
		if err != nil {
			return nil, err
		}
		return []web.Feature{v.Feature()}, nil
	})
}
