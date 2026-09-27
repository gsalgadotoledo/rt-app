// Package visits keeps a tiny diagnostic sample of pointer and scroll positions, with the
// behavior of the TypeScript reference (@gsalgadotoledo/rt-app-visits) and the visits contract.
//
// One row {pk: "VISITS", sk: "recent"} holds at most 10 sessions of at most 120 points each and
// is replaced atomically with version-guarded writes. Browsers get a signed token from
// POST /visits/start and send batches to POST /visits/events; the owner reads and deletes
// sessions under /admin/app/visits. Tokens are base64url(JSON {"id","startedAt"}) + "." +
// base64url(HMAC-SHA256(secret, "visits:" + payload)), valid for 30 minutes, so every language
// verifies the tokens another one issued. Rate limits are per instance (60 calls per ip per
// minute): put API Gateway or a WAF in front of public distributed traffic.
package visits

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"rt.local/core-go/apperr"
	"rt.local/core-go/internal/js"
	"rt.local/core-go/internal/uuid"
	"rt.local/core-go/nosql"
	"rt.local/core-go/web"
)

// Storage location and limits.
const (
	Partition   = "VISITS"
	SortKey     = "recent"
	MaxPoints   = 120
	MaxSessions = 10
	MaxBatch    = 20
	MaxPages    = 30

	maxAge      = 86_400_000 // sessions live one day (ms)
	tokenAge    = 1_800_000  // tokens live 30 minutes (ms)
	rateWindow  = 60_000
	rateLimit   = 60
	maxClients  = 2000
	maxTokenLen = 500
	maxSafeInt  = 1<<53 - 1
)

// DefaultPages are the public pages whose points are accepted when WithPages is not used.
var DefaultPages = []string{"/", "/about", "/services"}

// Configuration errors (New) and request errors.
var (
	ErrShortSecret  = errors.New("Visits requires a server secret of at least 32 characters")
	ErrInvalidPages = errors.New("Invalid public visit pages")

	ErrInvalidToken = apperr.BadRequest("Invalid visit token")
	ErrExpiredToken = apperr.BadRequest("Expired or invalid visit token")
	ErrInvalidBatch = apperr.BadRequest("Invalid visit batch")
	ErrInvalidPoint = apperr.BadRequest("Invalid visit point")
	ErrNotFound     = apperr.NotFound("Visit not found")
	ErrRateLimit    = apperr.New(http.StatusTooManyRequests, "Visit rate limit")
	ErrBusy         = apperr.New(http.StatusTooManyRequests, "Visits busy")
)

var (
	pagePattern      = regexp.MustCompile(`^/[a-zA-Z0-9/_-]{0,79}$`)
	signaturePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	pointTypes       = []string{"move", "click", "scroll", "page"}
)

// Point is one sampled position: x and y are percentages, t milliseconds since the start.
type Point struct {
	Type string `json:"type"`
	Path string `json:"path"`
	T    int64  `json:"t"`
	X    int64  `json:"x"`
	Y    int64  `json:"y"`
}

// Session is one stored visit.
type Session struct {
	ID        string  `json:"id"`
	StartedAt int64   `json:"startedAt"`
	UpdatedAt int64   `json:"updatedAt"`
	Sequence  int64   `json:"sequence"`
	Points    []Point `json:"points"`
}

// Summary is a session in List: its points are counted and their distinct paths listed.
type Summary struct {
	ID        string   `json:"id"`
	StartedAt int64    `json:"startedAt"`
	UpdatedAt int64    `json:"updatedAt"`
	Sequence  int64    `json:"sequence"`
	Events    int      `json:"events"`
	Pages     []string `json:"pages"`
}

// List is the owner's view of the stored sessions.
type List struct {
	Items     []Summary `json:"items"`
	Limit     int       `json:"limit"`
	MaxPoints int       `json:"maxPoints"`
}

// Started is the answer of Start.
type Started struct {
	Token     string   `json:"token"`
	MaxPoints int      `json:"maxPoints"`
	Pages     []string `json:"pages"`
}

// Recorded is the answer of Ingest: Recorded is false for replayed batches and for sessions
// older than the 10 kept.
type Recorded struct {
	OK       bool `json:"ok"`
	Recorded bool `json:"recorded"`
}

// Option configures Visits.
type Option func(*Visits)

// WithPages sets the public pages (at most 30 paths matching ^/[a-zA-Z0-9/_-]{0,79}$).
func WithPages(pages []string) Option {
	return func(v *Visits) { v.pages = append([]string{}, pages...) }
}

