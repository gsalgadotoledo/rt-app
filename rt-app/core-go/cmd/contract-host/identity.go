package main

// Subjects: jwt, users, acl, auth (identity modules). Each subject is a small facade with the
// surface of spec/hosts/node/identity.mjs; helpers are documented in docs/polyglot.md.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sync"
	"time"

	"rt.local/core-go/acl"
	"rt.local/core-go/auth"
	"rt.local/core-go/conformance"
	"rt.local/core-go/internal/js"
	"rt.local/core-go/jwt"
	"rt.local/core-go/nosql"
	"rt.local/core-go/users"
	"rt.local/core-go/web"
)

func init() {
	register("jwt", jwtSubject)
	register("users", usersSubject)
	register("acl", aclSubject)
	register("auth", authSubject)
}

// clock is a settable clock starting at init.now (ISO 8601); the system clock when absent.
type clock struct {
	mu    sync.Mutex
	fixed *time.Time
}

func newClock(init json.RawMessage) (*clock, error) {
	var config struct {
		Now *string `json:"now"`
	}
	if err := json.Unmarshal(init, &config); err != nil {
		return nil, errors.New("init.now must be an ISO 8601 date")
	}
	c := &clock{}
	if config.Now != nil {
		at, err := parseISO(*config.Now)
		if err != nil {
			return nil, errors.New("init.now must be an ISO 8601 date")
		}
		c.fixed = &at
	}
	return c, nil
}

// Now is the clock the subject's modules share.
func (c *clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.fixed == nil {
		return time.Now()
	}
	return *c.fixed
}

// setNow(iso) → null
func (c *clock) setNow(_ context.Context, args []json.RawMessage) (any, error) {
	iso, ok := argAny(args, 0).(string)
	at, err := parseISO(iso)
	if !ok || err != nil {
		return nil, errors.New("setNow needs an ISO 8601 date")
	}
	c.mu.Lock()
	c.fixed = &at
	c.mu.Unlock()
	return nil, nil
}

// parseISO reads the instants Date.parse reads in contracts, at millisecond precision.
func parseISO(s string) (time.Time, error) {
	at, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		at, err = time.Parse("2006-01-02", s)
	}
	return at.Truncate(time.Millisecond), err
}

func jwtSubject(_ context.Context, init json.RawMessage) (conformance.Instance, error) {
	now, err := newClock(init)
	if err != nil {
		return conformance.Instance{}, err
	}
	var config struct {
		Secret   string  `json:"secret"`
		Issuer   *string `json:"issuer"`
		Audience *string `json:"audience"`
	}
	if err := json.Unmarshal(init, &config); err != nil {
		return conformance.Instance{}, fmt.Errorf("init: %w", err)
	}
	options := []jwt.Option{jwt.WithClock(now.Now)}
	if config.Issuer != nil {
		options = append(options, jwt.WithIssuer(*config.Issuer))
	}
	if config.Audience != nil {
		options = append(options, jwt.WithAudience(*config.Audience))
	}
	tokens, err := jwt.New(config.Secret, options...)
	if err != nil {
		return conformance.Instance{}, err
	}
	return conformance.Instance{Methods: map[string]conformance.Method{
		// issue({id, tokenVersion}) → token; other user fields are ignored
		"issue": func(_ context.Context, args []json.RawMessage) (any, error) {
			user, _ := argAny(args, 0).(map[string]any)
			id, ok := user["id"].(string)
			if !ok {
				return nil, errors.New(`"sub" claim must be a string`)
			}
			version, ok := js.Integer(user["tokenVersion"])
			if !ok {
				return nil, errors.New("tokenVersion must be an integer")
			}
			return tokens.Issue(jwt.User{ID: id, TokenVersion: int(version)}), nil
		},
		// verify(token) → {id, version}; any non-string is an invalid token
		"verify": func(_ context.Context, args []json.RawMessage) (any, error) {
			token, _ := argAny(args, 0).(string)
			return tokens.Verify(token)
		},
		"setNow": now.setNow,
	}}, nil
}

