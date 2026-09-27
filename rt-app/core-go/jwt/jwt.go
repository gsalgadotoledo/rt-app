// Package jwt issues and verifies the stateless 15-minute RT-App session tokens (HS256).
//
// Tokens are byte-identical to the TypeScript reference (jose): the header is exactly
// {"alg":"HS256","typ":"JWT"} and the payload {"v","sub","iss","aud","iat","exp"} in that key
// order ({"v","sid","sub",...} for tokens tied to a refresh session), compact JSON, base64url
// without padding. Verification follows the jose defaults the
// reference uses; see rt-app/spec/contracts/jwt.contract.yaml.
package jwt

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"rt.local/core-go/apperr"
)

// Defaults of the reference implementation.
const (
	DefaultIssuer   = "rt-app"
	DefaultAudience = "rt-app-api"
	// Lifetime of an issued session.
	Lifetime = 900 * time.Second
)

// ErrShortSecret is returned by New when the secret has fewer than 32 UTF-8 bytes.
var ErrShortSecret = errors.New("JWT_SECRET must contain at least 32 bytes")

// header is the exact protected header of issued tokens.
const header = `{"alg":"HS256","typ":"JWT"}`

// User is what a session token carries: the user id (sub) and the token version (v) that
// lets the server revoke every session of a user by bumping it. A non-empty SID ties the
// token to a refresh session (the sid claim, right after v); "" issues a token without it.
type User struct {
	ID           string
	TokenVersion int
	SID          string
}

// Claims are the verified contents of a session token. SID is the refresh session of tokens
// that carry a sid claim ("" otherwise).
type Claims struct {
	ID      string `json:"id"`
	Version int    `json:"version"`
	SID     string `json:"sid,omitempty"`
}

// Tokens issues and verifies session tokens. It is safe for concurrent use.
type Tokens struct {
	key      []byte
	issuer   string
	audience string
	now      func() time.Time
}

// Option configures Tokens.
type Option func(*Tokens)

// WithIssuer changes the iss claim (default DefaultIssuer).
func WithIssuer(issuer string) Option { return func(t *Tokens) { t.issuer = issuer } }

// WithAudience changes the aud claim (default DefaultAudience).
func WithAudience(audience string) Option { return func(t *Tokens) { t.audience = audience } }

// WithClock sets the clock used for iat/exp and expiry checks (default time.Now).
func WithClock(now func() time.Time) Option { return func(t *Tokens) { t.now = now } }

// New returns Tokens keyed with the UTF-8 bytes of secret, which needs at least 32 bytes.
func New(secret string, options ...Option) (*Tokens, error) {
	if len(secret) < 32 {
		return nil, ErrShortSecret
	}
	t := &Tokens{key: []byte(secret), issuer: DefaultIssuer, audience: DefaultAudience, now: time.Now}
	for _, option := range options {
		option(t)
	}
	return t, nil
}

// Issue signs a session for user valid for Lifetime from now (whole seconds). Without a SID
// the token is byte-identical to earlier releases.
func (t *Tokens) Issue(user User) string {
	now := t.now().UnixMilli()
	iat := floorDiv(now, 1000)
	var payload strings.Builder
	payload.WriteString(`{"v":`)
	payload.WriteString(strconv.Itoa(user.TokenVersion))
	if user.SID != "" {
		payload.WriteString(`,"sid":`)
		payload.WriteString(quote(user.SID))
	}
	payload.WriteString(`,"sub":`)
	payload.WriteString(quote(user.ID))
	payload.WriteString(`,"iss":`)
	payload.WriteString(quote(t.issuer))
	payload.WriteString(`,"aud":`)
	payload.WriteString(quote(t.audience))
	payload.WriteString(`,"iat":`)
	payload.WriteString(strconv.FormatInt(iat, 10))
	payload.WriteString(`,"exp":`)
	payload.WriteString(strconv.FormatInt(iat+int64(Lifetime/time.Second), 10))
	payload.WriteString(`}`)
	input := b64(header) + "." + b64(payload.String())
	return input + "." + base64.RawURLEncoding.EncodeToString(t.sign(input))
}

// Verify checks token (the bare compact JWS, without "Bearer ") and returns its claims.
// A sid claim that is not a non-empty string is invalid. Every failure is the same 401
// "Invalid or expired session", so no detail leaks.
func (t *Tokens) Verify(token string) (Claims, error) {
	claims, ok := t.verify(token)
	if !ok {
		return Claims{}, apperr.New(http.StatusUnauthorized, "Invalid or expired session")
	}
	return claims, nil
}

func (t *Tokens) sign(input string) []byte {
	mac := hmac.New(sha256.New, t.key)
	mac.Write([]byte(input))
	return mac.Sum(nil)
}