// WithClock sets the clock (default time.Now).
func WithClock(now func() time.Time) Option { return func(v *Visits) { v.now = now } }

// WithIDs sets the session id generator (default random UUIDs).
func WithIDs(newID func() string) Option { return func(v *Visits) { v.newID = newID } }

type window struct {
	at    int64
	count int
}

// Visits is safe for concurrent use if its store is.
type Visits struct {
	store nosql.Store
	key   []byte
	pages []string
	now   func() time.Time
	newID func() string

	mu    sync.Mutex
	rates map[string]*window
}

// New validates the secret (at least 32 UTF-16 code units) and the pages.
func New(store nosql.Store, secret string, options ...Option) (*Visits, error) {
	if js.Len(secret) < 32 {
		return nil, ErrShortSecret
	}
	v := &Visits{store: store, key: []byte(secret), pages: DefaultPages, now: time.Now, newID: uuid.New, rates: map[string]*window{}}
	for _, option := range options {
		option(v)
	}
	if len(v.pages) > MaxPages {
		return nil, ErrInvalidPages
	}
	for _, page := range v.pages {
		if !pagePattern.MatchString(page) {
			return nil, ErrInvalidPages
		}
	}
	return v, nil
}

func (v *Visits) clock() int64 { return v.now().UnixMilli() }

