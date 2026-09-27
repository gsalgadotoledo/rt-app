package main

import (
	"crypto/rand"
	"os"

	"rt.local/core-go/auth"
	"rt.local/core-go/jwt"
	"rt.local/core-go/users"
	"rt.local/core-go/web"
)

// Accounts and sign-in: /users/me and /admin/app/users (users), /auth/login, /auth/refresh,
// /auth/sessions, /auth/logout and the other /auth endpoints (auth), with access tokens resolved
// by auth.Authenticate. Codes go to a local mailbox (nothing is sent). Tokens and refresh-token
// hashes are keyed with RT_APP_SECRET (at least 32 characters); without it a random secret is
// used, fine for one local process but not for several instances or Lambda cold starts.
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
		tokens, err := jwt.New(secret)
		if err != nil {
			return nil, err
		}
		accounts := users.New(store)
		sessions := auth.New(accounts, tokens, &auth.LocalMailbox{}, secret)
		c.Authenticator = sessions.Authenticate
		return []web.Feature{accounts.Feature(), sessions.Feature()}, nil
	})
}
