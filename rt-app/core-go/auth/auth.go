// Package auth is local RT-App authentication over package users: password sign-in, emailed
// codes (sign-in, password reset, email change), rate limits, JWT sessions, sign-in settings
// and TOTP MFA with sealed secrets. It is the Go port of @gsalgadotoledo/rt-app-auth without
// external identity providers; rows and HMAC keys are interchangeable with the TypeScript and
// Python ports. See rt-app/spec/contracts/auth.contract.yaml.
package auth

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"math/big"
	"net/http"
	"strconv"
	"strings"
	"time"

	"rt.local/core-go/apperr"
	"rt.local/core-go/internal/js"
	"rt.local/core-go/jwt"
	"rt.local/core-go/nosql"
	"rt.local/core-go/users"
	"rt.local/core-go/web"
)

// Durations of the flows, in milliseconds as stored in rows.
const (
	codeTTLMs      = 600000 // emailed codes
	challengeTTLMs = 300000 // pending MFA challenges
	maxAttempts    = 5      // wrong codes before a challenge locks
	limitRetries   = 8      // version conflicts tolerated by Limit
	sessionSeconds = 900
)

// Client-facing messages shared by several flows.
const (
	msgCodeSent        = "If the account supports this method, you will receive a code."
	msgInvalidCode     = "Invalid code"
	msgExpiredCode     = "Invalid or expired code"
	msgInvalidSession  = "Invalid session"
	msgTooMany         = "Too many attempts; wait one minute"
	msgWrongCredential = "Incorrect email or password"
)

// dummyHash is verified when the user is missing, so unknown emails cost the same work.
var dummyHash = "scrypt$" + strings.Repeat("0", 32) + "$" + strings.Repeat("00", 64)

// Session is a signed-in session.
type Session struct {
	Token     string         `json:"token"`
	ExpiresIn int            `json:"expiresIn"`
	User      map[string]any `json:"user"`
}

// Pending is a challenge the user must complete before a session is issued.
type Pending struct {
	Challenge   string `json:"challenge"`
	ChallengeID string `json:"challengeId"`
}

// LoginResult is either a Session or, for accounts with MFA, a Pending TOTP challenge.
type LoginResult struct {
	*Session
	*Pending
}

// Reply is a plain confirmation.
type Reply struct {
	Message        string `json:"message"`
	Reauthenticate bool   `json:"reauthenticate,omitempty"`
}

// CodeResult is what Consume returns: a Session (sign-in) or a Reply (password reset).
type CodeResult struct {
	*Session
	Message string `json:"message,omitempty"`
}

// Auth authenticates the accounts of a users.Users. It is safe for concurrent use.
type Auth struct {
	users  *users.Users
	store  nosql.Store
	tokens *jwt.Tokens
	mail   Mailer
	secret []byte
	vault  *Vault
	now    func() time.Time
}

// Option configures Auth.
type Option func(*Auth)

// WithClock sets the clock of rate-limit windows, code and challenge expiry and TOTP steps
// (default time.Now). Give the JWT signer the same clock.
func WithClock(now func() time.Time) Option { return func(a *Auth) { a.now = now } }

// New returns Auth over accounts, signing sessions with tokens and mailing codes with mail.
// secret is the application secret: it keys every HMAC and the vault.
func New(accounts *users.Users, tokens *jwt.Tokens, mail Mailer, secret string, options ...Option) *Auth {
	a := &Auth{users: accounts, store: accounts.Store(), tokens: tokens, mail: mail, secret: []byte(secret), vault: NewVault(secret), now: time.Now}
	for _, option := range options {
		option(a)
	}
	return a
}

func (a *Auth) nowMs() int64 { return a.now().UnixMilli() }

// digest is hex(HMAC-SHA256(secret, text)), the key of CHALLENGE and RATE rows and of code hashes.
func (a *Auth) digest(text string) string {
	mac := hmac.New(sha256.New, a.secret)
	mac.Write([]byte(text))
	return hex.EncodeToString(mac.Sum(nil))
}

