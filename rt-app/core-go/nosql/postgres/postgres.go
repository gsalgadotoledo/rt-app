// Package postgres is the nosql.Store contract on PostgreSQL: one table of
// (pk, sk, version, data jsonb, ttl), the same schema and SQL as the TypeScript
// @gsalgadotoledo/rt-app-postgres store, so modules, migrations and seeds run unchanged on any
// Postgres and both languages can share a database.
//
// Conditional writes run inside one SQL transaction, so a version conflict rolls back the whole
// write set, exactly like DynamoDB transactions. Sort keys compare with COLLATE "C" (byte
// order), which is Unicode code point order for UTF-8, the order every store uses.
package postgres

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"sync"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"rt.local/core-go/apperr"
	"rt.local/core-go/nosql"
)

// DefaultTable is the table used when none is given.
const DefaultTable = "rt_app_rows"

// DB is what the store needs from a database handle; *pgxpool.Pool implements it.
type DB interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Begin(ctx context.Context) (pgx.Tx, error)
}

// Store is a nosql.Store on PostgreSQL. It is safe for concurrent use.
type Store struct {
	db    DB
	table string
	close func()

	schemaMu    sync.Mutex
	schemaReady bool
}

var _ nosql.Store = (*Store)(nil)

var tableName = regexp.MustCompile(`^[a-z_][a-z0-9_]{0,62}$`)

// New returns a store on db using table (DefaultTable when empty). The table name must match
// ^[a-z_][a-z0-9_]{0,62}$ because it is written into the SQL. Nothing connects until the first
// read or write.
func New(db DB, table string) (*Store, error) {
	if table == "" {
		table = DefaultTable
	}
	if !tableName.MatchString(table) {
		return nil, errors.New("Invalid table name: " + table)
	}
	return &Store{db: db, table: table}, nil
}

// Options configure Connect.
type Options struct {
	Table    string // DefaultTable when empty
	MaxConns int32  // 10 when zero
	// SSL forces TLS on (true) or off (false). When nil, TLS with certificate verification is
	// required unless the host is local (localhost, 127.0.0.1, ::1) or the URL sets sslmode.
	SSL *bool
}

// Connect opens a connection pool for a connection string (DATABASE_URL) and returns a store
// that owns it (Close ends the pool). Connections open lazily.
func Connect(ctx context.Context, connString string, opts Options) (*Store, error) {
	config, err := pgxpool.ParseConfig(connString)
	if err != nil {
		return nil, err
	}
	config.MaxConns = 10
	if opts.MaxConns > 0 {
		config.MaxConns = opts.MaxConns
	}
	host := config.ConnConfig.Host
	local := host == "localhost" || host == "127.0.0.1" || host == "::1"
	switch {
	case opts.SSL != nil && !*opts.SSL:
		config.ConnConfig.TLSConfig = nil
		config.ConnConfig.Fallbacks = nil
	case opts.SSL != nil || !local && !hasSSLMode(connString):
		config.ConnConfig.TLSConfig = &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12}
		config.ConnConfig.Fallbacks = nil
	}
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, err
	}
	store, err := New(pool, opts.Table)
	if err != nil {
		pool.Close()
		return nil, err
	}
	store.close = pool.Close
	return store, nil
}

// hasSSLMode reports whether a URL or keyword/value connection string sets sslmode.
func hasSSLMode(connString string) bool {
	if u, err := url.Parse(connString); err == nil && u.Scheme != "" {
		return u.Query().Has("sslmode")
	}
	return sslModeKeyword.MatchString(connString)
}

var sslModeKeyword = regexp.MustCompile(`(^|\s)sslmode\s*=`)

// Close ends the pool opened by Connect; it does nothing for a store built with New.
func (s *Store) Close() {
	if s.close != nil {
		s.close()
	}
}

// Table returns the table name.
func (s *Store) Table() string { return s.table }

// EnsureSchema creates the table if missing. It is idempotent and runs automatically (once
// per store, retried after a failure) before the first read or write.
func (s *Store) EnsureSchema(ctx context.Context) error {
	s.schemaMu.Lock()
	defer s.schemaMu.Unlock()
	if s.schemaReady {
		return nil
	}
	_, err := s.db.Exec(ctx, `CREATE TABLE IF NOT EXISTS `+s.table+` (
        pk text NOT NULL,
        sk text NOT NULL,
        version integer NOT NULL,
        data jsonb NOT NULL,
        ttl bigint,
        PRIMARY KEY (pk, sk)
      )`)
	s.schemaReady = err == nil
	return err
}

// Get reads one row; a missing row returns (nil, nil). Reads see committed data.
func (s *Store) Get(ctx context.Context, pk, sk string) (*nosql.Row, error) {
	if err := s.EnsureSchema(ctx); err != nil {
		return nil, err
	}
	rows, err := s.db.Query(ctx, `SELECT pk, sk, version, data, ttl FROM `+s.table+` WHERE pk = $1 AND sk = $2`, pk, sk)
	if err != nil {
		return nil, err
	}
	found, err := scanRows(rows)
	if err != nil || len(found) == 0 {
		return nil, err
	}
	return &found[0], nil
}

