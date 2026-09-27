// Package jsonstore is a nosql.Store in one local JSON file, the port of
// @gsalgadotoledo/rt-app-json JsonStore. Every language reads and writes the same file, so a
// database created by the TypeScript server opens here and vice versa
// (rt-app/spec/contracts/json.contract.yaml pins the format). Small local databases only.
//
//	store := jsonstore.New(".rt-app/local.json")
//	secret, err := jsonstore.LocalSecret(".rt-app/local.json") // the auth key kept next to it
//
// The file is JSON.stringify({format: 1, rows: [...]}): rows keep their first-insertion order and
// any fields this package does not know, and every write re-serializes the file the way
// JavaScript does (JavaScript numbers, JSON.stringify escapes, array-index keys first).
// Processes coordinate through "<file>.lock" (created exclusively, polled every 20 ms, 5 s
// timeout) and writes replace the file atomically (temporary file, fsync, rename; mode 0600).
// Every transaction drops OBSERVER#…, CACHE#… and VISITS rows whose ttl (seconds) is at or
// before the clock; reads never drop rows.
package jsonstore

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"rt.local/core-go/apperr"
	"rt.local/core-go/internal/canonical"
	"rt.local/core-go/internal/uuid"
	"rt.local/core-go/nosql"
)

// Errors with the TypeScript messages.
var (
	ErrInvalidDatabase      = errors.New("Invalid JSON database")
	ErrDuplicateDatabaseKey = errors.New("Duplicate JSON database key")
	ErrInvalidRow           = errors.New("Invalid JSON row")
	ErrInvalidSecret        = errors.New("Invalid local auth key; restore it with the matching database")
)

// DefaultLockTimeout is how long an operation waits for "<file>.lock".
const DefaultLockTimeout = 5 * time.Second

const lockPoll = 20 * time.Millisecond

// maxSafeInteger is Number.MAX_SAFE_INTEGER.
const maxSafeInteger = 1<<53 - 1

// Store is a nosql.Store in a local JSON file. It is safe for concurrent use; the lock file
// serializes processes.
type Store struct {
	file        string
	lockTimeout time.Duration
	now         func() time.Time
	mu          sync.Mutex // serializes this instance; the lock file serializes everything else
}

// Option configures a Store.
type Option func(*Store)

// WithLockTimeout sets how long operations wait for the lock file (default 5 s; the first
// attempt always runs).
func WithLockTimeout(d time.Duration) Option { return func(s *Store) { s.lockTimeout = d } }

// WithClock sets the clock of TTL retention (default time.Now); lock waits use real time.
func WithClock(now func() time.Time) Option { return func(s *Store) { s.now = now } }

// New returns a store on path (made absolute). Nothing is read until the first operation.
func New(path string, opts ...Option) *Store {
	if abs, err := filepath.Abs(path); err == nil {
		path = abs
	}
	s := &Store{file: path, lockTimeout: DefaultLockTimeout, now: time.Now}
	for _, opt := range opts {
		opt(s)
	}
	return s
}

// File is the absolute path of the database file.
func (s *Store) File() string { return s.file }

// entry is one stored row: its JSON as read (unknown fields kept) and its key.
type entry struct {
	key string
	row *value
}

type table struct {
	order []string
	rows  map[string]*entry
}

// rowKey is JSON.stringify([pk, sk]), the key of the TypeScript store.
func rowKey(pk, sk string) string { return "[" + canonical.Quote(pk) + "," + canonical.Quote(sk) + "]" }

func (t *table) put(e *entry) {
	if _, ok := t.rows[e.key]; !ok {
		t.order = append(t.order, e.key)
	}
	t.rows[e.key] = e
}

func (t *table) remove(key string) {
	if _, ok := t.rows[key]; ok {
		delete(t.rows, key)
		t.order = slices.DeleteFunc(t.order, func(k string) bool { return k == key })
	}
}

func (s *Store) locked(ctx context.Context, operation func(*table) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.MkdirAll(filepath.Dir(s.file), 0o700); err != nil {
		return err
	}
	lock := s.file + ".lock"
	deadline := time.Now().Add(s.lockTimeout)
	for {
		handle, err := os.OpenFile(lock, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			_ = handle.Close()
			break
		}
		if !errors.Is(err, fs.ErrExist) {
			return err
		}
		if !time.Now().Before(deadline) {
			return fmt.Errorf("JSON store locked: %s. Stop writers before removing a stale lock.", lock)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(lockPoll):
		}
	}
	defer os.Remove(lock)
	rows, err := s.read()
	if err != nil {
		return err
	}
	return operation(rows)
}

