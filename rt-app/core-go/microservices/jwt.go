package microservices

import (
	"bytes"
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"math"
	"math/big"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"rt.local/core-go/apperr"
	"rt.local/core-go/jwt"
	"rt.local/core-go/web"
)

// SessionAuthenticator verifies RT-App session tokens and re-reads the actor, so revocation
// (tokenVersion), deactivation and permission changes apply at once.
type SessionAuthenticator struct {
	tokens  *jwt.Tokens
	resolve func(ctx context.Context, id string) (*web.Actor, error)
}

// NewSessionAuthenticator returns an authenticator over tokens; resolve is the authoritative
// actor lookup by id (nil, nil when the user does not exist).
func NewSessionAuthenticator(tokens *jwt.Tokens, resolve func(ctx context.Context, id string) (*web.Actor, error)) *SessionAuthenticator {
	return &SessionAuthenticator{tokens: tokens, resolve: resolve}
}

// Authenticate verifies token (401 "Invalid or expired session") and checks the current actor
// (401 "Invalid or revoked session").
func (a *SessionAuthenticator) Authenticate(ctx context.Context, token string) (*web.Actor, error) {
	claims, err := a.tokens.Verify(token)
	if err != nil {
		return nil, err
	}
	actor, err := a.resolve(ctx, claims.ID)
	if err != nil {
		return nil, err
	}
	if actor == nil || actor.ID != claims.ID || !actor.Active || actor.TokenVersion != claims.Version {
		return nil, apperr.New(http.StatusUnauthorized, "Invalid or revoked session")
	}
	return actor, nil
}

// KeySource returns the verification key for a token's protected header (alg is RS256 or
// ES256). *JWKSet, remote JWKS and KeyFunc implement it.
type KeySource interface {
	Key(ctx context.Context, header map[string]any) (crypto.PublicKey, error)
}

// KeyFunc adapts a function to KeySource; the key must be an *rsa.PublicKey (RS256) or an
// *ecdsa.PublicKey on P-256 (ES256).
type KeyFunc func(ctx context.Context, header map[string]any) (crypto.PublicKey, error)

// Key calls f.
func (f KeyFunc) Key(ctx context.Context, header map[string]any) (crypto.PublicKey, error) {
	return f(ctx, header)
}

// JWKSet is a JSON Web Key Set used as jose's createLocalJWKSet does.
type JWKSet struct {
	keys []map[string]any
}

// ErrMalformedJWKS is returned by ParseJWKS for anything but {"keys": [objects…]}.
var ErrMalformedJWKS = errors.New("JSON Web Key Set malformed")

// ParseJWKS parses a JSON Web Key Set.
func ParseJWKS(raw []byte) (*JWKSet, error) {
	var set struct {
		Keys []json.RawMessage `json:"keys"`
	}
	if err := json.Unmarshal(raw, &set); err != nil || set.Keys == nil {
		return nil, ErrMalformedJWKS
	}
	out := &JWKSet{}
	for _, item := range set.Keys {
		var key map[string]any
		if err := json.Unmarshal(item, &key); err != nil || key == nil {
			return nil, ErrMalformedJWKS
		}
		out.keys = append(out.keys, key)
	}
	return out, nil
}

var errNoKey = errors.New("no matching key")

// Key selects the single usable key for the header: kty from alg (EC keys on P-256 for ES256),
// kid equal when the token names one, jwk alg equal when present, use "sig" and key_ops with
// "verify" when present. Zero or several candidates, and private keys, are errors.
func (s *JWKSet) Key(_ context.Context, header map[string]any) (crypto.PublicKey, error) {
	alg, _ := header["alg"].(string)
	var candidates []map[string]any
	for _, jwk := range s.keys {
		if usable(jwk, alg, header) {
			candidates = append(candidates, jwk)
		}
	}
	switch len(candidates) {
	case 0:
		return nil, errNoKey
	case 1:
		return importJWK(candidates[0], alg)
	default:
		return nil, errors.New("multiple matching keys")
	}
}

func usable(jwk map[string]any, alg string, header map[string]any) bool {
	if ext, present := jwk["ext"]; present {
		if _, ok := ext.(bool); !ok {
			return false
		}
	}
	if ops, present := jwk["key_ops"]; present {
		list, ok := ops.([]any)
		if !ok {
			return false
		}
		seen, verify := map[string]bool{}, false
		for _, op := range list {
			name, ok := op.(string)
			if !ok || seen[name] {
				return false
			}
			seen[name] = true
			verify = verify || name == "verify"
		}
		if !verify {
			return false
		}
	}
	kty, _ := jwk["kty"].(string)
	switch alg {
	case "RS256":
		if kty != "RSA" {
			return false
		}
	case "ES256":
		if crv, _ := jwk["crv"].(string); kty != "EC" || crv != "P-256" {
			return false
		}
	default:
		return false
	}
	if kid, present := header["kid"]; present {
		name, ok := kid.(string)
		if jwkKid, isString := jwk["kid"].(string); !ok || !isString || name != jwkKid {
			return false
		}
	}
	if jwkAlg, present := jwk["alg"]; present && jwkAlg != alg {
		return false
	}
	if use, present := jwk["use"]; present && use != "sig" {
		return false
	}
	return true
}

