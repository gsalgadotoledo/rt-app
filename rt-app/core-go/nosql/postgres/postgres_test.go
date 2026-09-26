package postgres

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"rt.local/core-go/nosql"
	"rt.local/core-go/nosql/nosqltest"
)

func TestTableNames(t *testing.T) {
	for name, ok := range map[string]bool{"": true, "rt_app_rows": true, "_x9": true, "Rows": false, "9rows": false, "a;drop": false} {
		store, err := New(nil, name)
		if (err == nil) != ok {
			t.Errorf("New(%q): %v", name, err)
		}
		if ok && name == "" && store.Table() != DefaultTable {
			t.Errorf("default table = %s", store.Table())
		}
	}
}

func TestSSLMode(t *testing.T) {
	for conn, want := range map[string]bool{
		"postgres://u@db.example.com/app":                 false,
		"postgres://u@db.example.com/app?sslmode=require": true,
		"host=db.example.com sslmode=verify-full":         true,
		"host=db.example.com":                             false,
	} {
		if got := hasSSLMode(conn); got != want {
			t.Errorf("hasSSLMode(%q) = %v", conn, got)
		}
	}
}

func TestConnectRequiresTLSForRemoteHosts(t *testing.T) {
	ctx := context.Background()
	off := false
	for _, c := range []struct {
		url  string
		opts Options
		tls  bool
	}{
		{"postgres://u@db.example.com/app", Options{}, true},
		{"postgres://u@127.0.0.1/app?sslmode=disable", Options{}, false},
		{"postgres://u@db.example.com/app", Options{SSL: &off}, false},
	} {
		store, err := Connect(ctx, c.url, c.opts)
		if err != nil {
			t.Fatal(err)
		}
		pool := store.db.(*pgxpool.Pool)
		config := pool.Config().ConnConfig
		if (config.TLSConfig != nil) != c.tls || (c.tls && config.TLSConfig.InsecureSkipVerify) || len(config.Fallbacks) != 0 && c.tls {
			t.Errorf("%s: TLS %v", c.url, config.TLSConfig)
		}
		store.Close()
	}
}

// TestStoreSuite runs against RT_APP_TEST_POSTGRES_URL (npm run contracts:stores starts one).
func TestStoreSuite(t *testing.T) {
	url := os.Getenv("RT_APP_TEST_POSTGRES_URL")
	if url == "" {
		t.Skip("RT_APP_TEST_POSTGRES_URL is not set")
	}
	off := false
	nosqltest.Run(t, func(t *testing.T) nosql.Store {
		suffix := make([]byte, 4)
		_, _ = rand.Read(suffix)
		store, err := Connect(t.Context(), url, Options{Table: "rt_gotest_" + hex.EncodeToString(suffix), SSL: &off})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			_, _ = store.db.Exec(context.Background(), "DROP TABLE IF EXISTS "+store.Table())
			store.Close()
		})
		return store
	})
}