// Limit counts one attempt for key in the current minute and refuses the attempt (429) once
// max were counted. Rows: RATE/digest("<key>:<minute>") {count}, ttl two minutes.
func (a *Auth) Limit(ctx context.Context, key string, max int) error {
	now := a.nowMs()
	sk := a.digest(key + ":" + strconv.FormatInt(floorDiv(now, 60000), 10))
	for range limitRetries {
		row, err := a.store.Get(ctx, "RATE", sk)
		if err != nil {
			return err
		}
		count, version, expected := 0.0, 1, (*int)(nil)
		if row != nil {
			if v := row.Data["count"]; v != nil {
				count = js.Number(v, true)
			}
			version, expected = row.Version+1, nosql.Expect(row.Version)
		}
		if count >= float64(max) {
			return apperr.New(http.StatusTooManyRequests, msgTooMany)
		}
		ttl := floorDiv(now, 1000) + 120
		err = a.store.Transact(ctx, []nosql.Write{{Row: nosql.Row{PK: "RATE", SK: sk, Version: version, TTL: &ttl, Data: map[string]any{"count": count + 1}}, Expected: expected}})
		if err == nil {
			return nil
		}
		if !apperr.IsConflict(err) {
			return err
		}
	}
	return apperr.New(http.StatusTooManyRequests, "Too many simultaneous attempts")
}

// Actor resolves an Authorization header: "" is anonymous (nil); otherwise it must be
// "Bearer <jwt>" for an active user whose tokenVersion matches the token, or 401. The result
// is the public actor {id, email, name, role, grants, tokenVersion, active}.
func (a *Auth) Actor(ctx context.Context, header string) (map[string]any, error) {
	row, err := a.sessionUser(ctx, header)
	if err != nil || row == nil {
		return nil, err
	}
	return users.PublicUser(row.Data), nil
}

// Authenticate is a web.Authenticator that resolves the session of r's Authorization header.
func (a *Auth) Authenticate(r *http.Request) (*web.Actor, error) {
	row, err := a.sessionUser(r.Context(), r.Header.Get("Authorization"))
	if err != nil || row == nil {
		return nil, err
	}
	return users.Actor(row.Data), nil
}

func (a *Auth) sessionUser(ctx context.Context, header string) (*nosql.Row, error) {
	if header == "" {
		return nil, nil
	}
	token, ok := strings.CutPrefix(header, "Bearer ")
	if !ok {
		return nil, apperr.New(http.StatusUnauthorized, "Invalid token")
	}
	claims, err := a.tokens.Verify(token)
	if err != nil {
		return nil, err
	}
	row, err := a.users.Get(ctx, claims.ID)
	if err != nil {
		return nil, err
	}
	if row == nil || !js.Truthy(row.Data["active"]) || !js.Equal(row.Data["tokenVersion"], float64(claims.Version)) || !localProvider(row.Data) {
		return nil, apperr.New(http.StatusUnauthorized, msgInvalidSession)
	}
	return row, nil
}

// localProvider: accounts of an external identity provider cannot use local sessions.
func localProvider(data map[string]any) bool {
	provider, present := data["credentialProvider"]
	return !present || provider == nil || provider == "local"
}

func (a *Auth) session(row *nosql.Row) (*Session, error) {
	id, ok := row.Data["id"].(string)
	version, isInt := js.Integer(row.Data["tokenVersion"])
	if !ok || !isInt {
		return nil, errors.New("auth: user row needs a string id and an integer tokenVersion")
	}
	token := a.tokens.Issue(jwt.User{ID: id, TokenVersion: int(version)})
	return &Session{Token: token, ExpiresIn: sessionSeconds, User: users.ViewUser(row.Data)}, nil
}

