package observer

import (
	"context"
	"math"
	"regexp"
	"sort"
	"strings"
	"time"

	"rt.local/core-go/apperr"
	"rt.local/core-go/internal/js"
	"rt.local/core-go/nosql"
)

// Partition is the prefix of the daily partitions ("OBSERVER#2026-03-04").
const Partition = "OBSERVER#"

// TTL is how long events are kept (seven days).
const TTL = 7 * 24 * time.Hour

// Errors of log queries and reports (HTTP 400).
var (
	ErrInvalidDay    = apperr.BadRequest("Invalid day")
	ErrInvalidLevel  = apperr.BadRequest("Invalid level")
	ErrInvalidFilter = apperr.BadRequest("Invalid log filter")
)

// ---------------------------------------------------------------- log queries

// LogQuery filters one UTC day of logs. Empty fields do not filter; without Level, debug events
// are hidden. Cursor continues a previous page.
type LogQuery struct {
	Day       string
	Level     string
	Category  string
	RequestID string
	SessionID string
	Text      string
	Cursor    string
}

// LogPage is one page of a search: an empty page can still have a Cursor.
type LogPage struct {
	Events []map[string]any `json:"events"`
	Cursor string           `json:"cursor,omitempty"`
}

// LogReader answers log searches (Store, or a cloud log service).
type LogReader interface {
	Search(ctx context.Context, query LogQuery) (LogPage, error)
}

