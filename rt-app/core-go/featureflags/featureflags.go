// Package featureflags provides boolean flags with deterministic percentage rollouts and
// explicit subject targeting, stored in a nosql.Store under partition FLAGS.
//
// Behavior matches the TypeScript reference (@gsalgadotoledo/rt-app-feature-flags) and the
// feature-flags contract: string limits count UTF-16 code units, the rollout bucket is the
// first 4 bytes of sha256(key + "\x00" + subject) as a big-endian uint32 / 2^32 * 100.
package featureflags

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"math"
	"regexp"
	"slices"
	"time"

	"rt.local/core-go/apperr"
	"rt.local/core-go/nosql"
)

// Partition is the store partition that holds flag definitions.
const Partition = "FLAGS"

// Limits of a definition. Lengths are UTF-16 code units (JavaScript string length).
const (
	MaxDescription   = 400
	MaxSubjects      = 100
	MaxSubjectLength = 120
	MaxEvaluateKeys  = 20
)

var keyPattern = regexp.MustCompile(`^[a-z][a-z0-9._-]{0,79}$`)

// Errors returned for invalid input (all 400).
var (
	ErrInvalidKey     = apperr.BadRequest("Invalid flag key")
	ErrInvalidConfig  = apperr.BadRequest("Invalid flag configuration")
	ErrInvalidSubject = apperr.BadRequest("Invalid flag subject")
)

// Flag is a stored definition with its audit fields and version.
type Flag struct {
	Key         string   `json:"key"`
	Description string   `json:"description"`
	Enabled     bool     `json:"enabled"`
	Public      bool     `json:"public"`
	Rollout     float64  `json:"rollout"`
	Subjects    []string `json:"subjects"`
	UpdatedAt   string   `json:"updatedAt"`
	UpdatedBy   string   `json:"updatedBy"`
	Version     int      `json:"version"`
}

// Definition is what an owner edits.
type Definition struct {
	Description string   `json:"description"`
	Enabled     bool     `json:"enabled"`
	Public      bool     `json:"public"`
	Rollout     float64  `json:"rollout"`
	Subjects    []string `json:"subjects"`
}

// Page is one storage page of definitions. Cursor is opaque; pass it back unchanged.
type Page struct {
	Items  []Flag `json:"items"`
	Cursor string `json:"cursor,omitempty"`
}

// FeatureFlags evaluates and edits flags. It is safe for concurrent use if its store is.
type FeatureFlags struct {
	store nosql.Store
	now   func() time.Time
}

// Option configures FeatureFlags.
type Option func(*FeatureFlags)

// WithClock sets the clock used for updatedAt (default time.Now).
func WithClock(now func() time.Time) Option { return func(f *FeatureFlags) { f.now = now } }

// New returns flags backed by store.
func New(store nosql.Store, options ...Option) *FeatureFlags {
	f := &FeatureFlags{store: store, now: time.Now}
	for _, option := range options {
		option(f)
	}
	return f
}

// ValidateKey returns ErrInvalidKey unless key matches ^[a-z][a-z0-9._-]{0,79}$.
func ValidateKey(key string) error {
	if !keyPattern.MatchString(key) {
		return ErrInvalidKey
	}
	return nil
}

// List returns one storage page of definitions (admin only: it reveals targeting rules).
func (f *FeatureFlags) List(ctx context.Context, cursor string) (Page, error) {
	page, err := f.store.List(ctx, Partition, cursor)
	if err != nil {
		return Page{}, err
	}
	out := Page{Items: make([]Flag, 0, len(page.Items)), Cursor: page.Cursor}
	for _, row := range page.Items {
		flag, err := fromRow(row)
		if err != nil {
			return Page{}, err
		}
		out.Items = append(out.Items, flag)
	}
	return out, nil
}

// Get returns the flag, or (nil, nil) when it does not exist.
func (f *FeatureFlags) Get(ctx context.Context, key string) (*Flag, error) {
	if err := ValidateKey(key); err != nil {
		return nil, err
	}
	row, err := f.store.Get(ctx, Partition, key)
	if err != nil || row == nil {
		return nil, err
	}
	flag, err := fromRow(*row)
	if err != nil {
		return nil, err
	}
	return &flag, nil
}