// Login signs in with a password (emails are already normalized). Unknown, inactive and
// wrong credentials are the same 401; accounts with MFA get a Pending TOTP challenge.
func (a *Auth) Login(ctx context.Context, email string, password any, ip string) (LoginResult, error) {
	settings, err := a.Settings(ctx)
	if err != nil {
		return LoginResult{}, err
	}
	if !js.Truthy(settings.Values["passwordLogin"]) {
		return LoginResult{}, apperr.New(http.StatusForbidden, "Password sign-in is disabled")
	}
	if err := a.limits(ctx, rate{"login-ip:" + ip, 30}, rate{"login:" + email, 8}); err != nil {
		return LoginResult{}, err
	}
	row, err := a.users.ByEmail(ctx, email)
	if err != nil {
		return LoginResult{}, err
	}
	stored := dummyHash
	if row != nil {
		if stored, err = passwordHash(row.Data); err != nil {
			return LoginResult{}, err
		}
	}
	valid, err := users.VerifyPassword(password, stored)
	if err != nil {
		return LoginResult{}, err
	}
	if row == nil || !js.Truthy(row.Data["active"]) || !valid {
		return LoginResult{}, apperr.New(http.StatusUnauthorized, msgWrongCredential)
	}
	mfa, err := a.HasMFA(ctx, js.String(row.Data["id"]))
	if err != nil {
		return LoginResult{}, err
	}
	if mfa {
		pending, err := a.pending(ctx, row, "totp", map[string]any{})
		return LoginResult{Pending: pending}, err
	}
	session, err := a.session(row)
	return LoginResult{Session: session}, err
}

// passwordHash is the stored hash, or the dummy hash for accounts without one.
func passwordHash(data map[string]any) (string, error) {
	switch v := data["passwordHash"].(type) {
	case nil:
		return dummyHash, nil
	case string:
		return v, nil
	default:
		return "", errors.New("auth: passwordHash is not a string")
	}
}

// rate is one rate limit: at most max attempts per minute for key.
type rate struct {
	key string
	max int
}

// limits applies the rate limits in order.
func (a *Auth) limits(ctx context.Context, rates ...rate) error {
	for _, r := range rates {
		if err := a.Limit(ctx, r.key, r.max); err != nil {
			return err
		}
	}
	return nil
}

// Issue emails a six-digit code for purpose "login" or "reset" to an active account (for
// login, only one without MFA). The reply never reveals whether the account exists.
func (a *Auth) Issue(ctx context.Context, email, purpose, ip string) (Reply, error) {
	reply := Reply{Message: msgCodeSent}
	if purpose == "login" {
		if err := a.emailCodeGate(ctx); err != nil {
			return Reply{}, err
		}
	}
	if err := a.limits(ctx, rate{"mail-ip:" + ip, 20}, rate{"mail:" + email, 3}); err != nil {
		return Reply{}, err
	}
	user, err := a.users.ByEmail(ctx, email)
	if err != nil || user == nil || !js.Truthy(user.Data["active"]) {
		return reply, err
	}
	if purpose == "login" {
		if mfa, err := a.HasMFA(ctx, js.String(user.Data["id"])); err != nil || mfa {
			return reply, err
		}
	}
	code := newCode()
	sk := a.digest(purpose + ":" + email)
	now := a.nowMs()
	err = a.replaceChallenge(ctx, sk, now, map[string]any{
		"userId": user.Data["id"], "hash": a.digest(purpose + ":" + email + ":" + code), "attempts": 0, "used": false,
		"expires": now + codeTTLMs, "tokenVersion": user.Data["tokenVersion"]})
	if err != nil {
		return Reply{}, err
	}
	return reply, a.mail.SendCode(ctx, email, code, purpose)
}

// replaceChallenge writes CHALLENGE/sk over any previous one (version+1), ttl ten minutes.
func (a *Auth) replaceChallenge(ctx context.Context, sk string, now int64, data map[string]any) error {
	old, err := a.store.Get(ctx, "CHALLENGE", sk)
	if err != nil {
		return err
	}
	version, expected := 1, (*int)(nil)
	if old != nil {
		version, expected = old.Version+1, nosql.Expect(old.Version)
	}
	ttl := floorDiv(now, 1000) + codeTTLMs/1000
	return a.store.Transact(ctx, []nosql.Write{{Row: nosql.Row{PK: "CHALLENGE", SK: sk, Version: version, TTL: &ttl, Data: data}, Expected: expected}})
}

func (a *Auth) emailCodeGate(ctx context.Context) error {
	settings, err := a.Settings(ctx)
	if err != nil {
		return err
	}
	if !js.Truthy(settings.Values["emailCodeLogin"]) {
		return apperr.New(http.StatusForbidden, "Email code sign-in is disabled")
	}
	return nil
}

// newCode is a uniform random integer in [100000, 999999] as text.
func newCode() string {
	n, err := rand.Int(rand.Reader, big.NewInt(900000))
	if err != nil {
		panic(err) // crypto/rand never fails
	}
	return strconv.FormatInt(n.Int64()+100000, 10)
}

