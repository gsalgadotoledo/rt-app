package main

import (
	"crypto/rand"
	"os"

	"rt.local/core-go/servicekeys"
	"rt.local/core-go/web"
)

// Service keys: scoped credentials for backends (Authorization: Bearer rtsk_<id>.<secret>) that
// reach only /service/* endpoints in their scopes, e.g. the subscriptions metering endpoints
// (/service/subscriptions/accounts/:id/*, scope subscriptions.meter). Keys are configured with
// RT_APP_SERVICE_KEYS (JSON) or RT_APP_SERVICE_KEYS_FILE, or created by the admin under
// /admin/app/service-keys (the token is shown once). The per-key rate-limit rows are keyed with
// RT_APP_SECRET (a random secret without it).
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
		configured, err := servicekeys.FromEnv(nil)
		if err != nil {
			return nil, err
		}
		// The resources of this API's service endpoints, sorted like the TypeScript framework.
		keys, err := servicekeys.New(store, secret, configured, []string{servicekeys.Self, "subscriptions.meter"})
		if err != nil {
			return nil, err
		}
		c.ServiceKeys = keys
		return []web.Feature{keys.Feature()}, nil
	})
}