func usersSubject(ctx context.Context, init json.RawMessage) (conformance.Instance, error) {
	now, err := newClock(init)
	if err != nil {
		return conformance.Instance{}, err
	}
	store, err := memoryStore(ctx, init)
	if err != nil {
		return conformance.Instance{}, err
	}
	accounts := users.New(store, users.WithClock(now.Now))
	return conformance.Instance{Methods: map[string]conformance.Method{
		// get(id) → row | null
		"get": func(ctx context.Context, args []json.RawMessage) (any, error) {
			return accounts.Get(ctx, argString(args, 0))
		},
		// byEmail(email) → row | null (exact index lookup)
		"byEmail": func(ctx context.Context, args []json.RawMessage) (any, error) {
			return accounts.ByEmail(ctx, argString(args, 0))
		},
		// create(input, role?, actor?) → row
		"create": func(ctx context.Context, args []json.RawMessage) (any, error) {
			input, err := argObject(args, 0)
			if err != nil {
				return nil, err
			}
			return accounts.Create(ctx, input, argString(args, 1), argString(args, 2))
		},
		// bootstrapOwner(input) → row
		"bootstrapOwner": func(ctx context.Context, args []json.RawMessage) (any, error) {
			input, err := argObject(args, 0)
			if err != nil {
				return nil, err
			}
			return accounts.BootstrapOwner(ctx, input)
		},
		// profile(id, input, actor?) → view
		"profile": func(ctx context.Context, args []json.RawMessage) (any, error) {
			input, err := argObject(args, 1)
			if err != nil {
				return nil, err
			}
			return accounts.Profile(ctx, argString(args, 0), input, argString(args, 2))
		},
		// validatePassword(p) → null
		"validatePassword": func(_ context.Context, args []json.RawMessage) (any, error) {
			return nil, users.ValidatePassword(argAny(args, 0))
		},
		// hashPassword(p) → "scrypt$<salt>$<hex>"
		"hashPassword": func(_ context.Context, args []json.RawMessage) (any, error) {
			return users.HashPassword(argAny(args, 0))
		},
		// verifyPassword(p, stored) → bool
		"verifyPassword": func(_ context.Context, args []json.RawMessage) (any, error) {
			password := argAny(args, 0)
			stored, ok := argAny(args, 1).(string)
			if !ok {
				if s, isString := password.(string); !isString || js.Len(s) > 128 {
					return false, nil // refused before the stored value is read
				}
				return nil, errors.New("stored hash must be a string")
			}
			return users.VerifyPassword(password, stored)
		},
		"row": rowMethod(store),
	}}, nil
}

func aclSubject(ctx context.Context, init json.RawMessage) (conformance.Instance, error) {
	now, err := newClock(init)
	if err != nil {
		return conformance.Instance{}, err
	}
	store, err := memoryStore(ctx, init)
	if err != nil {
		return conformance.Instance{}, err
	}
	var config struct {
		Resources []json.RawMessage `json:"resources"`
	}
	if err := json.Unmarshal(init, &config); err != nil {
		return conformance.Instance{}, fmt.Errorf("init: %w", err)
	}
	resources := make([]acl.Endpoint, len(config.Resources))
	for i, raw := range config.Resources {
		resources[i] = endpointFrom(decodeAny(raw))
	}
	policy := acl.New(store, func() []acl.Endpoint { return resources }, acl.WithClock(now.Now))
	return conformance.Instance{Methods: map[string]conformance.Method{
		// allows(actor, resource) → bool
		"allows": func(_ context.Context, args []json.RawMessage) (any, error) {
			return policy.Allows(actorFrom(argAny(args, 0)), argString(args, 1)), nil
		},
		// check(endpoint, actor) → null
		"check": func(_ context.Context, args []json.RawMessage) (any, error) {
			return nil, policy.Check(endpointFrom(argAny(args, 0)), actorFrom(argAny(args, 1)))
		},
		// resources(query) → [{resource, method, path, access}] (GET /acl/resources)
		"resources": func(_ context.Context, args []json.RawMessage) (any, error) {
			query := map[string]string{}
			raw, _ := argAny(args, 0).(map[string]any)
			for k, v := range raw {
				if js.Truthy(v) {
					query[k] = js.String(v)
				} else {
					query[k] = ""
				}
			}
			return policy.Resources(query)
		},
		// assign(id, body, actor) → view (PUT /acl/users/:id)
		"assign": func(ctx context.Context, args []json.RawMessage) (any, error) {
			body, _ := argAny(args, 1).(map[string]any)
			if body == nil {
				body = map[string]any{}
			}
			return policy.Assign(ctx, argString(args, 0), body, actorFrom(argAny(args, 2)))
		},
		"row": rowMethod(store),
	}}, nil
}