func (s *Store) read() (*table, error) {
	out := &table{rows: map[string]*entry{}}
	raw, err := os.ReadFile(s.file)
	if errors.Is(err, fs.ErrNotExist) {
		return out, nil
	}
	if err != nil {
		return nil, err
	}
	document, err := parse(raw)
	if err != nil {
		return nil, ErrInvalidDatabase
	}
	format, _ := document.get("format")
	rows, _ := document.get("rows")
	if format == nil || format.kind != kindNumber || format.num != 1 || rows == nil || rows.kind != kindArray {
		return nil, ErrInvalidDatabase
	}
	for _, row := range rows.array {
		if !validRow(row) {
			return nil, ErrInvalidDatabase
		}
	}
	for _, row := range rows.array {
		pk, _ := row.get("pk")
		sk, _ := row.get("sk")
		key := rowKey(pk.str, sk.str)
		if _, dup := out.rows[key]; dup {
			return nil, ErrDuplicateDatabaseKey
		}
		out.put(&entry{key: key, row: row})
	}
	return out, nil
}

// validRow: a string pk and sk, a safe-integer version and a non-array object data.
func validRow(row *value) bool {
	pk, okPK := row.get("pk")
	sk, okSK := row.get("sk")
	version, okVersion := row.get("version")
	data, okData := row.get("data")
	return okPK && pk.kind == kindString && okSK && sk.kind == kindString &&
		okVersion && version.kind == kindNumber && version.num == math.Trunc(version.num) && math.Abs(version.num) <= maxSafeInteger &&
		okData && data.kind == kindObject
}

// toRow converts a stored row. Fields a nosql.Row has no place for are not returned (they stay in
// the file); a ttl that is not an integer is left out of Row.TTL.
func toRow(v *value) nosql.Row {
	pk, _ := v.get("pk")
	sk, _ := v.get("sk")
	version, _ := v.get("version")
	data, _ := v.get("data")
	row := nosql.Row{PK: pk.str, SK: sk.str, Version: int(version.num), Data: data.native().(map[string]any)}
	if ttl, ok := v.get("ttl"); ok && ttl.kind == kindNumber && ttl.num == math.Trunc(ttl.num) && math.Abs(ttl.num) <= maxSafeInteger {
		n := int64(ttl.num)
		row.TTL = &n
	}
	return row
}

// fromRow builds the stored form of a row: pk, sk, version, data, ttl.
func fromRow(row nosql.Row) (*value, error) {
	out := newObject()
	out.set("pk", &value{kind: kindString, str: row.PK})
	out.set("sk", &value{kind: kindString, str: row.SK})
	out.set("version", &value{kind: kindNumber, num: float64(row.Version)})
	if row.Data == nil {
		return nil, ErrInvalidRow
	}
	data, err := fromNative(row.Data)
	if err != nil {
		return nil, err
	}
	out.set("data", data)
	if row.TTL != nil {
		out.set("ttl", &value{kind: kindNumber, num: float64(*row.TTL)})
	}
	return out, nil
}

// expired is the retention rule: a retained partition and a truthy ttl <= now (seconds).
func expired(row *value, nowSeconds float64) bool {
	pk, _ := row.get("pk")
	if !strings.HasPrefix(pk.str, "OBSERVER#") && !strings.HasPrefix(pk.str, "CACHE#") && pk.str != "VISITS" {
		return false
	}
	ttl, ok := row.get("ttl")
	if !ok || !ttl.truthy() {
		return false
	}
	n := ttl.number()
	return !math.IsNaN(n) && n <= nowSeconds
}

// Get returns one row, or (nil, nil).
func (s *Store) Get(ctx context.Context, pk, sk string) (*nosql.Row, error) {
	var found *nosql.Row
	err := s.locked(ctx, func(t *table) error {
		if e, ok := t.rows[rowKey(pk, sk)]; ok {
			row := toRow(e.row)
			found = &row
		}
		return nil
	})
	return found, err
}

type pending struct {
	key    string
	row    *value
	valid  bool
	expect *int
	delete bool
}

