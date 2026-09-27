// Package servicekeys is the Go port of packages/auth/src/service-keys.ts: scoped credentials
// for backends (an agent server metering credits) that must not hold the admin root password.
//
// A key is presented as `Authorization: Bearer rtsk_<id>.<secret>` and authenticates ONLY
// endpoints with access web.Service (served under /service/...) whose resource is one of the
// key's scopes. Keys come from the configuration (RT_APP_SERVICE_KEYS, JSON, or the file named
// by RT_APP_SERVICE_KEYS_FILE) or are managed by the admin (create: the token is shown once;
// rotate; revoke). Only sha256hex(token) is stored. Rows and messages are shared with the
// TypeScript reference and the Python port (spec/contracts/service-keys.contract.yaml).
package servicekeys

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"rt.local/core-go/apperr"
	"rt.local/core-go/internal/js"
	"rt.local/core-go/nosql"
	"rt.local/core-go/web"
)

// Row partitions and limits.
const (
	Prefix = "rtsk_"
	// Keys is the partition of admin-managed keys: SERVICE_KEYS/<id>.
	Keys = "SERVICE_KEYS"
	// Use is the partition of last uses: SERVICE_KEY_USE/<id> {lastUsedAt}.
	Use = "SERVICE_KEY_USE"
	// DefaultRateLimit is the requests per minute of a key unless it says otherwise.
	DefaultRateLimit = 600
	MaxRateLimit     = 100000
	// TouchMs: lastUsedAt is written at most once per minute per key.
	TouchMs = 60000
	// Self is the resource of GET /service/keys/self.
	Self = "service-keys.self"
)

// Messages.
const (
	MsgInvalid       = "Invalid service key"
	MsgRequired      = "Service key required"
	MsgScope         = "Service key not allowed for this resource"
	msgConfiguration = "Invalid service key configuration"
	msgTooMany       = "Too many attempts; wait one minute"
)

// Audit is the management audit partition of a key: SERVICE_KEY_AUDIT#<id>.
func Audit(id string) string { return "SERVICE_KEY_AUDIT#" + id }

