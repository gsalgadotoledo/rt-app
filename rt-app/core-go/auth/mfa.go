package auth

import (
	"context"
	"errors"
	"net/http"

	"rt.local/core-go/apperr"
	"rt.local/core-go/internal/js"
	"rt.local/core-go/internal/uuid"
	"rt.local/core-go/nosql"
	"rt.local/core-go/users"
)

// Enrollment starts TOTP enrollment: the secret to add to an authenticator (also as an
// otpauth:// URI) and the challenge EnableMFA completes.
type Enrollment struct {
	Challenge   string `json:"challenge"`
	ChallengeID string `json:"challengeId"`
	Secret      string `json:"secret"`
	URI         string `json:"uri"`
}

// HasMFA reports whether MFA/<id> is enabled.
func (a *Auth) HasMFA(ctx context.Context, id string) (bool, error) {
	row, err := a.store.Get(ctx, "MFA", id)
	return row != nil && js.Truthy(row.Data["enabled"]), err
}

// pending stores AUTH_FLOW/<uuid> {userId, tokenVersion, kind, expires, used, sealed}
// (ttl five minutes) with value sealed.
func (a *Auth) pending(ctx context.Context, user *nosql.Row, kind string, value any) (*Pending, error) {
	sealed, err := a.vault.Seal(value)
	if err != nil {
		return nil, err
	}
	id, now := uuid.New(), a.nowMs()
	ttl := floorDiv(now, 1000) + challengeTTLMs/1000
	row := nosql.Row{PK: "AUTH_FLOW", SK: id, Version: 1, TTL: &ttl, Data: map[string]any{
		"userId": user.Data["id"], "tokenVersion": user.Data["tokenVersion"], "kind": kind,
		"expires": now + challengeTTLMs, "used": false, "sealed": sealed}}
	if err := a.store.Transact(ctx, []nosql.Write{{Row: row}}); err != nil {
		return nil, err
	}
	return &Pending{Challenge: kind, ChallengeID: id}, nil
}

// readPending returns a live pending challenge of kind: the id must be a string of at most 100
// units (400 "Invalid challenge"); missing, other-kind, used and expired challenges are 400;
// a user that is inactive or whose sessions were revoked since is 401.
func (a *Auth) readPending(ctx context.Context, id any, kind string) (*nosql.Row, error) {
	s, ok := id.(string)
	if !ok || js.Len(s) > 100 {
		return nil, apperr.BadRequest("Invalid challenge")
	}
	row, err := a.store.Get(ctx, "AUTH_FLOW", s)
	if err != nil {
		return nil, err
	}
	if row == nil || !js.Equal(row.Data["kind"], kind) || js.Truthy(row.Data["used"]) || js.Field(row.Data, "expires") < float64(a.nowMs()) {
		return nil, apperr.BadRequest("Invalid or expired challenge")
	}
	user, err := a.userOf(ctx, row.Data["userId"])
	if err != nil {
		return nil, err
	}
	if user == nil || !js.Truthy(user.Data["active"]) || !js.Equal(user.Data["tokenVersion"], row.Data["tokenVersion"]) {
		return nil, apperr.New(http.StatusUnauthorized, msgInvalidSession)
	}
	return row, nil
}

// VerifyMFA completes a password sign-in with a TOTP code and returns the session. Codes of a
// step not newer than the last used one are refused, so a code works once.
func (a *Auth) VerifyMFA(ctx context.Context, challengeID, code any, ip string, userAgent ...string) (*Session, error) {
	if err := a.Limit(ctx, "mfa-ip:"+ip, 20); err != nil {
		return nil, err
	}
	pending, err := a.readPending(ctx, challengeID, "totp")
	if err != nil {
		return nil, err
	}
	if err := a.Limit(ctx, "mfa-user:"+js.String(pending.Data["userId"]), 5); err != nil {
		return nil, err
	}
	if s, ok := code.(string); !ok || !sixDigits(s) {
		return nil, apperr.BadRequest(msgInvalidCode)
	}
	user, err := a.userOf(ctx, pending.Data["userId"])
	if err != nil {
		return nil, err
	}
	if user == nil {
		return nil, errors.New("auth: the challenge's user disappeared")
	}
	if err := a.gate(user); err != nil {
		return nil, err
	}
	mfa, err := a.store.Get(ctx, "MFA", js.String(user.Data["id"]))
	if err != nil {
		return nil, err
	}
	if mfa == nil || !js.Truthy(mfa.Data["enabled"]) {
		return nil, apperr.BadRequest("MFA is not configured")
	}
	secret, err := a.vault.openSecret(mfa.Data["sealed"])
	if err != nil {
		return nil, err
	}
	last := int64(-1)
	if v, ok := mfa.Data["lastStep"].(float64); ok {
		last = int64(v)
	}
	step, ok, err := TOTPStep(secret, code, last, a.nowMs())
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, apperr.BadRequest("Invalid or previously used code")
	}
	next := *mfa
	next.Version++
	next.Data = users.With(mfa.Data, map[string]any{"lastStep": step})
	if err := a.store.Transact(ctx, []nosql.Write{{Row: next, Expected: nosql.Expect(mfa.Version)}, markUsed(pending)}); err != nil {
		return nil, err
	}
	return a.session(ctx, user, ip, userAgent)
}

