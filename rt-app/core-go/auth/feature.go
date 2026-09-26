package auth

import (
	"errors"

	"rt.local/core-go/nosql"
	"rt.local/core-go/users"
	"rt.local/core-go/web"
)

// Feature exposes the sign-in endpoints of the reference with its paths and access levels
// (owner and permission endpoints are mounted under /admin/app by package web). Endpoints
// normalize emails with users.EmailAddress before calling the methods:
//
//	POST /auth/login                 guest          {email, password}
//	POST /auth/code                  guest          {email}            emailed sign-in code
//	POST /auth/code/verify           guest          {email, code}
//	POST /auth/forgot-password       guest          {email}
//	POST /auth/reset-password        guest          {email, code, password}
//	POST /auth/mfa/verify            guest          {challengeId, code}
//	GET  /auth/methods               guest          enabled sign-in methods
//	GET  /auth/mfa                   authenticated  {enabled, type}
//	POST /auth/mfa/setup             authenticated  {password}
//	POST /auth/mfa/enable            authenticated  {challengeId, code}
//	POST /auth/email-change          authenticated  {email}
//	POST /auth/email-change/verify   authenticated  {code}
//	POST /auth/logout                authenticated  revokes every session of the caller
//	POST /auth/mfa/reset             owner          {userId}
//	GET  /auth/settings              permission     auth.settings.read
//	PUT  /auth/settings              owner          {version, values}
//
// Use Authenticate as the app's authenticator: web.WithAuthenticator(a.Authenticate).
func (a *Auth) Feature() web.Feature {
	body := func(c *web.Context, key string) any { return c.Request.Body[key] }
	email := func(c *web.Context) (string, error) { return users.EmailAddress(body(c, "email")) }
	return web.Feature{ID: "auth", Endpoints: []web.Endpoint{
		{Method: "POST", Path: "/auth/mfa/reset", Resource: "auth.mfa.reset", Access: web.Owner, Handle: func(c *web.Context) (any, error) {
			return a.ResetMFA(c.Ctx, body(c, "userId"))
		}},
		{Method: "POST", Path: "/auth/mfa/verify", Resource: "auth.mfa.verify", Access: web.Guest, Handle: func(c *web.Context) (any, error) {
			return a.VerifyMFA(c.Ctx, body(c, "challengeId"), body(c, "code"), c.Request.IP)
		}},
		{Method: "GET", Path: "/auth/mfa", Resource: "auth.mfa.status", Access: web.Authenticated, Handle: func(c *web.Context) (any, error) {
			on, err := a.HasMFA(c.Ctx, c.Actor.ID)
			return map[string]any{"enabled": on, "type": "totp"}, err
		}},
		{Method: "POST", Path: "/auth/mfa/setup", Resource: "auth.mfa.setup", Access: web.Authenticated, Handle: func(c *web.Context) (any, error) {
			return a.SetupMFA(c.Ctx, c.Actor.ID, body(c, "password"), c.Request.IP)
		}},
		{Method: "POST", Path: "/auth/mfa/enable", Resource: "auth.mfa.enable", Access: web.Authenticated, Handle: func(c *web.Context) (any, error) {
			return a.EnableMFA(c.Ctx, c.Actor.ID, body(c, "challengeId"), body(c, "code"), c.Request.IP)
		}},
		{Method: "GET", Path: "/auth/methods", Resource: "auth.methods", Access: web.Guest, Handle: func(c *web.Context) (any, error) {
			settings, err := a.Settings(c.Ctx)
			if err != nil {
				return nil, err
			}
			return users.With(settings.Values, map[string]any{"provider": "local", "totp": true, "selfRegistration": false, "refreshTokens": false}), nil
		}},
		{Method: "GET", Path: "/auth/settings", Resource: "auth.settings.read", Access: web.Permission, Handle: func(c *web.Context) (any, error) {
			return a.Settings(c.Ctx)
		}},
		{Method: "PUT", Path: "/auth/settings", Resource: "auth.settings.write", Access: web.Owner, Handle: func(c *web.Context) (any, error) {
			return a.UpdateSettings(c.Ctx, c.Request.Body)
		}},
		{Method: "POST", Path: "/auth/login", Resource: "auth.login", Access: web.Guest, Handle: func(c *web.Context) (any, error) {
			address, err := email(c)
			if err != nil {
				return nil, err
			}
			return a.Login(c.Ctx, address, body(c, "password"), c.Request.IP)
		}},
		{Method: "POST", Path: "/auth/code", Resource: "auth.code", Access: web.Guest, Handle: func(c *web.Context) (any, error) {
			address, err := email(c)
			if err != nil {
				return nil, err
			}
			return a.Issue(c.Ctx, address, "login", c.Request.IP)
		}},
		{Method: "POST", Path: "/auth/code/verify", Resource: "auth.code.verify", Access: web.Guest, Handle: func(c *web.Context) (any, error) {
			address, err := email(c)
			if err != nil {
				return nil, err
			}
			return a.Consume(c.Ctx, address, body(c, "code"), "login", c.Request.IP, nil)
		}},
		{Method: "POST", Path: "/auth/forgot-password", Resource: "auth.forgot", Access: web.Guest, Handle: func(c *web.Context) (any, error) {
			address, err := email(c)
			if err != nil {
				return nil, err
			}
			return a.Issue(c.Ctx, address, "reset", c.Request.IP)
		}},
		{Method: "POST", Path: "/auth/reset-password", Resource: "auth.reset", Access: web.Guest, Handle: func(c *web.Context) (any, error) {
			address, err := email(c)
			if err != nil {
				return nil, err
			}
			return a.Consume(c.Ctx, address, body(c, "code"), "reset", c.Request.IP, body(c, "password"))
		}},
		{Method: "POST", Path: "/auth/email-change", Resource: "auth.email.change", Access: web.Authenticated, Handle: func(c *web.Context) (any, error) {
			address, err := email(c)
			if err != nil {
				return nil, err
			}
			return a.RequestEmailChange(c.Ctx, c.Actor.ID, address, c.Request.IP)
		}},
		{Method: "POST", Path: "/auth/email-change/verify", Resource: "auth.email.verify", Access: web.Authenticated, Handle: func(c *web.Context) (any, error) {
			return a.ConfirmEmailChange(c.Ctx, c.Actor.ID, body(c, "code"), c.Request.IP)
		}},
		{Method: "POST", Path: "/auth/logout", Resource: "auth.logout", Access: web.Authenticated, Handle: func(c *web.Context) (any, error) {
			row, err := a.users.Get(c.Ctx, c.Actor.ID)
			if err != nil {
				return nil, err
			}
			if row == nil {
				return nil, errors.New("auth: the session's user disappeared")
			}
			if err := a.store.Transact(c.Ctx, []nosql.Write{revoke(row)}); err != nil {
				return nil, err
			}
			return map[string]bool{"ok": true}, nil
		}},
	}}
}
