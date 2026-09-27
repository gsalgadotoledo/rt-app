package auth

// Refresh sessions: opaque rotating refresh tokens behind 15-minute access JWTs. The row
// formats are shared with the TypeScript and Python ports (rt-app/docs/polyglot/auth-sessions.md,
// spec/contracts/auth-sessions.contract.yaml); change them only together with the contract.

import (
	"cmp"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"encoding/base64"
	"math"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"time"

	"rt.local/core-go/apperr"
	"rt.local/core-go/internal/js"
	"rt.local/core-go/nosql"
	"rt.local/core-go/users"
)

const (
	// SessionTTL is the default absolute session lifetime: 4 days from sign-in.
	SessionTTL = 4 * 24 * time.Hour
	// RefreshGrace is how long the immediately previous refresh token stays usable after a
	// rotation (two tabs refreshing at once).
	RefreshGrace = 30 * time.Second
	// SessionIndex is the pointer partition: SESSION/<sessionId> → {userId}.
	SessionIndex = "SESSION"
	// sessionAttempts bounds the version-conflict retries of rotation and revocation.
	sessionAttempts = 4
)

// refreshToken is "<sessionId>.<secret>": 16 and 32 random bytes, base64url without padding.
var refreshToken = regexp.MustCompile(`^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$`)

// SessionPartition is the partition holding one user's sessions: SESSIONS#<userId>.
func SessionPartition(userID string) string { return "SESSIONS#" + userID }

// WithSessionTTL sets the absolute refresh-session lifetime from sign-in (default SessionTTL).
func WithSessionTTL(ttl time.Duration) Option { return func(a *Auth) { a.sessionTTL = ttl } }

// WithRefreshGrace sets the reuse window of the previous refresh token (default RefreshGrace).
func WithRefreshGrace(grace time.Duration) Option { return func(a *Auth) { a.refreshGrace = grace } }

// SessionItem is one entry of the session list (GET /auth/sessions). It never holds secrets.
type SessionItem struct {
	ID         string `json:"id"`
	CreatedAt  string `json:"createdAt"`
	LastUsedAt string `json:"lastUsedAt"`
	ExpiresAt  string `json:"expiresAt"`
	Current    bool   `json:"current"`
	IP         any    `json:"ip"`
	UserAgent  any    `json:"userAgent"`
}

// SessionList is the response of GET /auth/sessions.
type SessionList struct {
	Items []SessionItem `json:"items"`
}

// OK is the {ok: true} reply.
type OK struct {
	OK bool `json:"ok"`
}

// issued is a newly created or rotated refresh token.
type issued struct {
	sessionID string
	token     string
	expiresAt int64 // epoch ms
}

// clientText keeps printable ASCII only (U+0020–U+007E) and the first max characters; an
// empty result is nil (JSON null).
func clientText(value string, max int) any {
	text := strings.Map(func(r rune) rune {
		if r < 0x20 || r > 0x7e {
			return -1
		}
		return r
	}, value)
	if len(text) > max {
		text = text[:max]
	}
	if text == "" {
		return nil
	}
	return text
}

// parseRefreshToken splits a refresh token into its session id and secret.
func parseRefreshToken(token any) (sessionID, secret string, ok bool) {
	s, isString := token.(string)
	if !isString {
		return "", "", false
	}
	match := refreshToken.FindStringSubmatch(s)
	if match == nil {
		return "", "", false
	}
	return match[1], match[2], true
}

// sessionLive: not revoked and now < expiresAt (expiresAt <= now is expired).
func sessionLive(row *nosql.Row, now int64) bool {
	return row != nil && row.Data["revokedAt"] == nil && float64(now) < js.Field(row.Data, "expiresAt")
}

// randomText is base64url_nopad of n random bytes.
func randomText(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err) // crypto/rand never fails
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// refreshHash is digest("refresh:<sessionId>:<secret>").
func (a *Auth) refreshHash(sessionID, secret string) string {
	return a.digest("refresh:" + sessionID + ":" + secret)
}

// hashMatches compares a stored hash with a presented one in constant time.
func hashMatches(stored any, presented string) bool {
	s, ok := stored.(string)
	return ok && len(s) == len(presented) && hmac.Equal([]byte(s), []byte(presented))
}

// createSession starts a refresh session for a user who just signed in: the session row and
// its pointer, in one transaction, both expiring (TTL) at the absolute expiry.
func (a *Auth) createSession(ctx context.Context, user *nosql.Row, ip, userAgent string) (issued, error) {
	now := a.nowMs()
	sessionID, secret := randomText(16), randomText(32)
	expiresAt := now + a.sessionTTL.Milliseconds()
	ttl := floorDiv(expiresAt, 1000)
	userID := user.Data["id"]
	row := nosql.Row{PK: SessionPartition(js.String(userID)), SK: sessionID, Version: 1, TTL: &ttl, Data: map[string]any{
		"userId": userID, "provider": providerLocal, "tokenVersion": user.Data["tokenVersion"],
		"secretHash": a.refreshHash(sessionID, secret), "previousHash": nil,
		"rotatedAt": now, "createdAt": now, "lastUsedAt": now, "expiresAt": expiresAt,
		"revokedAt": nil, "revokedReason": nil,
		"ip": clientText(ip, 64), "userAgent": clientText(userAgent, 200),
	}}
	pointerTTL := ttl
	pointer := nosql.Row{PK: SessionIndex, SK: sessionID, Version: 1, TTL: &pointerTTL, Data: map[string]any{"userId": userID}}
	if err := a.store.Transact(ctx, []nosql.Write{{Row: pointer}, {Row: row}}); err != nil {
		return issued{}, err
	}
	return issued{sessionID: sessionID, token: sessionID + "." + secret, expiresAt: expiresAt}, nil
}