func (v *Visits) signature(value string) string {
	mac := hmac.New(sha256.New, v.key)
	mac.Write([]byte("visits:" + value))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// Sign returns payload + "." + its signature: the token format.
func (v *Visits) Sign(payload string) string { return payload + "." + v.signature(payload) }

type identity struct {
	id        string
	startedAt int64
}

func (v *Visits) token(value any) (identity, error) {
	token, ok := value.(string)
	if !ok || js.Len(token) > maxTokenLen {
		return identity{}, ErrInvalidToken
	}
	parts := strings.Split(token, ".")
	payload, expected := parts[0], v.signature(parts[0])
	if len(parts) != 2 || !signaturePattern.MatchString(parts[1]) || !hmac.Equal([]byte(parts[1]), []byte(expected)) {
		return identity{}, ErrInvalidToken
	}
	var parsed any
	if json.Unmarshal([]byte(decodeUTF8(decodeBase64URL(payload))), &parsed) != nil {
		return identity{}, ErrExpiredToken
	}
	fields, _ := parsed.(map[string]any)
	id, ok := fields["id"].(string)
	startedAt, safe := safeInteger(fields["startedAt"])
	now := v.clock()
	if !ok || !safe || startedAt > now || now-startedAt > tokenAge {
		return identity{}, ErrExpiredToken
	}
	return identity{id: id, startedAt: startedAt}, nil
}

// rate counts one call of ip: 60 per window of 60 s from its first call, 2000 clients at once.
func (v *Visits) rate(ip string) error {
	now := v.clock()
	sum := sha256.Sum256([]byte(ip))
	key := hex.EncodeToString(sum[:])
	v.mu.Lock()
	defer v.mu.Unlock()
	for k, w := range v.rates {
		if now-w.at >= rateWindow {
			delete(v.rates, k)
		}
	}
	w, known := v.rates[key]
	if !known {
		if len(v.rates) >= maxClients {
			return ErrBusy
		}
		w = &window{at: now}
		v.rates[key] = w
	}
	w.count++
	if w.count > rateLimit {
		return ErrRateLimit
	}
	return nil
}

// Start issues a token for a new session.
func (v *Visits) Start(_ context.Context, ip string) (Started, error) {
	if err := v.rate(ip); err != nil {
		return Started{}, err
	}
	payload := `{"id":` + quote(v.newID()) + `,"startedAt":` + js.FormatNumber(float64(v.clock())) + `}`
	return Started{Token: v.Sign(base64.RawURLEncoding.EncodeToString([]byte(payload))), MaxPoints: MaxPoints, Pages: append([]string{}, v.pages...)}, nil
}

// Ingest appends a batch {token, sequence, points} (a decoded JSON body). Batches whose
// sequence does not exceed the session's are ignored.
func (v *Visits) Ingest(ctx context.Context, input map[string]any, ip string) (Recorded, error) {
	if err := v.rate(ip); err != nil {
		return Recorded{}, err
	}
	who, err := v.token(input["token"])
	if err != nil {
		return Recorded{}, err
	}
	sequence, safe := safeInteger(input["sequence"])
	raw, isList := input["points"].([]any)
	if !safe || sequence < 1 || !isList || len(raw) == 0 || len(raw) > MaxBatch {
		return Recorded{}, ErrInvalidBatch
	}
	points := make([]Point, len(raw))
	for i, item := range raw {
		if points[i], err = v.point(item); err != nil {
			return Recorded{}, err
		}
	}
	recorded := false
	_, err = v.update(ctx, func(sessions []Session) []Session {
		at := slices.IndexFunc(sessions, func(s Session) bool { return s.ID == who.id })
		if at >= 0 && sequence <= sessions[at].Sequence {
			return sessions
		}
		now := v.clock()
		if at < 0 {
			sessions = append(sessions, Session{ID: who.id, StartedAt: who.startedAt, UpdatedAt: now, Points: []Point{}})
			at = len(sessions) - 1
		}
		session := &sessions[at]
		session.Sequence = sequence
		session.UpdatedAt = now
		session.Points = append(session.Points, points[:max(0, min(len(points), MaxPoints-len(session.Points)))]...)
		// Newest first, then id: ids are lowercase UUIDs, whose byte order equals localeCompare.
		slices.SortStableFunc(sessions, func(a, b Session) int {
			if a.StartedAt != b.StartedAt {
				if a.StartedAt > b.StartedAt {
					return -1
				}
				return 1
			}
			return strings.Compare(a.ID, b.ID)
		})
		retained := sessions[:min(len(sessions), MaxSessions)]
		recorded = slices.ContainsFunc(retained, func(s Session) bool { return s.ID == who.id })
		return retained
	})
	if err != nil {
		return Recorded{}, err
	}
	return Recorded{OK: true, Recorded: recorded}, nil
}

func (v *Visits) point(item any) (Point, error) {
	p, _ := item.(map[string]any)
	kind, kindOK := p["type"].(string)
	path, pathOK := p["path"].(string)
	t, tOK := safeInteger(p["t"])
	x, xOK := js.Integer(p["x"])
	y, yOK := js.Integer(p["y"])
	if !kindOK || !slices.Contains(pointTypes, kind) || !pathOK || !slices.Contains(v.pages, path) ||
		!tOK || t < 0 || t > tokenAge || !xOK || !yOK || x < 0 || x > 100 || y < 0 || y > 100 {
		return Point{}, ErrInvalidPoint
	}
	return Point{Type: kind, Path: path, T: t, X: int64(x), Y: int64(y)}, nil
}

// load reads the stored sessions (none when the row or its sessions are missing).
func (v *Visits) load(ctx context.Context) (*nosql.Row, []Session, error) {
	row, err := v.store.Get(ctx, Partition, SortKey)
	if err != nil || row == nil || row.Data["sessions"] == nil {
		return row, []Session{}, err
	}
	raw, err := json.Marshal(row.Data["sessions"])
	if err != nil {
		return nil, nil, err
	}
	var sessions []Session
	if err := json.Unmarshal(raw, &sessions); err != nil {
		return nil, nil, err
	}
	for i := range sessions {
		if sessions[i].Points == nil {
			sessions[i].Points = []Point{}
		}
	}
	return row, sessions, nil
}

// update rewrites the row with operation applied to the unexpired sessions, retrying up to 5
// times on conflicts.
func (v *Visits) update(ctx context.Context, operation func([]Session) []Session) ([]Session, error) {
	for attempt := 0; ; attempt++ {
		row, stored, err := v.load(ctx)
		if err != nil {
			return nil, err
		}
		now := v.clock()
		sessions := slices.DeleteFunc(stored, func(s Session) bool { return s.StartedAt <= now-maxAge })
		next := operation(sessions)
		version, expected := 1, (*int)(nil)
		if row != nil {
			version, expected = row.Version+1, nosql.Expect(row.Version)
		}
		ttl := int64(math.Ceil(float64(now+maxAge) / 1000))
		data := map[string]any{"sessions": next}
		err = v.store.Transact(ctx, []nosql.Write{{Row: nosql.Row{PK: Partition, SK: SortKey, Version: version, TTL: &ttl, Data: data}, Expected: expected}})
		if err == nil {
			return next, nil
		}
		if !apperr.IsConflict(err) || attempt == 4 {
			return nil, err
		}
	}
}

// read returns the stored sessions, rewriting the row only when one has expired.
func (v *Visits) read(ctx context.Context) ([]Session, error) {
	_, sessions, err := v.load(ctx)
	if err != nil {
		return nil, err
	}
	now := v.clock()
	if slices.ContainsFunc(sessions, func(s Session) bool { return s.StartedAt <= now-maxAge }) {
		return v.update(ctx, func(s []Session) []Session { return s })
	}
	return sessions, nil
}

// List summarizes the stored sessions in stored order.
func (v *Visits) List(ctx context.Context) (List, error) {
	sessions, err := v.read(ctx)
	if err != nil {
		return List{}, err
	}
	items := make([]Summary, len(sessions))
	for i, s := range sessions {
		pages := []string{}
		for _, p := range s.Points {
			if !slices.Contains(pages, p.Path) {
				pages = append(pages, p.Path)
			}
		}
		items[i] = Summary{ID: s.ID, StartedAt: s.StartedAt, UpdatedAt: s.UpdatedAt, Sequence: s.Sequence, Events: len(s.Points), Pages: pages}
	}
	return List{Items: items, Limit: MaxSessions, MaxPoints: MaxPoints}, nil
}

// Detail returns one session with its points.
func (v *Visits) Detail(ctx context.Context, id string) (Session, error) {
	sessions, err := v.read(ctx)
	if err != nil {
		return Session{}, err
	}
	for _, s := range sessions {
		if s.ID == id {
			return s, nil
		}
	}
	return Session{}, ErrNotFound
}

// Remove deletes one session (the row is rewritten even when it is unknown).
func (v *Visits) Remove(ctx context.Context, id string) (map[string]bool, error) {
	_, err := v.update(ctx, func(sessions []Session) []Session {
		return slices.DeleteFunc(sessions, func(s Session) bool { return s.ID == id })
	})
	if err != nil {
		return nil, err
	}
	return map[string]bool{"ok": true}, nil
}

// Feature serves the public capture endpoints and the owner-only list, detail and removal
// (mounted under /admin/app).
func (v *Visits) Feature() web.Feature {
	return web.Feature{
		ID: "visits",
		Endpoints: []web.Endpoint{
			{Method: "POST", Path: "/visits/start", Access: web.Guest, Resource: "visits.capture", Handle: func(c *web.Context) (any, error) {
				return v.Start(c.Ctx, c.Request.IP)
			}},
			{Method: "POST", Path: "/visits/events", Access: web.Guest, Resource: "visits.capture", Handle: func(c *web.Context) (any, error) {
				return v.Ingest(c.Ctx, c.Request.Body, c.Request.IP)
			}},
			{Method: "GET", Path: "/visits", Access: web.Owner, Resource: "visits.read", Handle: func(c *web.Context) (any, error) {
				return v.List(c.Ctx)
			}},
			{Method: "GET", Path: "/visits/:id", Access: web.Owner, Resource: "visits.read", Handle: func(c *web.Context) (any, error) {
				return v.Detail(c.Ctx, c.Params["id"])
			}},
			{Method: "DELETE", Path: "/visits/:id", Access: web.Owner, Resource: "visits.delete", Handle: func(c *web.Context) (any, error) {
				return v.Remove(c.Ctx, c.Params["id"])
			}},
		},
	}
}

// safeInteger is Number.isSafeInteger for a decoded JSON value.
func safeInteger(value any) (int64, bool) {
	f, ok := js.Integer(value)
	if !ok || math.Abs(f) > maxSafeInt {
		return 0, false
	}
	return int64(f), true
}

// decodeBase64URL is Node's lenient Buffer.from(text, "base64url"): both alphabets, unknown
// characters skipped, decoding stops at "=", and a trailing single character is dropped.
func decodeBase64URL(text string) []byte {
	var clean strings.Builder
	for _, r := range text {
		if r == '=' {
			break
		}
		switch {
		case r == '+' || r == '-':
			clean.WriteByte('-')
		case r == '/' || r == '_':
			clean.WriteByte('_')
		case r < utf8.RuneSelf && (r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || r >= '0' && r <= '9'):
			clean.WriteRune(r)
		}
	}
	s := clean.String()
	if len(s)%4 == 1 {
		s = s[:len(s)-1]
	}
	out, _ := base64.RawURLEncoding.DecodeString(s)
	return out
}

// decodeUTF8 is Buffer.toString(): each invalid byte becomes U+FFFD.
func decodeUTF8(data []byte) string {
	if utf8.Valid(data) {
		return string(data)
	}
	var b strings.Builder
	for len(data) > 0 {
		r, size := utf8.DecodeRune(data)
		b.WriteRune(r)
		data = data[size:]
	}
	return b.String()
}

// quote is JSON.stringify for a string: only quotes, backslashes and control characters are
// escaped (Go's encoder also escapes <, >, & and U+2028/U+2029).
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
				b.WriteByte("0123456789abcdef"[r&15])
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}