func authSubject(ctx context.Context, init json.RawMessage) (conformance.Instance, error) {
	now, err := newClock(init)
	if err != nil {
		return conformance.Instance{}, err
	}
	store, err := memoryStore(ctx, init)
	if err != nil {
		return conformance.Instance{}, err
	}
	var config struct {
		Secret string `json:"secret"`
	}
	if err := json.Unmarshal(init, &config); err != nil {
		return conformance.Instance{}, fmt.Errorf("init: %w", err)
	}
	tokens, err := jwt.New(config.Secret, jwt.WithClock(now.Now))
	if err != nil {
		return conformance.Instance{}, err
	}
	mailbox := &auth.LocalMailbox{}
	accounts := users.New(store, users.WithClock(now.Now))
	a := auth.New(accounts, tokens, mailbox, config.Secret, auth.WithClock(now.Now))
	vault := auth.NewVault(config.Secret)
	str := argString
	return conformance.Instance{Methods: map[string]conformance.Method{
		// login(email, password, ip) → session | {challenge, challengeId}
		"login": func(ctx context.Context, args []json.RawMessage) (any, error) {
			return a.Login(ctx, str(args, 0), argAny(args, 1), str(args, 2))
		},
		// issue(email, purpose, ip) → {message}
		"issue": func(ctx context.Context, args []json.RawMessage) (any, error) {
			return a.Issue(ctx, str(args, 0), str(args, 1), str(args, 2))
		},
		// consume(email, code, purpose, ip, password?, challengeId?) → session | {message}
		"consume": func(ctx context.Context, args []json.RawMessage) (any, error) {
			return a.Consume(ctx, str(args, 0), argAny(args, 1), str(args, 2), str(args, 3), argAny(args, 4))
		},
		// actor(header?) → actor | null
		"actor": func(ctx context.Context, args []json.RawMessage) (any, error) {
			actor, err := a.Actor(ctx, str(args, 0))
			if actor == nil {
				return nil, err // untyped nil: conformance.Encode turns a nil map into {}
			}
			return actor, err
		},
		// limit(key, max) → null
		"limit": func(ctx context.Context, args []json.RawMessage) (any, error) {
			max, _ := argAny(args, 1).(float64)
			return nil, a.Limit(ctx, str(args, 0), int(math.Ceil(max)))
		},
		"settings": func(ctx context.Context, _ []json.RawMessage) (any, error) { return a.Settings(ctx) },
		// updateSettings({version, values}) → settings
		"updateSettings": func(ctx context.Context, args []json.RawMessage) (any, error) {
			input, err := argObject(args, 0)
			if err != nil {
				return nil, err
			}
			return a.UpdateSettings(ctx, input)
		},
		"hasMfa": func(ctx context.Context, args []json.RawMessage) (any, error) { return a.HasMFA(ctx, str(args, 0)) },
		// setupMfa(id, password, ip) → {challenge, challengeId, secret, uri}
		"setupMfa": func(ctx context.Context, args []json.RawMessage) (any, error) {
			return a.SetupMFA(ctx, str(args, 0), argAny(args, 1), str(args, 2))
		},
		// enableMfa(id, challengeId, code, ip) → {message, reauthenticate}
		"enableMfa": func(ctx context.Context, args []json.RawMessage) (any, error) {
			return a.EnableMFA(ctx, str(args, 0), argAny(args, 1), argAny(args, 2), str(args, 3))
		},
		// verifyMfa(challengeId, code, ip) → session
		"verifyMfa": func(ctx context.Context, args []json.RawMessage) (any, error) {
			return a.VerifyMFA(ctx, argAny(args, 0), argAny(args, 1), str(args, 2))
		},
		"resetMfa": func(ctx context.Context, args []json.RawMessage) (any, error) {
			return a.ResetMFA(ctx, argAny(args, 0))
		},
		// requestEmailChange(id, email, ip) → {message}
		"requestEmailChange": func(ctx context.Context, args []json.RawMessage) (any, error) {
			return a.RequestEmailChange(ctx, str(args, 0), str(args, 1), str(args, 2))
		},
		// confirmEmailChange(id, code, ip) → session
		"confirmEmailChange": func(ctx context.Context, args []json.RawMessage) (any, error) {
			return a.ConfirmEmailChange(ctx, str(args, 0), argAny(args, 1), str(args, 2))
		},
		// Helpers (not Auth methods): captured mail, stored rows, clock, TOTP and vault.
		"mailbox": func(context.Context, []json.RawMessage) (any, error) {
			out := []map[string]string{}
			for _, m := range mailbox.Messages() {
				out = append(out, map[string]string{"email": m.Email, "code": m.Code, "purpose": m.Purpose})
			}
			return out, nil
		},
		"row":    rowMethod(store),
		"setNow": now.setNow,
		// totpCode(secret, step) → six digits
		"totpCode": func(_ context.Context, args []json.RawMessage) (any, error) {
			step, ok := js.Integer(argAny(args, 1))
			if !ok || step < 0 || step >= 1<<64 {
				return nil, errors.New("step must be a non-negative integer")
			}
			return auth.TOTPCode(str(args, 0), uint64(step))
		},
		// unseal(sealed) → the decrypted JSON value
		"unseal": func(_ context.Context, args []json.RawMessage) (any, error) { return vault.Open(str(args, 0)) },
	}}, nil
}