// findSession reads the session row of an id through its pointer (nil when missing).
func (a *Auth) findSession(ctx context.Context, sessionID string) (*nosql.Row, error) {
	pointer, err := a.store.Get(ctx, SessionIndex, sessionID)
	if err != nil || pointer == nil {
		return nil, err
	}
	userID, ok := pointer.Data["userId"].(string)
	if !ok {
		return nil, nil
	}
	return a.store.Get(ctx, SessionPartition(userID), sessionID)
}

// writeSession is the version-guarded update of a session row (Conflict when it changed).
func (a *Auth) writeSession(ctx context.Context, row *nosql.Row, changes map[string]any) error {
	next := *row
	next.Version++
	next.Data = users.With(row.Data, changes)
	return a.store.Transact(ctx, []nosql.Write{{Row: next, Expected: nosql.Expect(row.Version)}})
}

// refreshUser returns the user of a session when it still matches: it exists, is active, has
// the session's tokenVersion and credential provider, which is this deployment's ("local").
func (a *Auth) refreshUser(ctx context.Context, session *nosql.Row) (*nosql.Row, error) {
	user, err := a.userOf(ctx, session.Data["userId"])
	if err != nil || user == nil {
		return nil, err
	}
	provider := user.Data["credentialProvider"]
	if provider == nil {
		provider = providerLocal
	}
	if user.Data["active"] != true || !js.Equal(user.Data["tokenVersion"], session.Data["tokenVersion"]) ||
		!js.Equal(provider, session.Data["provider"]) || session.Data["provider"] != providerLocal {
		return nil, nil
	}
	return user, nil
}

// Refresh rotates a refresh token (POST /auth/refresh) and returns a new access token for the
// same session and absolute expiry. Limits refresh-ip:<ip> 60, then refresh-session:<id> 10
// per minute. Every failure is 401 "Invalid session"; reusing a superseded secret (other than
// the previous one within the grace window) revokes the session ("reuse") first. Concurrent
// rotations are version-guarded: a loser re-reads and normally lands in the grace branch.
func (a *Auth) Refresh(ctx context.Context, token any, ip string) (*Session, error) {
	if err := a.Limit(ctx, "refresh-ip:"+ip, 60); err != nil {
		return nil, err
	}
	sessionID, secret, ok := parseRefreshToken(token)
	if !ok {
		return nil, apperr.New(http.StatusUnauthorized, msgInvalidSession)
	}
	if err := a.Limit(ctx, "refresh-session:"+sessionID, 10); err != nil {
		return nil, err
	}
	invalid := apperr.New(http.StatusUnauthorized, msgInvalidSession)
	presented := a.refreshHash(sessionID, secret)
	for range sessionAttempts {
		row, err := a.findSession(ctx, sessionID)
		if err != nil {
			return nil, err
		}
		now := a.nowMs()
		if !sessionLive(row, now) {
			return nil, invalid
		}
		user, err := a.refreshUser(ctx, row)
		if err != nil {
			return nil, err
		}
		if user == nil {
			return nil, invalid
		}
		var changes map[string]any
		switch {
		case hashMatches(row.Data["secretHash"], presented):
			// Normal rotation: the presented secret becomes the previous one.
			changes = map[string]any{"previousHash": row.Data["secretHash"], "rotatedAt": now}
		case hashMatches(row.Data["previousHash"], presented) && float64(now)-js.Field(row.Data, "rotatedAt") <= float64(a.refreshGrace.Milliseconds()):
			// A sibling tab raced us with the same token: another secret, same grace window.
			changes = map[string]any{}
		default:
			// A superseded or forged secret for a live session: assume theft, revoke it.
			err := a.writeSession(ctx, row, map[string]any{"revokedAt": now, "revokedReason": "reuse"})
			if apperr.IsConflict(err) {
				continue
			}
			if err != nil {
				return nil, err
			}
			return nil, invalid
		}
		next := randomText(32)
		changes["secretHash"] = a.refreshHash(sessionID, next)
		changes["lastUsedAt"] = now
		err = a.writeSession(ctx, row, changes)
		if apperr.IsConflict(err) {
			continue
		}
		if err != nil {
			return nil, err
		}
		expiresAt := js.Field(row.Data, "expiresAt")
		if math.IsNaN(expiresAt) || math.IsInf(expiresAt, 0) {
			return nil, invalid // unreachable: sessionLive needs a finite expiry
		}
		return a.respond(user, issued{sessionID: sessionID, token: sessionID + "." + next, expiresAt: int64(expiresAt)})
	}
	return nil, apperr.Conflict()
}

