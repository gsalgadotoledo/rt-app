package cache

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"rt.local/core-go/apperr"
	"rt.local/core-go/internal/js"
	"rt.local/core-go/nosql"
)

// NewFile returns a cache in a local JSON file (FileCache), shared by every process on this
// machine; an empty path means ".rt-app/cache.json". Use a dedicated file, not the application
// database; small datasets only.
func NewFile(path, namespace string, opts ...Option) *NoSQL {
	if path == "" {
		path = ".rt-app/cache.json"
	}
	return NewNoSQL(NewFileStore(path), namespace, opts...)
}

// FileStore is the JsonStore file format of @gsalgadotoledo/rt-app-json: {"format":1,"rows":[…]}.
// Writers take an exclusive "<file>.lock" (polled every 20 ms, 5 s timeout) and replace the file
// atomically. Every write drops CACHE#, OBSERVER# and VISITS rows whose ttl (seconds) has passed
// in real time.
type FileStore struct {
	file        string
	lockTimeout time.Duration
	mu          sync.Mutex // serializes this process; the lock file serializes processes
}

// NewFileStore returns a store on path (resolved to an absolute path).
func NewFileStore(path string) *FileStore {
	if abs, err := filepath.Abs(path); err == nil {
		path = abs
	}
	return &FileStore{file: path, lockTimeout: 5 * time.Second}
}

type fileRows struct {
	order []string
	rows  map[string]nosql.Row
}

func rowKey(pk, sk string) string {
	raw, _ := json.Marshal([]string{pk, sk})
	return string(raw)
}

func (s *FileStore) locked(ctx context.Context, operation func(*fileRows) error) error {
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
		case <-time.After(20 * time.Millisecond):
		}
	}
	defer os.Remove(lock)
	rows, err := s.read()
	if err != nil {
		return err
	}
	return operation(rows)
}

func (s *FileStore) read() (*fileRows, error) {
	out := &fileRows{rows: map[string]nosql.Row{}}
	raw, err := os.ReadFile(s.file)
	if errors.Is(err, fs.ErrNotExist) {
		return out, nil
	}
	if err != nil {
		return nil, err
	}
	var document struct {
		Format any               `json:"format"`
		Rows   []json.RawMessage `json:"rows"`
	}
	if json.Unmarshal(raw, &document) != nil || document.Format != float64(1) || document.Rows == nil {
		return nil, errors.New("Invalid JSON database")
	}
	for _, item := range document.Rows {
		row, ok := decodeRow(item)
		if !ok {
			return nil, errors.New("Invalid JSON database")
		}
		key := rowKey(row.PK, row.SK)
		if _, dup := out.rows[key]; dup {
			return nil, errors.New("Duplicate JSON database key")
		}
		out.order = append(out.order, key)
		out.rows[key] = row
	}
	return out, nil
}

// decodeRow checks the JsonStore row rules: string pk/sk, safe-integer version, object data.
func decodeRow(raw json.RawMessage) (nosql.Row, bool) {
	var loose map[string]any
	if json.Unmarshal(raw, &loose) != nil {
		return nosql.Row{}, false
	}
	_, pk := loose["pk"].(string)
	_, sk := loose["sk"].(string)
	version, isInt := js.Integer(loose["version"])
	_, data := loose["data"].(map[string]any)
	if !pk || !sk || !isInt || version > 1<<53-1 || version < -(1<<53-1) || !data {
		return nosql.Row{}, false
	}
	var row nosql.Row
	if json.Unmarshal(raw, &row) != nil {
		return nosql.Row{}, false
	}
	return row, true
}

// Get returns one row, or (nil, nil).
func (s *FileStore) Get(ctx context.Context, pk, sk string) (*nosql.Row, error) {
	var found *nosql.Row
	err := s.locked(ctx, func(rows *fileRows) error {
		if row, ok := rows.rows[rowKey(pk, sk)]; ok {
			found = &row
		}
		return nil
	})
	return found, err
}

// Transact applies version-guarded writes atomically and rewrites the file.
func (s *FileStore) Transact(ctx context.Context, writes []nosql.Write) error {
	snapshot, err := json.Marshal(writes)
	if err != nil {
		return err
	}
	var copies []nosql.Write
	if err := json.Unmarshal(snapshot, &copies); err != nil {
		return err
	}
	return s.locked(ctx, func(rows *fileRows) error {
		seen := map[string]bool{}
		for _, w := range copies {
			if w.Row.Data == nil {
				return errors.New("Invalid JSON row")
			}
			key := rowKey(w.Row.PK, w.Row.SK)
			if seen[key] {
				return nosql.ErrDuplicateKey
			}
			seen[key] = true
			old, exists := rows.rows[key]
			if w.Expected == nil && exists || w.Expected != nil && (!exists || old.Version != *w.Expected) {
				return apperr.Conflict()
			}
		}
		for _, w := range copies {
			key := rowKey(w.Row.PK, w.Row.SK)
			if w.Delete {
				delete(rows.rows, key)
				continue
			}
			if _, exists := rows.rows[key]; !exists {
				rows.order = append(rows.order, key)
			}
			rows.rows[key] = w.Row
		}
		now := float64(time.Now().UnixMilli()) / 1000
		for key, row := range rows.rows {
			retained := strings.HasPrefix(row.PK, "OBSERVER#") || strings.HasPrefix(row.PK, "CACHE#") || row.PK == "VISITS"
			if retained && row.TTL != nil && *row.TTL != 0 && float64(*row.TTL) <= now {
				delete(rows.rows, key)
			}
		}
		return s.write(rows)
	})
}

func (s *FileStore) write(rows *fileRows) error {
	list := make([]nosql.Row, 0, len(rows.rows))
	for _, key := range rows.order {
		if row, ok := rows.rows[key]; ok {
			list = append(list, row)
		}
	}
	raw, err := json.Marshal(map[string]any{"format": 1, "rows": list})
	if err != nil {
		return err
	}
	suffix := make([]byte, 16)
	_, _ = rand.Read(suffix)
	temp := s.file + "." + hex.EncodeToString(suffix) + ".tmp"
	defer os.Remove(temp)
	out, err := os.OpenFile(temp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err = out.Write(raw); err == nil {
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

// List returns up to 50 rows of one partition in code point order of SK.
func (s *FileStore) List(ctx context.Context, pk, cursor string) (nosql.Page, error) {
	after := ""
	if cursor != "" {
		var err error
		if after, err = nosql.DecodeCursor(pk, cursor); err != nil {
			return nosql.Page{}, err
		}
	}
	page := nosql.Page{Items: []nosql.Row{}}
	err := s.locked(ctx, func(rows *fileRows) error {
		var matching []nosql.Row
		for _, row := range rows.rows {
			if row.PK == pk && row.SK > after {
				matching = append(matching, row)
			}
		}
		slices.SortFunc(matching, func(a, b nosql.Row) int { return strings.Compare(a.SK, b.SK) })
		if len(matching) > nosql.PageSize {
			page.Items = matching[:nosql.PageSize]
			cursor, err := nosql.EncodeCursor(pk, page.Items[len(page.Items)-1].SK)
			page.Cursor = cursor
			return err
		} else if len(matching) > 0 {
			page.Items = matching
		}
		return nil
	})
	return page, err
}