// verify applies jose's compact JWS and JWT claim checks with the options of the reference:
// algorithms [HS256], issuer, audience, required exp/iat/sub, no clock tolerance.
func (t *Tokens) verify(token string) (Claims, bool) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return Claims{}, false
	}
	protected, ok := decodeObject(parts[0])
	if !ok || !validCrit(protected) {
		return Claims{}, false
	}
	if alg, _ := protected["alg"].(string); alg != "HS256" {
		return Claims{}, false
	}
	// The signing input is the received text; jose refuses non-ASCII there.
	if !isASCII(parts[0]) || !isASCII(parts[1]) {
		return Claims{}, false
	}
	signature, ok := decodeBase64URL(parts[2])
	if !ok || !hmac.Equal(signature, t.sign(parts[0]+"."+parts[1])) {
		return Claims{}, false
	}
	payload, ok := decodeObject(parts[1])
	if !ok {
		return Claims{}, false
	}
	for _, claim := range []string{"exp", "iat", "sub", "aud", "iss"} {
		if _, present := payload[claim]; !present {
			return Claims{}, false
		}
	}
	if iss, ok := payload["iss"].(string); !ok || iss != t.issuer {
		return Claims{}, false
	}
	if !hasAudience(payload["aud"], t.audience) {
		return Claims{}, false
	}
	now := float64(floorDiv(t.now().UnixMilli(), 1000))
	if _, ok := number(payload["iat"]); !ok {
		return Claims{}, false
	}
	if raw, present := payload["nbf"]; present {
		nbf, ok := number(raw)
		if !ok || nbf > now {
			return Claims{}, false
		}
	}
	exp, ok := number(payload["exp"])
	if !ok || exp <= now {
		return Claims{}, false
	}
	// The reference's own checks: a truthy sub and an integer v.
	sub, _ := payload["sub"].(string)
	v, ok := number(payload["v"])
	if sub == "" || !ok || v != math.Trunc(v) || math.Abs(v) > 1<<53 {
		return Claims{}, false
	}
	// A sid claim, wherever it appears, must be a non-empty string.
	claims := Claims{ID: sub, Version: int(v)}
	if raw, present := payload["sid"]; present {
		sid, ok := raw.(string)
		if !ok || sid == "" {
			return Claims{}, false
		}
		claims.SID = sid
	}
	return claims, true
}

// validCrit applies jose's "crit" rules: only "b64" is recognized, it must be present and
// integrity protected, and a JWT must use the encoded payload (b64 true).
func validCrit(protected map[string]any) bool {
	raw, present := protected["crit"]
	if !present {
		return true
	}
	list, ok := raw.([]any)
	if !ok || len(list) == 0 {
		return false
	}
	for _, item := range list {
		if name, ok := item.(string); !ok || name != "b64" {
			return false
		}
	}
	b64, ok := protected["b64"].(bool)
	return ok && b64
}

func hasAudience(aud any, audience string) bool {
	switch v := aud.(type) {
	case string:
		return v == audience
	case []any:
		for _, item := range v {
			if s, ok := item.(string); ok && s == audience {
				return true
			}
		}
	}
	return false
}

// number reports a JSON number; out-of-range literals are ±Inf, as in JavaScript.
func number(v any) (float64, bool) {
	n, ok := v.(json.Number)
	if !ok {
		return 0, false
	}
	f, err := strconv.ParseFloat(string(n), 64)
	if err != nil && !math.IsInf(f, 0) {
		return 0, false
	}
	return f, true
}

// decodeObject decodes a base64url segment holding a JSON object in strict UTF-8.
func decodeObject(segment string) (map[string]any, bool) {
	raw, ok := decodeBase64URL(segment)
	if !ok || !utf8.Valid(raw) {
		return nil, false
	}
	raw = bytes.TrimPrefix(raw, []byte("\xef\xbb\xbf")) // TextDecoder drops a leading BOM
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var object map[string]any
	if err := dec.Decode(&object); err != nil || object == nil {
		return nil, false
	}
	var extra any
	if dec.Decode(&extra) != io.EOF { // JSON.parse refuses trailing text
		return nil, false
	}
	return object, true
}

// decodeBase64URL follows jose's decoder: the base64url alphabet only, ASCII whitespace
// ignored, padding optional.
func decodeBase64URL(s string) ([]byte, bool) {
	s = strings.Map(func(r rune) rune {
		if r == ' ' || r == '\t' || r == '\n' || r == '\f' || r == '\r' {
			return -1
		}
		return r
	}, s)
	if strings.HasSuffix(s, "=") {
		if len(s)%4 != 0 {
			return nil, false
		}
		s = strings.TrimSuffix(strings.TrimSuffix(s, "="), "=")
	}
	if len(s)%4 == 1 {
		return nil, false
	}
	out, err := base64.RawURLEncoding.DecodeString(s)
	return out, err == nil
}

func b64(s string) string { return base64.RawURLEncoding.EncodeToString([]byte(s)) }

func isASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] > 0x7f {
			return false
		}
	}
	return true
}

func floorDiv(a, b int64) int64 {
	q := a / b
	if a%b != 0 && (a < 0) != (b < 0) {
		q--
	}
	return q
}

// quote encodes s like JavaScript's JSON.stringify (no HTML or U+2028 escaping).
func quote(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 0x20 {
				b.WriteString(`\u00`)
				b.WriteByte("0123456789abcdef"[r>>4])
				b.WriteByte("0123456789abcdef"[r&0xf])
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}
