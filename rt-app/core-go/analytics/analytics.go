// Package analytics adds product analytics to the Observer pipeline, with the behavior of the
// TypeScript reference (@gsalgadotoledo/rt-app-analytics) and the analytics contract.
//
// Analytics validates event names and delegates to an Observer under the log category
// "analytics": Track emits an "info" event of kind "analytics" and PageView counts a page view.
// It has no endpoints and no storage; filtering, sanitizing and delivery are the Observer's job,
// so any type with the three methods of Observer works (an Observer port or an adapter).
package analytics

import (
	"context"
	"errors"
	"regexp"
)

// Category is the log category of every analytics event.
const Category = "analytics"

// ErrInvalidName is returned for event names that are not stable identifiers.
var ErrInvalidName = errors.New("Use a stable analytics event name")

var eventName = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9._-]{0,79}$`)

// View is a page view: URL (path or absolute URL), APIURL (optional) and Source (optional; the
// Observer defaults it to "spa").
type View struct {
	URL    string `json:"url"`
	APIURL string `json:"apiUrl,omitempty"`
	Source string `json:"source,omitempty"`
}

// Observer is what Analytics needs from the Observer. WithContext returns ctx with fields merged
// over its log context (category, requestId, sessionId); Emit and CountView read it from ctx.
type Observer interface {
	WithContext(ctx context.Context, fields map[string]string) context.Context
	Emit(ctx context.Context, level, kind, source, message string, data map[string]any) error
	CountView(ctx context.Context, message string, view View) error
}

// Analytics is safe for concurrent use if its Observer is.
type Analytics struct {
	observer Observer
}

// New returns Analytics over observer.
func New(observer Observer) *Analytics { return &Analytics{observer: observer} }

// ValidName reports whether name is a stable event name: ^[a-zA-Z][a-zA-Z0-9._-]{0,79}$ (ASCII).
func ValidName(name string) bool { return eventName.MatchString(name) }

// Track emits name with properties (nil is {}) from source ("" is "app").
func (a *Analytics) Track(ctx context.Context, name string, properties map[string]any, source string) error {
	if !ValidName(name) {
		return ErrInvalidName
	}
	if properties == nil {
		properties = map[string]any{}
	}
	if source == "" {
		source = "app"
	}
	return a.observer.Emit(a.observer.WithContext(ctx, map[string]string{"category": Category}), "info", "analytics", source, name, properties)
}

// PageView counts a view of title.
func (a *Analytics) PageView(ctx context.Context, title string, view View) error {
	return a.observer.CountView(a.observer.WithContext(ctx, map[string]string{"category": Category}), title, view)
}