func importJWK(jwk map[string]any, alg string) (crypto.PublicKey, error) {
	if _, private := jwk["d"]; private {
		return nil, errors.New("JSON Web Key Set members must be public keys")
	}
	field := func(name string) ([]byte, error) {
		text, _ := jwk[name].(string)
		raw, err := base64.RawURLEncoding.DecodeString(text)
		if err != nil || len(raw) == 0 {
			return nil, errors.New("invalid JWK " + name)
		}
		return raw, nil
	}
	if alg == "RS256" {
		n, err := field("n")
		if err != nil {
			return nil, err
		}
		e, err := field("e")
		if err != nil {
			return nil, err
		}
		exponent := new(big.Int).SetBytes(e)
		if !exponent.IsInt64() || exponent.Int64() > math.MaxInt32 {
			return nil, errors.New("invalid JWK e")
		}
		return &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: int(exponent.Int64())}, nil
	}
	x, err := field("x")
	if err != nil {
		return nil, err
	}
	y, err := field("y")
	if err != nil {
		return nil, err
	}
	if len(x) != 32 || len(y) != 32 {
		return nil, errors.New("invalid EC key")
	}
	return ecdsa.ParseUncompressedPublicKey(elliptic.P256(), append(append([]byte{4}, x...), y...))
}

// SignedJWTAuthenticator verifies service tokens signed with RS256 or ES256 (jose jwtVerify
// with requiredClaims exp, iat, sub and the configured issuer and audience), then maps the
// verified claims to an actor with resolve.
type SignedJWTAuthenticator struct {
	keys     KeySource
	issuer   string
	audience string
	resolve  func(ctx context.Context, claims map[string]any) (*web.Actor, error)
	now      func() time.Time
}

// SignedOption configures a SignedJWTAuthenticator.
type SignedOption func(*SignedJWTAuthenticator)

// WithClock sets the clock of exp/nbf checks (default time.Now).
func WithClock(now func() time.Time) SignedOption {
	return func(a *SignedJWTAuthenticator) { a.now = now }
}

// ErrIssuerAudience is returned when the issuer or the audience is empty.
var ErrIssuerAudience = errors.New("JWT issuer and audience required")

// NewSignedJWTAuthenticator returns an authenticator verifying tokens with keys.
func NewSignedJWTAuthenticator(keys KeySource, issuer, audience string, resolve func(ctx context.Context, claims map[string]any) (*web.Actor, error), options ...SignedOption) (*SignedJWTAuthenticator, error) {
	if issuer == "" || audience == "" {
		return nil, ErrIssuerAudience
	}
	a := &SignedJWTAuthenticator{keys: keys, issuer: issuer, audience: audience, resolve: resolve, now: time.Now}
	for _, option := range options {
		option(a)
	}
	return a, nil
}

// Authenticate answers 401 "Invalid service JWT" for any verification failure and 401
// "Inactive service identity" when the resolved actor is missing, inactive or another id.
func (a *SignedJWTAuthenticator) Authenticate(ctx context.Context, token string) (*web.Actor, error) {
	claims, ok := a.verify(ctx, token)
	if !ok {
		return nil, apperr.New(http.StatusUnauthorized, "Invalid service JWT")
	}
	actor, err := a.resolve(ctx, claims)
	if err != nil {
		return nil, err
	}
	sub, isString := claims["sub"].(string)
	if actor == nil || !isString || actor.ID != sub || !actor.Active {
		return nil, apperr.New(http.StatusUnauthorized, "Inactive service identity")
	}
	return actor, nil
}