// Consume checks an emailed code. For "login" it returns a Session (403 for accounts with
// MFA, leaving the code unused); for "reset" it validates and stores password, revokes
// sessions and returns a Reply. Wrong codes count as attempts; five lock the challenge.
func (a *Auth) Consume(ctx context.Context, email string, code any, purpose, ip string, password any) (CodeResult, error) {
	if purpose == "login" {
		if err := a.emailCodeGate(ctx); err != nil {
			return CodeResult{}, err
		}
	}
	if err := a.limits(ctx, rate{"verify-ip:" + ip, 30}, rate{"verify:" + email, 8}); err != nil {
		return CodeResult{}, err
	}
	s, ok := code.(string)
	if !ok || !sixDigits(s) {
		return CodeResult{}, apperr.BadRequest(msgInvalidCode)
	}
	row, err := a.openChallenge(ctx, a.digest(purpose+":"+email), func(*nosql.Row) string { return a.digest(purpose + ":" + email + ":" + s) })
	if err != nil {
		return CodeResult{}, err
	}
	user, err := a.userOf(ctx, row.Data["userId"])
	if err != nil {
		return CodeResult{}, err
	}
	if user == nil || !js.Truthy(user.Data["active"]) || !js.Equal(user.Data["tokenVersion"], row.Data["tokenVersion"]) {
		return CodeResult{}, apperr.BadRequest(msgExpiredCode)
	}
	consumed := markUsed(row)
	if purpose == "reset" {
		hash, err := users.HashPassword(password)
		if err != nil {
			return CodeResult{}, err
		}
		next := *user
		next.Version++
		next.Data = users.With(user.Data, map[string]any{"passwordHash": hash, "tokenVersion": js.Add(user.Data["tokenVersion"], 1)})
		if err := a.store.Transact(ctx, []nosql.Write{consumed, {Row: next, Expected: nosql.Expect(user.Version)}}); err != nil {
			return CodeResult{}, err
		}
		return CodeResult{Message: "Password updated. Sign in to continue."}, nil
	}
	mfa, err := a.HasMFA(ctx, js.String(user.Data["id"]))
	if err != nil {
		return CodeResult{}, err
	}
	if mfa {
		return CodeResult{}, apperr.New(http.StatusForbidden, "Use your password and authenticator")
	}
	if err := a.store.Transact(ctx, []nosql.Write{consumed}); err != nil {
		return CodeResult{}, err
	}
	session, err := a.session(user)
	return CodeResult{Session: session}, err
}

// openChallenge reads CHALLENGE/sk and checks the code whose digest is want: missing, used,
// expired and locked challenges and wrong codes are 400 "Invalid or expired code"; a wrong
// code also counts an attempt.
func (a *Auth) openChallenge(ctx context.Context, sk string, want func(*nosql.Row) string) (*nosql.Row, error) {
	row, err := a.store.Get(ctx, "CHALLENGE", sk)
	if err != nil {
		return nil, err
	}
	if row == nil || js.Truthy(row.Data["used"]) || js.Field(row.Data, "expires") < float64(a.nowMs()) || js.Field(row.Data, "attempts") >= maxAttempts {
		return nil, apperr.BadRequest(msgExpiredCode)
	}
	stored, got := looseHex(js.String(row.Data["hash"])), looseHex(want(row))
	if len(stored) != len(got) {
		return nil, errors.New("auth: stored code hash has the wrong length")
	}
	if !hmac.Equal(stored, got) {
		next := *row
		next.Version++
		next.Data = users.With(row.Data, map[string]any{"attempts": js.Add(row.Data["attempts"], 1)})
		if err := a.store.Transact(ctx, []nosql.Write{{Row: next, Expected: nosql.Expect(row.Version)}}); err != nil {
			return nil, err
		}
		return nil, apperr.BadRequest(msgExpiredCode)
	}
	return row, nil
}

// markUsed is the version-guarded write that marks a challenge used.
func markUsed(row *nosql.Row) nosql.Write {
	next := *row
	next.Version++
	next.Data = users.With(row.Data, map[string]any{"used": true})
	return nosql.Write{Row: next, Expected: nosql.Expect(row.Version)}
}

