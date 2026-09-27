package observer

import (
	"crypto/sha256"
	"encoding/hex"
	"math"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"rt.local/core-go/apperr"
	"rt.local/core-go/internal/canonical"
	"rt.local/core-go/internal/js"
	"rt.local/core-go/web"
)

// Limits of POST /observer/events (per instance; use API Gateway/WAF limits for fleets).
const (
	RatePerMinute = 60
	RatePurge     = 2000
	RateClients   = 4000
)

// AdminPage is the admin metadata of the feature (owner-only Observer page).
var AdminPage = map[string]any{
	"id": "observer", "title": "Observer", "resource": "observer.read", "path": "/observer/report",
	"component": "observer", "ownerOnly": true, "fields": []any{}, "actions": []any{},
}

var pagePath = regexp.MustCompile(`^/[a-zA-Z0-9/_-]*$`)

// ErrTooManyEvents is the rate-limit error of POST /observer/events (HTTP 429).
var ErrTooManyEvents = apperr.New(http.StatusTooManyRequests, "Too many events")

// OutputInfo describes an output in the report.
type OutputInfo struct {
	ID      string   `json:"id"`
	Enabled bool     `json:"enabled"`
	Levels  []string `json:"levels"`
	Kinds   []string `json:"kinds"`
}

// FeatureReport is the report endpoint's answer: the day's Report plus health and outputs.
type FeatureReport struct {
	Report
	Health  Health       `json:"health"`
	Outputs []OutputInfo `json:"outputs"`
}

// Feature serves GET /observer/report and GET /observer/logs (owner, resource observer.read,
// mounted under /admin/app only) and POST /observer/events (guests, resource observer.pageview).
// logs defaults to storage; now is the clock of the default day and the rate limit (nil: system).
func Feature(o *Observer, storage *Store, logs LogReader, now func() time.Time) web.Feature {
	if logs == nil {
		logs = storage
	}
	if now == nil {
		now = time.Now
	}
	today := func() string { return ISOTime(now())[:10] }
	limiter := &rateLimiter{rates: map[string]rate{}}
	report := func(c *web.Context) (any, error) {
		day, ok := c.Request.Query["day"]
		if !ok {
			day = today()
		}
		r, err := storage.Report(c.Ctx, day)
		if err != nil {
			return nil, err
		}
		result := FeatureReport{Report: r, Health: o.Health(), Outputs: []OutputInfo{}}
		for _, output := range o.Outputs() {
			info := OutputInfo{ID: output.Handler.ID(), Enabled: !output.Disabled, Levels: output.Levels, Kinds: output.Kinds}
			if info.Levels == nil {
				info.Levels = Levels
			}
			if info.Kinds == nil {
				info.Kinds = Kinds
			}
			result.Outputs = append(result.Outputs, info)
		}
		return result, nil
	}
	search := func(c *web.Context) (any, error) {
		values := map[string]any{"day": today()}
		for key, value := range c.Request.Query {
			values[key] = value
		}
		q, err := ParseLogQuery(values)
		if err != nil {
			return nil, err
		}
		return logs.Search(c.Ctx, q)
	}
	ingest := func(c *web.Context) (any, error) {
		body := c.Request.Body
		message := "Page viewed"
		if raw, present := body["message"]; present {
			text, ok := raw.(string)
			if !ok || js.Len(text) > 200 {
				return nil, apperr.BadRequest("Invalid page message")
			}
			message = text
		}
		source, _ := body["source"].(string)
		path, isString := body["path"].(string)
		if source != "spa" && source != "ssr" || !isString || js.Len(path) > 160 || !pagePath.MatchString(path) ||
			// "//host/x" is protocol-relative: it names a host (or none) instead of a page.
			strings.HasPrefix(path, "//") {
			return nil, apperr.BadRequest("Invalid page event")
		}
		if err := limiter.take(c.Request.IP, now()); err != nil {
			return nil, err
		}
		if err := o.CountView(c.Ctx, message, View{URL: path, Source: source}); err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, nil
	}
	return web.Feature{ID: "observer", Endpoints: []web.Endpoint{
		{Method: "GET", Path: "/observer/report", Access: web.Owner, Resource: "observer.read", Handle: report},
		{Method: "GET", Path: "/observer/logs", Access: web.Owner, Resource: "observer.read", Handle: search},
		{Method: "POST", Path: "/observer/events", Access: web.Guest, Resource: "observer.pageview", Handle: ingest},
	}}
}

type rate struct {
	minute int64
	count  int
}

type rateLimiter struct {
	mu    sync.Mutex
	rates map[string]rate
}

// take counts one event of ip in the current clock minute: 60 per client, 4000 clients.
func (l *rateLimiter) take(ip string, now time.Time) error {
	minute := int64(math.Floor(float64(now.UnixMilli()) / 60000))
	sum := sha256.Sum256(canonical.UTF8(ip))
	key := hex.EncodeToString(sum[:])
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.rates) > RatePurge {
		for k, v := range l.rates {
			if v.minute != minute {
				delete(l.rates, k)
			}
		}
	}
	entry, known := l.rates[key]
	if len(l.rates) >= RateClients && !known {
		return ErrTooManyEvents
	}
	if !known || entry.minute != minute {
		entry = rate{minute: minute}
	}
	entry.count++
	l.rates[key] = entry
	if entry.count-1 >= RatePerMinute {
		return ErrTooManyEvents
	}
	return nil
}