// Save creates a flag (version nil) or updates it (the current version), auditing actorID.
// A stale or existing version returns apperr.Conflict(). Subjects are de-duplicated in order.
func (f *FeatureFlags) Save(ctx context.Context, key string, def Definition, version *int, actorID string) (Flag, error) {
	if err := ValidateKey(key); err != nil {
		return Flag{}, err
	}
	if !validDefinition(def) || version != nil && (*version <= 0 || *version > maxSafeInteger) {
		return Flag{}, ErrInvalidConfig
	}
	subjects := make([]string, 0, len(def.Subjects))
	for _, s := range def.Subjects {
		if !slices.Contains(subjects, s) {
			subjects = append(subjects, s)
		}
	}
	next := 1
	if version != nil {
		next = *version + 1
	}
	flag := Flag{
		Key:         key,
		Description: def.Description,
		Enabled:     def.Enabled,
		Public:      def.Public,
		Rollout:     def.Rollout,
		Subjects:    subjects,
		UpdatedAt:   isoTime(f.now()),
		UpdatedBy:   actorID,
		Version:     next,
	}
	err := f.store.Transact(ctx, []nosql.Write{{
		Row:      nosql.Row{PK: Partition, SK: key, Version: next, Data: toData(flag)},
		Expected: version,
	}})
	if err != nil {
		return Flag{}, err
	}
	return flag, nil
}

// Enabled evaluates a flag for subject ("" for none). Unknown and disabled flags are off;
// with publicOnly, private flags are off too. Listed subjects are always on; otherwise the
// subject's rollout bucket must be below the rollout percentage.
func (f *FeatureFlags) Enabled(ctx context.Context, key, subject string, publicOnly bool) (bool, error) {
	if utf16Len(subject) > MaxSubjectLength {
		return false, ErrInvalidSubject
	}
	flag, err := f.Get(ctx, key)
	if err != nil || flag == nil || !flag.Enabled || publicOnly && !flag.Public {
		return false, err
	}
	if subject != "" && slices.Contains(flag.Subjects, subject) {
		return true, nil
	}
	if flag.Rollout == 100 {
		return true, nil
	}
	if subject == "" || flag.Rollout == 0 {
		return false, nil
	}
	return Bucket(key, subject) < flag.Rollout, nil
}

// Bucket returns the subject's rollout position in [0, 100) for key.
func Bucket(key, subject string) float64 {
	sum := sha256.Sum256([]byte(key + "\x00" + subject))
	return float64(binary.BigEndian.Uint32(sum[:4])) / 0x100000000 * 100
}

func validDefinition(def Definition) bool {
	if utf16Len(def.Description) > MaxDescription ||
		math.IsNaN(def.Rollout) || math.IsInf(def.Rollout, 0) || def.Rollout < 0 || def.Rollout > 100 ||
		len(def.Subjects) > MaxSubjects {
		return false
	}
	for _, s := range def.Subjects {
		if utf16Len(s) > MaxSubjectLength {
			return false
		}
	}
	return true
}

// utf16Len is JavaScript's String.prototype.length: code points above U+FFFF are surrogate
// pairs (utf16.RuneLen, which needs Go 1.23; this module supports Go 1.22).
func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		n++
		if r > 0xFFFF {
			n++
		}
	}
	return n
}

// isoTime formats like JavaScript's Date.prototype.toISOString: UTC, milliseconds, "Z".
func isoTime(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

func toData(flag Flag) map[string]any {
	return map[string]any{
		"key":         flag.Key,
		"description": flag.Description,
		"enabled":     flag.Enabled,
		"public":      flag.Public,
		"rollout":     flag.Rollout,
		"subjects":    flag.Subjects,
		"updatedAt":   flag.UpdatedAt,
		"updatedBy":   flag.UpdatedBy,
	}
}

// fromRow reads a stored definition; the row version is authoritative.
func fromRow(row nosql.Row) (Flag, error) {
	raw, err := json.Marshal(row.Data)
	if err != nil {
		return Flag{}, err
	}
	var flag Flag
	if err := json.Unmarshal(raw, &flag); err != nil {
		return Flag{}, err
	}
	if flag.Subjects == nil {
		flag.Subjects = []string{}
	}
	flag.Version = row.Version
	return flag, nil
}