// userOf returns the user a row points to (nil when the id is not a string or is missing).
func (a *Auth) userOf(ctx context.Context, id any) (*nosql.Row, error) {
	s, ok := id.(string)
	if !ok {
		return nil, nil
	}
	return a.users.Get(ctx, s)
}

// RequestEmailChange mails a code to a new, unused address of an active account.
func (a *Auth) RequestEmailChange(ctx context.Context, userID, email, ip string) (Reply, error) {
	if err := a.limits(ctx, rate{"email-change-ip:" + ip, 10}, rate{"email-change:" + userID, 3}); err != nil {
		return Reply{}, err
	}
	taken, err := a.users.ByEmail(ctx, email)
	if err != nil {
		return Reply{}, err
	}
	if taken != nil {
		return Reply{}, apperr.BadRequest("This email address cannot be used")
	}
	user, err := a.users.Get(ctx, userID)
	if err != nil {
		return Reply{}, err
	}
	if user == nil || !js.Truthy(user.Data["active"]) {
		return Reply{}, apperr.New(http.StatusUnauthorized, msgInvalidSession)
	}
	code, now := newCode(), a.nowMs()
	err = a.replaceChallenge(ctx, a.digest("email-change:"+userID), now, map[string]any{
		"email": email, "userId": userID, "hash": a.digest("email-change:" + userID + ":" + email + ":" + code),
		"used": false, "attempts": 0, "expires": now + codeTTLMs, "tokenVersion": user.Data["tokenVersion"]})
	if err != nil {
		return Reply{}, err
	}
	if err := a.mail.SendCode(ctx, email, code, "email-change"); err != nil {
		return Reply{}, err
	}
	return Reply{Message: "We sent a code to the new email address."}, nil
}

// ConfirmEmailChange applies a requested email change with its code: the challenge is used,
// the user gets the new email and tokenVersion+1, and the EMAIL index moves, atomically.
func (a *Auth) ConfirmEmailChange(ctx context.Context, userID string, code any, ip string) (*Session, error) {
	if err := a.limits(ctx, rate{"email-confirm:" + userID, 8}, rate{"email-confirm-ip:" + ip, 20}); err != nil {
		return nil, err
	}
	s, ok := code.(string)
	if !ok || !sixDigits(s) {
		return nil, apperr.BadRequest(msgInvalidCode)
	}
	row, err := a.openChallenge(ctx, a.digest("email-change:"+userID), func(row *nosql.Row) string {
		return a.digest("email-change:" + userID + ":" + js.String(row.Data["email"]) + ":" + s)
	})
	if err != nil {
		return nil, err
	}
	user, err := a.users.Get(ctx, userID)
	if err != nil {
		return nil, err
	}
	if user == nil || !js.Truthy(user.Data["active"]) || !js.Equal(user.Data["tokenVersion"], row.Data["tokenVersion"]) {
		return nil, apperr.New(http.StatusUnauthorized, msgInvalidSession)
	}
	index, err := a.store.Get(ctx, "EMAIL", js.String(user.Data["email"]))
	if err != nil {
		return nil, err
	}
	if index == nil {
		return nil, errors.New("Email index missing")
	}
	newEmail := js.String(row.Data["email"])
	updated := *user
	updated.Version++
	updated.Data = users.With(user.Data, map[string]any{"email": row.Data["email"], "tokenVersion": js.Add(user.Data["tokenVersion"], 1)})
	err = a.store.Transact(ctx, []nosql.Write{
		markUsed(row),
		{Row: updated, Expected: nosql.Expect(user.Version)},
		{Row: *index, Expected: nosql.Expect(index.Version), Delete: true},
		{Row: nosql.Row{PK: "EMAIL", SK: newEmail, Version: 1, Data: map[string]any{"id": userID}}},
	})
	if err != nil {
		return nil, err
	}
	return a.session(&updated)
}

// looseHex decodes like Node's Buffer.from(s, "hex"): byte pairs until the first invalid one.
func looseHex(s string) []byte {
	out := make([]byte, 0, len(s)/2)
	for i := 0; i+1 < len(s); i += 2 {
		b, err := hex.DecodeString(s[i : i+2])
		if err != nil {
			break
		}
		out = append(out, b[0])
	}
	return out
}