var dayPattern = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}$`)

// ValidDay reports whether day is YYYY-MM-DD naming a real proleptic Gregorian date (year 0000
// included).
func ValidDay(day string) bool {
	if !dayPattern.MatchString(day) {
		return false
	}
	year, month, date := atoi(day[:4]), atoi(day[5:7]), atoi(day[8:])
	if month < 1 || month > 12 || date < 1 {
		return false
	}
	days := []int{31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31}[month-1]
	if month == 2 && year%4 == 0 && (year%100 != 0 || year%400 == 0) {
		days = 29
	}
	return date <= days
}

func atoi(s string) int {
	n := 0
	for _, c := range s {
		n = n*10 + int(c-'0')
	}
	return n
}

// ValidateLogQuery checks the day, the level and the filter lengths (200 UTF-16 units, cursor
// 8192), in that order.
func ValidateLogQuery(q LogQuery) error {
	if !ValidDay(q.Day) {
		return ErrInvalidDay
	}
	if q.Level != "" && !allows(Levels, q.Level) {
		return ErrInvalidLevel
	}
	for _, value := range []string{q.Category, q.RequestID, q.SessionID, q.Text} {
		if js.Len(value) > 200 {
			return ErrInvalidFilter
		}
	}
	if js.Len(q.Cursor) > 8192 {
		return ErrInvalidFilter
	}
	return nil
}

// ParseLogQuery reads a loosely typed query (decoded JSON or query parameters) with the checks of
// the reference in its order: a day that is not a string is an invalid day, a truthy level that is
// not a string an invalid level, and present filters that are not strings invalid filters.
func ParseLogQuery(values map[string]any) (LogQuery, error) {
	var q LogQuery
	day, _ := values["day"].(string)
	if !ValidDay(day) {
		return q, ErrInvalidDay
	}
	q.Day = day
	switch level := values["level"].(type) {
	case string:
		q.Level = level
	default:
		if js.Truthy(level) {
			return q, ErrInvalidLevel
		}
	}
	if q.Level != "" && !allows(Levels, q.Level) {
		return q, ErrInvalidLevel
	}
	for key, into := range map[string]*string{"category": &q.Category, "requestId": &q.RequestID, "sessionId": &q.SessionID, "text": &q.Text, "cursor": &q.Cursor} {
		value, present := values[key]
		if !present || value == nil {
			continue
		}
		s, ok := value.(string)
		if !ok {
			return q, ErrInvalidFilter
		}
		*into = s
	}
	return q, ValidateLogQuery(q)
}

// MatchesLog applies the level (debug hidden by default), the exact correlation filters and the
// case-insensitive text search over the JSON text of the event.
func MatchesLog(event map[string]any, q LogQuery) bool {
	level, _ := event["level"].(string)
	if q.Level == "" && level == "debug" || q.Level != "" && level != q.Level {
		return false
	}
	for key, filter := range map[string]string{"category": q.Category, "requestId": q.RequestID, "sessionId": q.SessionID} {
		if filter != "" && !js.Equal(event[key], filter) {
			return false
		}
	}
	return q.Text == "" || strings.Contains(js.ToLower(stringifyEvent(event)), js.ToLower(q.Text))
}

// ---------------------------------------------------------------- storage

// Store keeps events in daily partitions with a seven-day TTL (an Observer output and a LogReader).
type Store struct {
	db  nosql.Store
	now func() time.Time
}

// NewStore returns a Store over db; now is the clock of TTL checks (nil: the system clock).
func NewStore(db nosql.Store, now func() time.Time) *Store {
	if now == nil {
		now = time.Now
	}
	return &Store{db: db, now: now}
}

// ID is "store".
func (s *Store) ID() string { return "store" }

// Write creates the event row; a duplicate (same time and id) is a Conflict.
func (s *Store) Write(ctx context.Context, event Event) error {
	row := nosql.Row{PK: Partition + prefix(event.At, 10), SK: event.At + "#" + event.ID, Version: 1, Data: event.Map()}
	if at, ok := parseTime(event.At); ok {
		ttl := int64(math.Floor(float64(at.UnixMilli())/1000)) + int64(TTL/time.Second)
		row.TTL = &ttl
	}
	return s.db.Transact(ctx, []nosql.Write{{Row: row}})
}

func prefix(s string, n int) string {
	if len(s) < n {
		return s
	}
	return s[:n]
}

// parseTime is Date.parse for the ISO 8601 forms events use (a date alone is UTC midnight).
func parseTime(at string) (time.Time, bool) {
	if t, err := time.Parse(time.RFC3339Nano, at); err == nil {
		return t, true
	}
	if t, err := time.Parse("2006-01-02", at); err == nil {
		return t, true
	}
	return time.Time{}, false
}

// live returns the events of rows whose TTL (when truthy) is still in the future.
func (s *Store) live(rows []nosql.Row) []map[string]any {
	now := float64(s.now().UnixMilli()) / 1000
	events := []map[string]any{}
	for _, row := range rows {
		if row.TTL == nil || *row.TTL == 0 || float64(*row.TTL) > now {
			events = append(events, row.Data)
		}
	}
	return events
}

// Search reads one store page (query.Cursor) and returns the matching events.
func (s *Store) Search(ctx context.Context, q LogQuery) (LogPage, error) {
	if err := ValidateLogQuery(q); err != nil {
		return LogPage{}, err
	}
	page, err := s.db.List(ctx, Partition+q.Day, q.Cursor)
	if err != nil {
		return LogPage{}, err
	}
	result := LogPage{Events: []map[string]any{}, Cursor: page.Cursor}
	for _, event := range s.live(page.Items) {
		if MatchesLog(event, q) {
			result.Events = append(result.Events, event)
		}
	}
	return result, nil
}

// ---------------------------------------------------------------- reports

// Report summarizes the loaded events of one UTC day (at most 20 store pages).
type Report struct {
	Day              string           `json:"day"`
	Counts           Counts           `json:"counts"`
	Analytics        []NameCount      `json:"analytics"`
	RequestMetrics   []Metric         `json:"requestMetrics"`
	OperationMetrics []Metric         `json:"operationMetrics"`
	AverageMs        float64          `json:"averageMs"`
	Hours            []Hour           `json:"hours"`
	Pages            []PageViews      `json:"pages"`
	Events           []map[string]any `json:"events"`
	Partial          bool             `json:"partial"`
}

// Counts are totals of the loaded events.
type Counts struct {
	Requests int `json:"requests"`
	Errors   int `json:"errors"`
	SPA      int `json:"spa"`
	SSR      int `json:"ssr"`
}

// NameCount counts analytics events by name (message).
type NameCount struct {
	Name  any `json:"name"`
	Count int `json:"count"`
}

// Metric aggregates durations of requests ("METHOD path") or operations (timing names).
type Metric struct {
	Name      string  `json:"name"`
	Source    any     `json:"source"`
	Count     int     `json:"count"`
	MinMs     float64 `json:"minMs"`
	MaxMs     float64 `json:"maxMs"`
	Errors    int     `json:"errors"`
	AverageMs float64 `json:"averageMs"`
	totalMs   float64
}

// Hour counts requests and page views of one UTC hour.
type Hour struct {
	Hour     int `json:"hour"`
	Requests int `json:"requests"`
	Views    int `json:"views"`
}

// PageViews counts views of one page per source.
type PageViews struct {
	Source string `json:"source"`
	Path   string `json:"path"`
	Views  int    `json:"views"`
}

// Report aggregates up to 20 pages of day, which must be a real YYYY-MM-DD date (400 "Invalid day").
func (s *Store) Report(ctx context.Context, day string) (Report, error) {
	if !ValidDay(day) {
		return Report{}, ErrInvalidDay
	}
	var events []map[string]any
	cursor := ""
	for range 20 {
		page, err := s.db.List(ctx, Partition+day, cursor)
		if err != nil {
			return Report{}, err
		}
		events = append(events, s.live(page.Items)...)
		cursor = page.Cursor
		if cursor == "" {
			break
		}
	}
	return aggregate(day, events, cursor != ""), nil
}

// jsString is String(value) for a field that may be missing ("undefined") or null ("null").
func jsString(m map[string]any, key string) string {
	v, ok := m[key]
	switch {
	case !ok:
		return "undefined"
	case v == nil:
		return "null"
	}
	return js.String(v)
}

// jsRound is Math.round: halves go up.
func jsRound(x float64) float64 {
	if math.IsNaN(x) || math.IsInf(x, 0) {
		return x
	}
	floor := math.Floor(x)
	if x-floor >= 0.5 {
		return floor + 1
	}
	return floor
}

func finiteMs(v any) (float64, bool) {
	f, ok := v.(float64)
	if !ok {
		if i, isInt := v.(int); isInt {
			f, ok = float64(i), true
		}
	}
	return f, ok && !math.IsNaN(f) && !math.IsInf(f, 0) && f >= 0
}

type metrics struct {
	order []string
	byKey map[string]*Metric
}

func (m *metrics) add(key, label string, ms any, failed bool, source any) {
	value, ok := finiteMs(ms)
	if !ok {
		return
	}
	metric := m.byKey[key]
	if metric == nil {
		metric = &Metric{Name: label, Source: source, MinMs: value, MaxMs: value}
		m.byKey[key] = metric
		m.order = append(m.order, key)
	}
	metric.Count++
	metric.totalMs += value
	metric.MinMs = math.Min(metric.MinMs, value)
	metric.MaxMs = math.Max(metric.MaxMs, value)
	if failed {
		metric.Errors++
	}
}

func (m *metrics) list() []Metric {
	out := make([]Metric, 0, len(m.order))
	for _, key := range m.order {
		metric := *m.byKey[key]
		metric.AverageMs = jsRound(metric.totalMs/float64(metric.Count)*100) / 100
		out = append(out, metric)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Count > out[j].Count })
	return out
}

func aggregate(day string, events []map[string]any, partial bool) Report {
	report := Report{Day: day, Analytics: []NameCount{}, Hours: make([]Hour, 24), Pages: []PageViews{}, Partial: partial}
	for hour := range report.Hours {
		report.Hours[hour].Hour = hour
	}
	requests := &metrics{byKey: map[string]*Metric{}}
	operations := &metrics{byKey: map[string]*Metric{}}
	analyticsIndex := map[string]int{}
	pageIndex := map[string]int{}
	duration := 0.0
	for _, event := range events {
		var hour *Hour
		if at, ok := event["at"].(string); ok {
			if t, ok := parseTime(at); ok {
				hour = &report.Hours[t.UTC().Hour()]
			}
		}
		data, _ := event["data"].(map[string]any)
		if data == nil {
			data = map[string]any{}
		}
		kind, _ := event["kind"].(string)
		if level, _ := event["level"].(string); level == "error" {
			report.Counts.Errors++
		}
		switch kind {
		case "analytics":
			key := jsString(event, "message")
			if i, ok := analyticsIndex[key]; ok {
				report.Analytics[i].Count++
			} else {
				analyticsIndex[key] = len(report.Analytics)
				report.Analytics = append(report.Analytics, NameCount{Name: event["message"], Count: 1})
			}
		case "request":
			report.Counts.Requests++
			ms := js.Field(data, "durationMs")
			if !math.IsNaN(ms) {
				duration += ms
			}
			label := jsString(data, "method") + " " + jsString(data, "path")
			requests.add(label, label, data["durationMs"], js.Field(data, "status") >= 500, event["source"])
			if hour != nil {
				hour.Requests++
			}
		case "timing":
			name := jsString(data, "name")
			failed, _ := data["failed"].(bool)
			operations.add(jsString(event, "source")+":"+name, name, data["durationMs"], failed, event["source"])
		case "pageview":
			source, _ := event["source"].(string)
			if source != "spa" && source != "ssr" {
				break
			}
			if source == "spa" {
				report.Counts.SPA++
			} else {
				report.Counts.SSR++
			}
			if hour != nil {
				hour.Views++
			}
			path := jsString(data, "path")
			if i, ok := pageIndex[source+path]; ok {
				report.Pages[i].Views++
			} else {
				pageIndex[source+path] = len(report.Pages)
				report.Pages = append(report.Pages, PageViews{Source: source, Path: path, Views: 1})
			}
		}
	}
	sort.SliceStable(report.Analytics, func(i, j int) bool { return report.Analytics[i].Count > report.Analytics[j].Count })
	sort.SliceStable(report.Pages, func(i, j int) bool { return report.Pages[i].Views > report.Pages[j].Views })
	report.Pages = report.Pages[:min(len(report.Pages), 30)]
	report.RequestMetrics = requests.list()
	report.OperationMetrics = operations.list()
	if report.Counts.Requests > 0 {
		report.AverageMs = jsRound(duration / float64(report.Counts.Requests))
	}
	// Newest first; ties keep storage order.
	sorted := append([]map[string]any{}, events...)
	sort.SliceStable(sorted, func(i, j int) bool { return jsString(sorted[i], "at") > jsString(sorted[j], "at") })
	report.Events = sorted[:min(len(sorted), 100)]
	return report
}