// SetupMFA starts enrollment for user id after checking the password again. It needs
// password sign-in enabled and MFA not yet enabled.
func (a *Auth) SetupMFA(ctx context.Context, id string, password any, ip string) (*Enrollment, error) {
	if err := a.limits(ctx, rate{"mfa-setup:" + ip, 5}, rate{"mfa-setup-user:" + id, 5}); err != nil {
		return nil, err
	}
	settings, err := a.Settings(ctx)
	if err != nil {
		return nil, err
	}
	if !js.Truthy(settings.Values["passwordLogin"]) {
		return nil, apperr.New(http.StatusConflict, "Enable password sign-in before enabling MFA")
	}
	if on, err := a.HasMFA(ctx, id); err != nil || on {
		if err == nil {
			err = apperr.New(http.StatusConflict, "MFA is already enabled")
		}
		return nil, err
	}
	user, err := a.users.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	if user == nil {
		return nil, apperr.NotFound("User not found")
	}
	if err := users.ValidatePassword(password); err != nil {
		return nil, err
	}
	stored, ok := user.Data["passwordHash"].(string)
	if !ok {
		return nil, errors.New("auth: the account has no local password")
	}
	valid, err := users.VerifyPassword(password, stored)
	if err != nil {
		return nil, err
	}
	if !valid {
		return nil, apperr.New(http.StatusUnauthorized, "Incorrect password")
	}
	secret := NewTOTPSecret()
	pending, err := a.pending(ctx, user, "enroll", map[string]any{"secret": secret})
	if err != nil {
		return nil, err
	}
	uri := "otpauth://totp/RT-APP:" + js.EncodeURIComponent(js.String(user.Data["email"])) +
		"?secret=" + secret + "&issuer=RT-APP&algorithm=SHA1&digits=6&period=30"
	return &Enrollment{Challenge: pending.Challenge, ChallengeID: pending.ChallengeID, Secret: secret, URI: uri}, nil
}

// EnableMFA completes enrollment with a code of the new secret: MFA/<id> is stored (sealed
// secret, last used step), the challenge used and the user's sessions revoked, atomically.
func (a *Auth) EnableMFA(ctx context.Context, id string, challengeID, code any, ip string) (Reply, error) {
	if err := a.limits(ctx, rate{"mfa-enable:" + ip, 10}, rate{"mfa-enable-user:" + id, 5}); err != nil {
		return Reply{}, err
	}
	pending, err := a.readPending(ctx, challengeID, "enroll")
	if err != nil {
		return Reply{}, err
	}
	if !js.Equal(pending.Data["userId"], id) {
		return Reply{}, apperr.New(http.StatusForbidden, "Challenge belongs to another account")
	}
	if on, err := a.HasMFA(ctx, id); err != nil || on {
		if err == nil {
			err = apperr.New(http.StatusConflict, "MFA is already enabled")
		}
		return Reply{}, err
	}
	if s, ok := code.(string); !ok || !sixDigits(s) {
		return Reply{}, apperr.BadRequest(msgInvalidCode)
	}
	secret, err := a.vault.openSecret(pending.Data["sealed"])
	if err != nil {
		return Reply{}, err
	}
	user, err := a.users.Get(ctx, id)
	if err != nil {
		return Reply{}, err
	}
	if user == nil {
		return Reply{}, apperr.NotFound("User not found")
	}
	step, ok, err := TOTPStep(secret, code, -1, a.nowMs())
	if err != nil {
		return Reply{}, err
	}
	if !ok {
		return Reply{}, apperr.BadRequest(msgInvalidCode)
	}
	sealed, err := a.vault.Seal(map[string]any{"secret": secret})
	if err != nil {
		return Reply{}, err
	}
	err = a.store.Transact(ctx, []nosql.Write{
		{Row: nosql.Row{PK: "MFA", SK: id, Version: 1, Data: map[string]any{"enabled": true, "sealed": sealed, "lastStep": step}}},
		markUsed(pending),
		revoke(user),
	})
	if err != nil {
		return Reply{}, err
	}
	return Reply{Message: "MFA enabled. Sign in again.", Reauthenticate: true}, nil
}