// Transact checks each write in order (a valid row: ErrInvalidRow; a new key:
// nosql.ErrDuplicateKey; its version guard: apperr.Conflict()), applies them, runs retention and
// rewrites the file atomically. A failure writes nothing. A row is valid when Version is a safe
// integer and Data is not nil; a delete may leave Data nil (TypeScript callers always pass the
// whole row, Go callers may pass only the key).
func (s *Store) Transact(ctx context.Context, writes []nosql.Write) error {
	// Copy before waiting for the lock: callers cannot change a queued transaction.
	snapshot := make([]pending, len(writes))
	for i, w := range writes {
		p := pending{key: rowKey(w.Row.PK, w.Row.SK), expect: w.Expected, delete: w.Delete}
		if w.Row.Version <= maxSafeInteger && w.Row.Version >= -maxSafeInteger && (w.Row.Data != nil || w.Delete) {
			if w.Row.Data == nil {
				w.Row.Data = map[string]any{} // a delete identifies its row by key
			}
			row, err := fromRow(w.Row)
			if err != nil {
				return err
			}
			p.row, p.valid = row, true
		}
		if w.Expected != nil {
			expected := *w.Expected
			p.expect = &expected
		}
		snapshot[i] = p
	}
	return s.locked(ctx, func(t *table) error {
		seen := map[string]bool{}
		for _, w := range snapshot {
			if !w.valid {
				return ErrInvalidRow
			}
			if seen[w.key] {
				return nosql.ErrDuplicateKey
			}
			seen[w.key] = true
			old, exists := t.rows[w.key]
			if w.expect == nil && exists || w.expect != nil && (!exists || !sameVersion(old.row, *w.expect)) {
				return apperr.Conflict()
			}
		}
		for _, w := range snapshot {
			if w.delete {
				t.remove(w.key)
			} else {
				t.put(&entry{key: w.key, row: w.row})
			}
		}
		now := float64(s.now().UnixMilli()) / 1000
		for _, key := range slices.Clone(t.order) {
			if expired(t.rows[key].row, now) {
				t.remove(key)
			}
		}
		return s.write(t)
	})
}

func sameVersion(row *value, expected int) bool {
	version, _ := row.get("version")
	return version.kind == kindNumber && version.num == float64(expected)
}

func (s *Store) write(t *table) error {
	var b bytes.Buffer
	b.WriteString(`{"format":1,"rows":[`)
	for i, key := range t.order {
		if i > 0 {
			b.WriteByte(',')
		}
		t.rows[key].row.write(&b)
	}
	b.WriteString("]}")
	temp := s.file + "." + uuid.New() + ".tmp"
	defer os.Remove(temp)
	out, err := os.OpenFile(temp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err = out.Write(b.Bytes()); err == nil {
		err = out.Sync()
	}
	if closeErr := out.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(temp, s.file)
}

// List returns up to 50 rows of one partition in code point order of SK, and a cursor when
// more exist. A cursor from another partition returns 400 "Invalid cursor".
func (s *Store) List(ctx context.Context, pk, cursor string) (nosql.Page, error) {
	after := ""
	if cursor != "" {
		var err error
		if after, err = nosql.DecodeCursor(pk, cursor); err != nil {
			return nosql.Page{}, err
		}
	}
	page := nosql.Page{Items: []nosql.Row{}}
	err := s.locked(ctx, func(t *table) error {
		var matching []nosql.Row
		for _, key := range t.order {
			row := toRow(t.rows[key].row)
			if row.PK == pk && row.SK > after {
				matching = append(matching, row)
			}
		}
		slices.SortFunc(matching, func(a, b nosql.Row) int { return strings.Compare(a.SK, b.SK) })
		page.Items = append(page.Items, matching[:min(len(matching), nosql.PageSize)]...)
		if len(matching) > nosql.PageSize {
			next, err := nosql.EncodeCursor(pk, page.Items[nosql.PageSize-1].SK)
			page.Cursor = next
			return err
		}
		return nil
	})
	return page, err
}

// Close releases nothing: every operation opens and closes the file.
func (s *Store) Close() error { return nil }

var secretPattern = regexp.MustCompile(`^[a-f0-9]{96}$`)

// LocalSecret returns the local auth key kept next to a database, "<database>.key": created once
// (exclusively, mode 0600) with 96 lowercase hex characters, and kept afterwards. A file that is
// not exactly that returns ErrInvalidSecret.
func LocalSecret(database string) (string, error) {
	abs, err := filepath.Abs(database)
	if err != nil {
		return "", err
	}
	file := abs + ".key"
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		return "", err
	}
	out, err := os.OpenFile(file, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	switch {
	case err == nil:
		secret := make([]byte, 48)
		_, _ = rand.Read(secret)
		_, err = out.WriteString(hex.EncodeToString(secret))
		if err == nil {
			err = out.Sync()
		}
		if closeErr := out.Close(); err == nil {
			err = closeErr
		}
		if err != nil {
			return "", err
		}
	case !errors.Is(err, fs.ErrExist):
		return "", err
	}
	key, err := os.ReadFile(file)
	if err != nil {
		return "", err
	}
	if !secretPattern.Match(key) {
		return "", ErrInvalidSecret
	}
	return string(key), nil
}

var _ nosql.Store = (*Store)(nil)