// rowMethod is the row(pk, sk) helper: the raw stored row or null.
func rowMethod(store nosql.Store) conformance.Method {
	return func(ctx context.Context, args []json.RawMessage) (any, error) {
		return store.Get(ctx, argString(args, 0), argString(args, 1))
	}
}

// decodeAny decodes a wire value (numbers are float64); invalid JSON is nil.
func decodeAny(raw json.RawMessage) any {
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return nil
	}
	return value
}

// argAny returns argument i decoded, or nil when it is missing or null.
func argAny(args []json.RawMessage, i int) any { return decodeAny(arg(args, i)) }

// argString returns argument i when it is a string; "" for null, missing and other values
// (wire null stands for an omitted optional argument).
func argString(args []json.RawMessage, i int) string {
	s, _ := argAny(args, i).(string)
	return s
}

// argObject returns argument i as an object: null is an error (like reading a property of
// null in JavaScript) and other primitives have no properties.
func argObject(args []json.RawMessage, i int) (map[string]any, error) {
	switch v := argAny(args, i).(type) {
	case nil:
		return nil, fmt.Errorf("argument %d must be an object", i+1)
	case map[string]any:
		return v, nil
	default:
		return map[string]any{}, nil
	}
}

// actorFrom reads a wire actor {id, role, grants, ...}; null is anonymous.
func actorFrom(value any) *web.Actor {
	object, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	actor := &web.Actor{}
	actor.ID, _ = object["id"].(string)
	actor.Role, _ = object["role"].(string)
	grants, _ := object["grants"].([]any)
	for _, g := range grants {
		if s, ok := g.(string); ok {
			actor.Grants = append(actor.Grants, s)
		}
	}
	return actor
}

// endpointFrom reads a wire endpoint {resource, method, path, access, explicitGrant?}.
func endpointFrom(value any) acl.Endpoint {
	object, _ := value.(map[string]any)
	var e acl.Endpoint
	e.Resource, _ = object["resource"].(string)
	e.Method, _ = object["method"].(string)
	e.Path, _ = object["path"].(string)
	e.Access, _ = object["access"].(string)
	e.ExplicitGrant = js.Truthy(object["explicitGrant"])
	return e
}