// Sessions lists the live sessions of a user (GET /auth/sessions) whose tokenVersion and
// provider match the user's current ones, newest first (ties by id). current marks the session
// of the calling access token.
func (a *Auth) Sessions(ctx context.Context, userID, currentSessionID string) (SessionList, error) {
	user, err := a.users.Get(ctx, userID)
	if err != nil {
		return SessionList{}, err
	}
	var version any
	if user != nil {
		version = user.Data["tokenVersion"]
	}
	now := a.nowMs()
	var rows []nosql.Row
	cursor := ""
	for {
		page, err := a.store.List(ctx, SessionPartition(userID), cursor)
		if err != nil {
			return SessionList{}, err
		}
		for _, row := range page.Items {
			if sessionLive(&row, now) && js.Equal(row.Data["tokenVersion"], version) && row.Data["provider"] == providerLocal {
				rows = append(rows, row)
			}
		}
		if cursor = page.Cursor; cursor == "" {
			break
		}
	}
	slices.SortStableFunc(rows, func(x, y nosql.Row) int {
		cx, cy := js.Field(x.Data, "createdAt"), js.Field(y.Data, "createdAt")
		if cx != cy && !math.IsNaN(cx-cy) {
			return cmp.Compare(cy, cx)
		}
		return strings.Compare(x.SK, y.SK)
	})
	items := make([]SessionItem, 0, len(rows))
	for _, row := range rows {
		items = append(items, SessionItem{
			ID: row.SK, CreatedAt: isoMs(row.Data["createdAt"]), LastUsedAt: isoMs(row.Data["lastUsedAt"]),
			ExpiresAt: isoMs(row.Data["expiresAt"]), Current: row.SK == currentSessionID,
			IP: row.Data["ip"], UserAgent: row.Data["userAgent"],
		})
	}
	return SessionList{Items: items}, nil
}

// isoMs formats stored epoch milliseconds like new Date(ms).toISOString().
func isoMs(value any) string {
	ms, _ := value.(float64)
	return users.ISOTime(time.UnixMilli(int64(ms)))
}

// RevokeSession revokes one of the user's own live sessions (DELETE /auth/sessions/:id,
// reason "revoked"). Missing, dead, foreign and outdated (tokenVersion) sessions, ids that are
// not strings and ids longer than 100 units are 404 "Session not found".
func (a *Auth) RevokeSession(ctx context.Context, userID string, sessionID any) (OK, error) {
	notFound := apperr.NotFound("Session not found")
	id, ok := sessionID.(string)
	if !ok || id == "" || js.Len(id) > 100 {
		return OK{}, notFound
	}
	user, err := a.users.Get(ctx, userID)
	if err != nil {
		return OK{}, err
	}
	row, err := a.store.Get(ctx, SessionPartition(userID), id)
	if err != nil {
		return OK{}, err
	}
	var version any
	if user != nil {
		version = user.Data["tokenVersion"]
	}
	if row == nil || !js.Equal(row.Data["tokenVersion"], version) {
		return OK{}, notFound
	}
	revoked, err := a.revokeSession(ctx, userID, id, "revoked")
	if err != nil {
		return OK{}, err
	}
	if !revoked {
		return OK{}, notFound
	}
	return OK{OK: true}, nil
}

// revokeSession marks a live session revoked with reason; false when it is missing or dead.
func (a *Auth) revokeSession(ctx context.Context, userID, sessionID, reason string) (bool, error) {
	if sessionID == "" || js.Len(sessionID) > 100 {
		return false, nil
	}
	for range sessionAttempts {
		row, err := a.store.Get(ctx, SessionPartition(userID), sessionID)
		if err != nil {
			return false, err
		}
		if !sessionLive(row, a.nowMs()) {
			return false, nil
		}
		err = a.writeSession(ctx, row, map[string]any{"revokedAt": a.nowMs(), "revokedReason": reason})
		if err == nil {
			return true, nil
		}
		if !apperr.IsConflict(err) {
			return false, err
		}
	}
	return false, apperr.Conflict()
}

// Logout signs out (POST /auth/logout). With all == true (the JSON boolean), or without a
// current session (an access token without sid), it signs out everywhere: tokenVersion + 1
// ends every session and access token of the user. Otherwise it revokes the current session
// only (reason "logout"; nothing is written when it already ended).
func (a *Auth) Logout(ctx context.Context, userID, sessionID string, all any) (OK, error) {
	if all != true && sessionID != "" {
		if _, err := a.revokeSession(ctx, userID, sessionID, "logout"); err != nil {
			return OK{}, err
		}
		return OK{OK: true}, nil
	}
	row, err := a.users.Get(ctx, userID)
	if err != nil {
		return OK{}, err
	}
	if row == nil {
		return OK{}, apperr.New(http.StatusUnauthorized, msgInvalidSession)
	}
	if err := a.store.Transact(ctx, []nosql.Write{revoke(row)}); err != nil {
		return OK{}, err
	}
	return OK{OK: true}, nil
}