var (
	tokenPattern  = regexp.MustCompile(`^rtsk_([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{32,128})$`)
	keyIDPattern  = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	secretPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{32,128}$`)
	hashPattern   = regexp.MustCompile(`^[0-9a-f]{64}$`)
	noHash        = strings.Repeat("0", 64)
)

// Hash is sha256 hex of the UTF-8 token: the stored form of a key.
func Hash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// Random returns n random bytes as base64url without padding.
func Random(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// scopeList: a non-empty list (at most 20) of known scopes; duplicates removed, order kept.
func scopeList(v any, known []string) ([]any, bool) {
	list, ok := v.([]any)
	if !ok || len(list) < 1 || len(list) > 20 {
		return nil, false
	}
	var out []any
	for _, item := range list {
		s, ok := item.(string)
		if !ok || !slices.Contains(known, s) {
			return nil, false
		}
		if !slices.Contains(out, any(s)) {
			out = append(out, s)
		}
	}
	return out, true
}

func safeInteger(v any) (float64, bool) {
	n, ok := v.(float64)
	return n, ok && !math.IsInf(n, 0) && n == math.Trunc(n) && math.Abs(n) <= 1<<53-1
}

// rateLimitOf is rateLimit ?? 600, a safe integer 1..100000.
func rateLimitOf(v any) (float64, bool) {
	if v == nil {
		return DefaultRateLimit, true
	}
	n, ok := safeInteger(v)
	return n, ok && n >= 1 && n <= MaxRateLimit
}

// Parse validates configured keys (the parsed RT_APP_SERVICE_KEYS value) and returns their
// records; any problem is 400 "Invalid service key configuration".
func Parse(value any, known []string) ([]map[string]any, error) {
	fail := apperr.BadRequest(msgConfiguration)
	if value == nil {
		return nil, nil
	}
	list, ok := value.([]any)
	if !ok || len(list) > 100 {
		return nil, fail
	}
	var keys []map[string]any
	for _, item := range list {
		entry, ok := item.(map[string]any)
		if !ok {
			return nil, fail
		}
		id, ok := entry["id"].(string)
		if !ok || !keyIDPattern.MatchString(id) {
			return nil, fail
		}
		hasHash, hasSecret := entry["secretHash"] != nil, entry["secret"] != nil
		if hasHash == hasSecret {
			return nil, fail
		}
		hash, _ := entry["secretHash"].(string)
		secret, _ := entry["secret"].(string)
		if hasHash && !hashPattern.MatchString(hash) {
			return nil, fail
		}
		if hasSecret && !secretPattern.MatchString(secret) {
			return nil, fail
		}
		scopes, ok := scopeList(entry["scopes"], known)
		if !ok {
			return nil, fail
		}
		description := ""
		if entry["description"] != nil {
			s, ok := entry["description"].(string)
			if !ok || js.Len(js.Trim(s)) > 200 {
				return nil, fail
			}
			description = js.Trim(s)
		}
		limit, ok := rateLimitOf(entry["rateLimit"])
		if !ok {
			return nil, fail
		}
		for _, k := range keys {
			if k["id"] == id {
				return nil, fail
			}
		}
		if hasSecret {
			hash = Hash(Prefix + id + "." + secret)
		}
		keys = append(keys, map[string]any{
			"id": id, "secretHash": hash, "scopes": scopes, "description": description, "rateLimit": limit, "source": "env",
			"createdAt": nil, "createdBy": nil, "rotatedAt": nil, "revokedAt": nil, "revokedBy": nil,
		})
	}
	return keys, nil
}

// FromEnv reads configured keys: RT_APP_SERVICE_KEYS (JSON) or the file named by
// RT_APP_SERVICE_KEYS_FILE. Nothing configured is nil; bad JSON is 400.
func FromEnv(getenv func(string) string) (any, error) {
	if getenv == nil {
		getenv = os.Getenv
	}
	text := getenv("RT_APP_SERVICE_KEYS")
	if text == "" && getenv("RT_APP_SERVICE_KEYS_FILE") != "" {
		raw, err := os.ReadFile(getenv("RT_APP_SERVICE_KEYS_FILE"))
		if err != nil {
			return nil, err
		}
		text = string(raw)
	}
	if strings.TrimSpace(text) == "" {
		return nil, nil
	}
	var value any
	if err := json.Unmarshal([]byte(text), &value); err != nil {
		return nil, apperr.BadRequest(msgConfiguration)
	}
	return value, nil
}

// Option configures a Service.
type Option func(*Service)

// WithClock sets the clock (epoch milliseconds).
func WithClock(now func() float64) Option { return func(s *Service) { s.now = now } }

// WithRandom sets the random source (n bytes as base64url).
func WithRandom(random func(n int) string) Option { return func(s *Service) { s.random = random } }

// Service holds configured keys and manages stored ones. It implements web.ServicePolicy.
type Service struct {
	store      nosql.Store
	secret     []byte
	scopes     []string
	configured []map[string]any
	now        func() float64
	random     func(n int) string
}

// New validates the configured keys (keys: the parsed RT_APP_SERVICE_KEYS value) against the
// scopes a key may hold.
func New(store nosql.Store, secret string, keys any, scopes []string, options ...Option) (*Service, error) {
	s := &Service{store: store, secret: []byte(secret), scopes: slices.Clone(scopes), random: Random,
		now: func() float64 { return float64(time.Now().UnixMilli()) }}
	for _, o := range options {
		o(s)
	}
	configured, err := Parse(keys, s.scopes)
	if err != nil {
		return nil, err
	}
	s.configured = configured
	return s, nil
}

// Scopes are the scopes a key may hold.
func (s *Service) Scopes() []string { return slices.Clone(s.scopes) }

func (s *Service) configuredKey(id string) map[string]any {
	for _, k := range s.configured {
		if k["id"] == id {
			return k
		}
	}
	return nil
}

// record is the key (configured first, then stored) or nil.
func (s *Service) record(ctx context.Context, id string) (map[string]any, *nosql.Row, error) {
	if k := s.configuredKey(id); k != nil {
		return k, nil, nil
	}
	row, err := s.store.Get(ctx, Keys, id)
	if err != nil || row == nil {
		return nil, nil, err
	}
	return row.Data, row, nil
}

func view(key map[string]any, lastUsedAt any) map[string]any {
	id, _ := key["id"].(string)
	return map[string]any{
		"id": key["id"], "description": key["description"], "scopes": key["scopes"], "rateLimit": key["rateLimit"],
		"source": key["source"], "prefix": Prefix + id + ".", "active": key["revokedAt"] == nil,
		"createdAt": key["createdAt"], "createdBy": key["createdBy"], "rotatedAt": key["rotatedAt"],
		"revokedAt": key["revokedAt"], "revokedBy": key["revokedBy"], "lastUsedAt": lastUsedAt,
	}
}

func (s *Service) all(ctx context.Context, pk string) ([]nosql.Row, error) {
	var rows []nosql.Row
	cursor := ""
	for {
		page, err := s.store.List(ctx, pk, cursor)
		if err != nil {
			return nil, err
		}
		rows = append(rows, page.Items...)
		if cursor = page.Cursor; cursor == "" {
			return rows, nil
		}
	}
}

// List is every key (configured first, then stored by id) and the scopes a key may hold.
func (s *Service) List(ctx context.Context) (map[string]any, error) {
	uses, err := s.all(ctx, Use)
	if err != nil {
		return nil, err
	}
	used := map[string]any{}
	for _, r := range uses {
		used[r.SK] = r.Data["lastUsedAt"]
	}
	stored, err := s.all(ctx, Keys)
	if err != nil {
		return nil, err
	}
	items := []any{}
	for _, k := range s.configured {
		items = append(items, view(k, used[k["id"].(string)]))
	}
	for _, r := range stored {
		items = append(items, view(r.Data, used[r.SK]))
	}
	scopes := make([]any, len(s.scopes))
	for i, sc := range s.scopes {
		scopes[i] = sc
	}
	return map[string]any{"items": items, "scopes": scopes}, nil
}

func pad(n float64, width int) string {
	text := strconv.FormatInt(int64(n), 10)
	if len(text) < width {
		text = strings.Repeat("0", width-len(text)) + text
	}
	return text
}

func (s *Service) audit(id string, version int, data map[string]any) nosql.Write {
	row := map[string]any{"keyId": id}
	for k, v := range data {
		row[k] = v
	}
	return nosql.Write{Row: nosql.Row{PK: Audit(id), SK: pad(data["at"].(float64), 15) + "-" + pad(float64(version), 10), Version: 1, Data: row}}
}

func (s *Service) lastUsed(ctx context.Context, id string) (any, error) {
	row, err := s.store.Get(ctx, Use, id)
	if err != nil || row == nil {
		return nil, err
	}
	return row.Data["lastUsedAt"], nil
}

// Create makes an admin-managed key from {id?, description, scopes, rateLimit?} and returns
// {key, token}: the token is shown only here.
func (s *Service) Create(ctx context.Context, input map[string]any, actorID string) (map[string]any, error) {
	given := input["id"]
	if given != nil {
		g, ok := given.(string)
		if !ok || !keyIDPattern.MatchString(g) {
			return nil, apperr.BadRequest("Invalid service key id")
		}
	}
	description := ""
	if d, ok := input["description"].(string); ok {
		description = js.Trim(d)
	}
	if description == "" || js.Len(description) > 200 {
		return nil, apperr.BadRequest("A short description is required")
	}
	scopes, ok := scopeList(input["scopes"], s.scopes)
	if !ok {
		return nil, apperr.BadRequest("Invalid service key scopes")
	}
	limit, ok := rateLimitOf(input["rateLimit"])
	if !ok {
		return nil, apperr.BadRequest("Invalid service key rate limit")
	}
	id, _ := given.(string)
	if given == nil {
		id = s.random(9)
	}
	taken := apperr.New(http.StatusConflict, "Service key id already used")
	if s.configuredKey(id) != nil {
		return nil, taken
	}
	existing, err := s.store.Get(ctx, Keys, id)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		return nil, taken
	}
	token := Prefix + id + "." + s.random(32)
	at := s.now()
	key := map[string]any{
		"id": id, "description": description, "scopes": scopes, "rateLimit": limit, "secretHash": Hash(token), "source": "admin",
		"createdAt": at, "createdBy": actorID, "rotatedAt": nil, "revokedAt": nil, "revokedBy": nil,
	}
	err = s.store.Transact(ctx, []nosql.Write{
		{Row: nosql.Row{PK: Keys, SK: id, Version: 1, Data: key}},
		s.audit(id, 1, map[string]any{"action": "create", "actorId": actorID, "at": at, "scopes": scopes, "rateLimit": limit}),
	})
	if apperr.IsConflict(err) {
		return nil, taken
	}
	if err != nil {
		return nil, err
	}
	return map[string]any{"key": view(key, nil), "token": token}, nil
}

func (s *Service) managed(ctx context.Context, id string, action string) (*nosql.Row, error) {
	if !keyIDPattern.MatchString(id) {
		return nil, apperr.NotFound("Service key not found")
	}
	if s.configuredKey(id) != nil {
		if action == "rotate" {
			return nil, apperr.New(http.StatusConflict, "Keys from the configuration are rotated in the configuration")
		}
		return nil, apperr.New(http.StatusConflict, "Keys from the configuration are revoked by removing them from the configuration")
	}
	row, err := s.store.Get(ctx, Keys, id)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, apperr.NotFound("Service key not found")
	}
	return row, nil
}

func copyMap(m map[string]any) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// Rotate gives an admin-managed key a new secret; the old token stops working at once.
func (s *Service) Rotate(ctx context.Context, id, actorID string) (map[string]any, error) {
	row, err := s.managed(ctx, id, "rotate")
	if err != nil {
		return nil, err
	}
	if row.Data["revokedAt"] != nil {
		return nil, apperr.New(http.StatusConflict, "Service key is revoked")
	}
	token := Prefix + id + "." + s.random(32)
	at := s.now()
	next := copyMap(row.Data)
	next["secretHash"], next["rotatedAt"] = Hash(token), at
	if err := s.store.Transact(ctx, []nosql.Write{
		{Row: nosql.Row{PK: Keys, SK: id, Version: row.Version + 1, Data: next}, Expected: nosql.Expect(row.Version)},
		s.audit(id, row.Version+1, map[string]any{"action": "rotate", "actorId": actorID, "at": at}),
	}); err != nil {
		return nil, err
	}
	used, err := s.lastUsed(ctx, id)
	if err != nil {
		return nil, err
	}
	return map[string]any{"key": view(next, used), "token": token}, nil
}

// Revoke rejects an admin-managed key from the next request on. Idempotent.
func (s *Service) Revoke(ctx context.Context, id, actorID string) (map[string]any, error) {
	row, err := s.managed(ctx, id, "revoke")
	if err != nil {
		return nil, err
	}
	next := row.Data
	if row.Data["revokedAt"] == nil {
		at := s.now()
		next = copyMap(row.Data)
		next["revokedAt"], next["revokedBy"] = at, actorID
		if err := s.store.Transact(ctx, []nosql.Write{
			{Row: nosql.Row{PK: Keys, SK: id, Version: row.Version + 1, Data: next}, Expected: nosql.Expect(row.Version)},
			s.audit(id, row.Version+1, map[string]any{"action": "revoke", "actorId": actorID, "at": at}),
		}); err != nil {
			return nil, err
		}
	}
	used, err := s.lastUsed(ctx, id)
	if err != nil {
		return nil, err
	}
	return map[string]any{"key": view(next, used)}, nil
}

// limit is the per-minute counter of auth limits: RATE/hex(HMAC(secret, "<key>:<minute>")).
func (s *Service) limit(ctx context.Context, key string, max float64) error {
	now := s.now()
	mac := hmac.New(sha256.New, s.secret)
	mac.Write([]byte(key + ":" + strconv.FormatInt(int64(math.Floor(now/60000)), 10)))
	sk := hex.EncodeToString(mac.Sum(nil))
	for range 8 {
		row, err := s.store.Get(ctx, "RATE", sk)
		if err != nil {
			return err
		}
		count, version, expected := 0.0, 1, (*int)(nil)
		if row != nil {
			if n, ok := row.Data["count"].(float64); ok {
				count = n
			}
			version, expected = row.Version+1, nosql.Expect(row.Version)
		}
		if count >= max {
			return apperr.New(http.StatusTooManyRequests, msgTooMany)
		}
		ttl := int64(math.Floor(now/1000)) + 120
		err = s.store.Transact(ctx, []nosql.Write{{Row: nosql.Row{PK: "RATE", SK: sk, Version: version, TTL: &ttl, Data: map[string]any{"count": count + 1}}, Expected: expected}})
		if err == nil {
			return nil
		}
		if !apperr.IsConflict(err) {
			return err
		}
	}
	return apperr.New(http.StatusTooManyRequests, "Too many simultaneous attempts")
}

// Authenticate resolves the service actor of an Authorization value (nil or "" when absent):
// 401 "Service key required", 401 "Invalid service key", then the per-key limit (429) and the
// last use (at most once a minute).
func (s *Service) Authenticate(ctx context.Context, authorization any) (*web.Actor, error) {
	if authorization == nil || authorization == "" {
		return nil, apperr.New(http.StatusUnauthorized, MsgRequired)
	}
	header, _ := authorization.(string)
	token, isBearer := strings.CutPrefix(header, "Bearer ")
	match := tokenPattern.FindStringSubmatch(token)
	if !isBearer || match == nil {
		return nil, apperr.New(http.StatusUnauthorized, MsgInvalid)
	}
	id := match[1]
	key, _, err := s.record(ctx, id)
	if err != nil {
		return nil, err
	}
	expected := noHash
	if h, ok := key["secretHash"].(string); key != nil && ok && hashPattern.MatchString(h) {
		expected = h
	}
	got, _ := hex.DecodeString(Hash(token))
	want, _ := hex.DecodeString(expected)
	valid := subtle.ConstantTimeCompare(got, want) == 1
	if key == nil || !valid || key["revokedAt"] != nil {
		return nil, apperr.New(http.StatusUnauthorized, MsgInvalid)
	}
	limit, _ := key["rateLimit"].(float64)
	if err := s.limit(ctx, "service-key:"+id, limit); err != nil {
		return nil, err
	}
	now := s.now()
	use, err := s.store.Get(ctx, Use, id)
	if err != nil {
		return nil, err
	}
	last, isNumber := any(nil), false
	if use != nil {
		last = use.Data["lastUsedAt"]
		_, isNumber = last.(float64)
	}
	if use == nil || !isNumber || !(now-last.(float64) < TouchMs) {
		w := nosql.Write{Row: nosql.Row{PK: Use, SK: id, Version: 1, Data: map[string]any{"lastUsedAt": now}}}
		if use != nil {
			w.Row.Version, w.Expected = use.Version+1, nosql.Expect(use.Version)
		}
		if err := s.store.Transact(ctx, []nosql.Write{w}); err != nil && !apperr.IsConflict(err) {
			return nil, err
		}
	}
	var grants []string
	for _, sc := range key["scopes"].([]any) {
		grants = append(grants, sc.(string))
	}
	name, _ := key["description"].(string)
	if name == "" {
		name = id
	}
	return &web.Actor{ID: "service:" + id, Role: "service", Grants: grants, Name: name, Active: true}, nil
}

// Actor implements web.ServicePolicy with the request's Authorization header.
func (s *Service) Actor(r *http.Request) (*web.Actor, error) {
	var header any
	if values, ok := r.Header["Authorization"]; ok && len(values) > 0 {
		header = values[0]
	}
	return s.Authenticate(r.Context(), header)
}

// Check authorizes a service actor for an endpoint (web.ServicePolicy).
func (s *Service) Check(e web.Endpoint, actor *web.Actor) error {
	if e.Access != web.Service {
		return apperr.New(http.StatusForbidden, "You do not have permission to access this resource")
	}
	if actor == nil || actor.Role != "service" {
		return apperr.New(http.StatusUnauthorized, MsgRequired)
	}
	if !slices.Contains(actor.Grants, e.Resource) {
		return apperr.New(http.StatusForbidden, MsgScope)
	}
	return nil
}

// SelfView is GET /service/keys/self for an actor.
func (s *Service) SelfView(ctx context.Context, actor *web.Actor) (map[string]any, error) {
	id := strings.TrimPrefix(actor.ID, "service:")
	key, _, err := s.record(ctx, id)
	if err != nil {
		return nil, err
	}
	description, limit := any(""), any(nil)
	if key != nil {
		description, limit = key["description"], key["rateLimit"]
	}
	scopes := make([]any, len(actor.Grants))
	for i, g := range actor.Grants {
		scopes[i] = g
	}
	return map[string]any{"id": id, "description": description, "scopes": scopes, "rateLimit": limit}, nil
}

// Admin is the admin manifest.
func Admin() map[string]any {
	return map[string]any{
		"id": "service-keys", "title": "Service keys", "resource": "service-keys.manage", "path": "/service-keys",
		"component": "service-keys", "ownerOnly": true, "fields": []any{}, "actions": []any{},
	}
}

func actorID(a *web.Actor) string {
	if a == nil {
		return ""
	}
	return a.ID
}

// Feature is the HTTP surface: owner endpoints (served only under /admin/app) and GET
// /service/keys/self, in the TypeScript order.
func (s *Service) Feature() web.Feature {
	const manage = "service-keys.manage"
	return web.Feature{ID: "service-keys", Endpoints: []web.Endpoint{
		{Method: "GET", Path: "/service-keys", Resource: manage, Access: web.Owner,
			Tool:   &web.Tool{Name: "service_keys_list", Description: "List service keys (configured and admin-managed): id, description, scopes, rate limit, last use, revoked. Never returns secrets.", Example: map[string]any{}},
			Handle: func(c *web.Context) (any, error) { return s.List(c.Ctx) }},
		{Method: "POST", Path: "/service-keys", Resource: manage, Access: web.Owner, Handle: func(c *web.Context) (any, error) {
			b := c.Request.Body
			return s.Create(c.Ctx, map[string]any{"id": b["id"], "description": b["description"], "scopes": b["scopes"], "rateLimit": b["rateLimit"]}, actorID(c.Actor))
		}},
		{Method: "POST", Path: "/service-keys/:id/rotate", Resource: manage, Access: web.Owner, Handle: func(c *web.Context) (any, error) {
			return s.Rotate(c.Ctx, c.Params["id"], actorID(c.Actor))
		}},
		{Method: "POST", Path: "/service-keys/:id/revoke", Resource: manage, Access: web.Owner,
			Tool:   &web.Tool{Name: "service_keys_revoke", Description: "Revoke an admin-managed service key; it is rejected from the next request on. params.id is the key id.", Example: map[string]any{"params": map[string]any{"id": "KEY_ID"}}},
			Handle: func(c *web.Context) (any, error) { return s.Revoke(c.Ctx, c.Params["id"], actorID(c.Actor)) }},
		{Method: "GET", Path: "/service/keys/self", Resource: Self, Access: web.Service, Handle: func(c *web.Context) (any, error) {
			return s.SelfView(c.Ctx, c.Actor)
		}},
	}}
}

var _ web.ServicePolicy = (*Service)(nil)

// String describes the service without secrets.
func (s *Service) String() string {
	return fmt.Sprintf("servicekeys(%d configured)", len(s.configured))
}