func (a *SignedJWTAuthenticator) verify(ctx context.Context, token string) (map[string]any, bool) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, false
	}
	header, ok := decodeObject(parts[0])
	if !ok || !validCrit(header) {
		return nil, false
	}
	alg, _ := header["alg"].(string)
	if alg != "RS256" && alg != "ES256" {
		return nil, false
	}
	if !isASCII(parts[0]) || !isASCII(parts[1]) {
		return nil, false
	}
	key, err := a.keys.Key(ctx, header)
	if err != nil {
		return nil, false
	}
	signature, ok := decodeBase64URL(parts[2])
	if !ok {
		return nil, false
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	switch k := key.(type) {
	case *rsa.PublicKey:
		if alg != "RS256" || k.N.BitLen() < 2048 || rsa.VerifyPKCS1v15(k, crypto.SHA256, digest[:], signature) != nil {
			return nil, false
		}
	case *ecdsa.PublicKey:
		if alg != "ES256" || k.Curve != elliptic.P256() || len(signature) != 64 {
			return nil, false
		}
		r, s := new(big.Int).SetBytes(signature[:32]), new(big.Int).SetBytes(signature[32:])
		if !ecdsa.Verify(k, digest[:], r, s) {
			return nil, false
		}
	default:
		return nil, false
	}
	payload, ok := decodeObject(parts[1])
	if !ok {
		return nil, false
	}
	for _, claim := range []string{"exp", "iat", "sub", "aud", "iss"} {
		if _, present := payload[claim]; !present {
			return nil, false
		}
	}
	if iss, ok := payload["iss"].(string); !ok || iss != a.issuer {
		return nil, false
	}
	if !hasAudience(payload["aud"], a.audience) {
		return nil, false
	}
	now := float64(floorDiv(a.now().UnixMilli(), 1000))
	if _, ok := number(payload["iat"]); !ok {
		return nil, false
	}
	if raw, present := payload["nbf"]; present {
		nbf, ok := number(raw)
		if !ok || nbf > now {
			return nil, false
		}
	}
	if exp, ok := number(payload["exp"]); !ok || exp <= now {
		return nil, false
	}
	return plain(payload).(map[string]any), true
}

// validCrit applies jose's "crit" rules: a non-empty list of names, only "b64" is recognized,
// it must be present, and a JWT must use the encoded payload (b64 true).
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

// plain converts json.Number values to float64 (JavaScript numbers).
func plain(v any) any {
	switch x := v.(type) {
	case json.Number:
		f, _ := number(x)
		return f
	case map[string]any:
		for k, item := range x {
			x[k] = plain(item)
		}
		return x
	case []any:
		for i, item := range x {
			x[i] = plain(item)
		}
		return x
	}
	return v
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

// Remote JWKS caching, as jose createRemoteJWKSet: keys are kept 10 minutes, and a token
// whose key is missing triggers a refetch at most every 30 seconds.
const (
	jwksMaxAge   = 10 * time.Minute
	jwksCooldown = 30 * time.Second
	jwksTimeout  = 5 * time.Second
)

type remoteJWKS struct {
	url    string
	client *http.Client
	now    func() time.Time

	mu      sync.Mutex
	set     *JWKSet
	fetched time.Time
}

// RemoteOption configures NewRemoteJWTAuthenticator.
type RemoteJWKSOption func(*remoteJWKS)

// WithJWKSClient sets the HTTP client that fetches the key set (default: 5 s timeout,
// redirects refused).
func WithJWKSClient(client *http.Client) RemoteJWKSOption {
	return func(r *remoteJWKS) { r.client = client }
}

// Key fetches the set when it is missing or stale, and once more (after the cooldown) when
// no key matches.
func (r *remoteJWKS) Key(ctx context.Context, header map[string]any) (crypto.PublicKey, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.set == nil || r.now().Sub(r.fetched) >= jwksMaxAge {
		if err := r.reload(ctx); err != nil {
			return nil, err
		}
	}
	key, err := r.set.Key(ctx, header)
	if errors.Is(err, errNoKey) && r.now().Sub(r.fetched) >= jwksCooldown {
		if err := r.reload(ctx); err != nil {
			return nil, err
		}
		return r.set.Key(ctx, header)
	}
	return key, err
}

func (r *remoteJWKS) reload(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, jwksTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, r.url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := r.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return errors.New("Expected 200 OK from the JSON Web Key Set HTTP response")
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return err
	}
	set, err := ParseJWKS(raw)
	if err != nil {
		return err
	}
	r.set, r.fetched = set, r.now()
	return nil
}

// Errors of NewRemoteJWTAuthenticator's URL checks.
var (
	ErrInvalidURL   = errors.New("Invalid URL")
	ErrJWKSNotHTTPS = errors.New("JWKS requires HTTPS")
)

// NewRemoteJWTAuthenticator verifies service tokens with keys fetched from jwksURL, a trusted
// HTTPS address from configuration (never from token headers such as jku).
func NewRemoteJWTAuthenticator(jwksURL, issuer, audience string, resolve func(ctx context.Context, claims map[string]any) (*web.Actor, error), options ...RemoteJWKSOption) (*SignedJWTAuthenticator, error) {
	u, err := parseURL(jwksURL)
	if err != nil {
		return nil, err
	}
	if u.Scheme != "https" || u.User != nil && (u.User.Username() != "" || hasPassword(u.User)) {
		return nil, ErrJWKSNotHTTPS
	}
	source := &remoteJWKS{url: u.String(), now: time.Now, client: &http.Client{
		Timeout:       jwksTimeout,
		CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirects are not followed") },
	}}
	for _, option := range options {
		option(source)
	}
	return NewSignedJWTAuthenticator(source, issuer, audience, resolve)
}