// ResetMFA removes the MFA of user id (an owner operation) and revokes their sessions.
func (a *Auth) ResetMFA(ctx context.Context, id any) (Reply, error) {
	s, ok := id.(string)
	if !ok || js.Len(s) > 100 {
		return Reply{}, apperr.BadRequest("Invalid user")
	}
	user, err := a.users.Get(ctx, s)
	if err != nil {
		return Reply{}, err
	}
	if user == nil {
		return Reply{}, apperr.NotFound("User not found")
	}
	mfa, err := a.store.Get(ctx, "MFA", s)
	if err != nil {
		return Reply{}, err
	}
	var writes []nosql.Write
	if mfa != nil {
		writes = append(writes, nosql.Write{Row: *mfa, Expected: nosql.Expect(mfa.Version), Delete: true})
	}
	if err := a.store.Transact(ctx, append(writes, revoke(user))); err != nil {
		return Reply{}, err
	}
	return Reply{Message: "MFA reset; application sessions have been invalidated."}, nil
}

// revoke is the version-guarded write that bumps a user's tokenVersion (ending all sessions).
func revoke(user *nosql.Row) nosql.Write {
	next := *user
	next.Version++
	next.Data = users.With(user.Data, map[string]any{"tokenVersion": js.Add(user.Data["tokenVersion"], 1)})
	return nosql.Write{Row: next, Expected: nosql.Expect(user.Version)}
}

// SettingsField describes one sign-in setting for the admin console.
type SettingsField struct {
	Name  string `json:"name"`
	Label string `json:"label"`
	Type  string `json:"type"`
}

// Settings are the sign-in methods (SETTINGS/auth); Version is 0 before the first save.
type Settings struct {
	Version int             `json:"version"`
	Values  map[string]any  `json:"values"`
	Fields  []SettingsField `json:"fields"`
}

var settingsFields = []SettingsField{
	{Name: "passwordLogin", Label: "Allow password sign-in", Type: "boolean"},
	{Name: "emailCodeLogin", Label: "Allow email code sign-in", Type: "boolean"},
}

// Settings returns the stored sign-in settings, or both methods enabled.
func (a *Auth) Settings(ctx context.Context) (Settings, error) {
	row, err := a.store.Get(ctx, "SETTINGS", "auth")
	if err != nil {
		return Settings{}, err
	}
	s := Settings{Values: map[string]any{"passwordLogin": true, "emailCodeLogin": true}, Fields: settingsFields}
	if row != nil {
		s.Version, s.Values = row.Version, row.Data
	}
	return s, nil
}

// UpdateSettings saves {version, values: {passwordLogin, emailCodeLogin}} (optimistic: version
// must be the stored one). At least one method stays enabled, and password sign-in stays on
// while any account has MFA.
func (a *Auth) UpdateSettings(ctx context.Context, input map[string]any) (Settings, error) {
	version, isInt := js.Integer(input["version"])
	values, _ := input["values"].(map[string]any)
	password, okP := values["passwordLogin"].(bool)
	email, okE := values["emailCodeLogin"].(bool)
	if !isInt || !okP || !okE || !password && !email {
		return Settings{}, apperr.BadRequest("At least one sign-in method must remain enabled")
	}
	if !password {
		// Every page of the MFA partition: one enabled account is enough to refuse.
		for cursor := ""; ; {
			page, err := a.store.List(ctx, "MFA", cursor)
			if err != nil {
				return Settings{}, err
			}
			for _, row := range page.Items {
				if js.Truthy(row.Data["enabled"]) {
					return Settings{}, apperr.New(http.StatusConflict, "Password sign-in is required for accounts with MFA")
				}
			}
			if cursor = page.Cursor; cursor == "" {
				break
			}
		}
	}
	row, err := a.store.Get(ctx, "SETTINGS", "auth")
	if err != nil {
		return Settings{}, err
	}
	stored, expected := 0, (*int)(nil)
	if row != nil {
		stored, expected = row.Version, nosql.Expect(row.Version)
	}
	if version != float64(stored) {
		return Settings{}, apperr.Conflict()
	}
	err = a.store.Transact(ctx, []nosql.Write{{Row: nosql.Row{PK: "SETTINGS", SK: "auth", Version: stored + 1,
		Data: map[string]any{"passwordLogin": password, "emailCodeLogin": email}}, Expected: expected}})
	if err != nil {
		return Settings{}, err
	}
	return a.Settings(ctx)
}