// Transact applies version-guarded writes atomically in one SQL transaction. Expected nil
// means "must not exist"; otherwise the row must have exactly that version. A repeated key
// returns nosql.ErrDuplicateKey before anything runs; any failed guard returns
// apperr.Conflict() and nothing commits. Row locks taken by UPDATE/INSERT make concurrent
// writers re-check the version after waiting.
func (s *Store) Transact(ctx context.Context, writes []nosql.Write) error {
	if len(writes) == 0 {
		return nil
	}
	if err := nosql.CheckKeys(writes); err != nil {
		return err
	}
	if err := s.EnsureSchema(ctx); err != nil {
		return err
	}
	return pgx.BeginFunc(ctx, s.db, func(tx pgx.Tx) error {
		for _, w := range writes {
			changed, err := s.apply(ctx, tx, w)
			if err != nil {
				return err
			}
			if changed != 1 {
				return apperr.Conflict() // BeginFunc rolls back
			}
		}
		return nil
	})
}

// apply runs one guarded write and returns the number of rows it matched (1 = guard held).
func (s *Store) apply(ctx context.Context, tx pgx.Tx, w nosql.Write) (int64, error) {
	row := w.Row
	switch {
	case w.Expected == nil && !w.Delete:
		data, err := json.Marshal(row.Data)
		if err != nil {
			return 0, err
		}
		tag, err := tx.Exec(ctx, `INSERT INTO `+s.table+` (pk, sk, version, data, ttl) VALUES ($1, $2, $3, $4::jsonb, $5) ON CONFLICT (pk, sk) DO NOTHING`,
			row.PK, row.SK, row.Version, string(data), row.TTL)
		return tag.RowsAffected(), err
	case w.Expected == nil:
		// Deleting a row that must not exist is a no-op, but it still asserts absence.
		rows, err := tx.Query(ctx, `SELECT 1 FROM `+s.table+` WHERE pk = $1 AND sk = $2 FOR UPDATE`, row.PK, row.SK)
		if err != nil {
			return 0, err
		}
		exists := rows.Next()
		rows.Close()
		if err := rows.Err(); err != nil {
			return 0, err
		}
		if exists {
			return 0, nil
		}
		return 1, nil
	case w.Delete:
		tag, err := tx.Exec(ctx, `DELETE FROM `+s.table+` WHERE pk = $1 AND sk = $2 AND version = $3`, row.PK, row.SK, *w.Expected)
		return tag.RowsAffected(), err
	default:
		data, err := json.Marshal(row.Data)
		if err != nil {
			return 0, err
		}
		tag, err := tx.Exec(ctx, `UPDATE `+s.table+` SET version = $3, data = $4::jsonb, ttl = $5 WHERE pk = $1 AND sk = $2 AND version = $6`,
			row.PK, row.SK, row.Version, string(data), row.TTL, *w.Expected)
		return tag.RowsAffected(), err
	}
}

// List returns up to nosql.PageSize rows of partition pk after the cursor, ordered by sort
// key in code point order, and a cursor (same format as every store) when more rows follow.
// An undecodable cursor, or one from another partition, returns 400 "Invalid cursor".
func (s *Store) List(ctx context.Context, pk, cursor string) (nosql.Page, error) {
	after := ""
	if cursor != "" {
		sk, err := nosql.DecodeCursor(pk, cursor)
		if err != nil {
			return nosql.Page{}, err
		}
		after = sk
	}
	if err := s.EnsureSchema(ctx); err != nil {
		return nosql.Page{}, err
	}
	// Binary collation matches the byte order the other adapters use.
	rows, err := s.db.Query(ctx, fmt.Sprintf(`SELECT pk, sk, version, data, ttl FROM %s WHERE pk = $1 AND sk COLLATE "C" > $2 ORDER BY sk COLLATE "C" LIMIT %d`, s.table, nosql.PageSize+1), pk, after)
	if err != nil {
		return nosql.Page{}, err
	}
	found, err := scanRows(rows)
	if err != nil {
		return nosql.Page{}, err
	}
	page := nosql.Page{Items: found[:min(len(found), nosql.PageSize)]}
	if len(found) > nosql.PageSize {
		if page.Cursor, err = nosql.EncodeCursor(pk, page.Items[nosql.PageSize-1].SK); err != nil {
			return nosql.Page{}, err
		}
	}
	return page, nil
}

// scanRows reads (pk, sk, version, data, ttl) rows; data decodes like JSON.parse (float64
// numbers). It always returns a non-nil slice on success.
func scanRows(rows pgx.Rows) ([]nosql.Row, error) {
	defer rows.Close()
	out := []nosql.Row{}
	for rows.Next() {
		var row nosql.Row
		var data []byte
		if err := rows.Scan(&row.PK, &row.SK, &row.Version, &data, &row.TTL); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(data, &row.Data); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}
