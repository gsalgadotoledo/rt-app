package main

// Subjects: nosql-postgres (RT_APP_TEST_POSTGRES_URL), nosql-dynamodb
// (RT_APP_TEST_DYNAMODB_ENDPOINT); registered only when their variable is set. Each instance
// gets a fresh table, dropped or deleted on close (mirrors spec/hosts/node/storage.mjs).

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	ddb "github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/jackc/pgx/v5/pgxpool"

	"rt.local/core-go/conformance"
	"rt.local/core-go/nosql"
	"rt.local/core-go/nosql/dynamodb"
	"rt.local/core-go/nosql/postgres"
)

func init() {
	if url := os.Getenv("RT_APP_TEST_POSTGRES_URL"); url != "" {
		register("nosql-postgres", func(ctx context.Context, init json.RawMessage) (conformance.Instance, error) {
			return postgresInstance(ctx, url, init)
		})
	}
	if endpoint := os.Getenv("RT_APP_TEST_DYNAMODB_ENDPOINT"); endpoint != "" {
		register("nosql-dynamodb", func(ctx context.Context, init json.RawMessage) (conformance.Instance, error) {
			return dynamoInstance(ctx, endpoint, init)
		})
	}
}

// uniqueTable is a table name no other instance uses: rt_contract_<base36 ms>_<8 hex>.
func uniqueTable() string {
	suffix := make([]byte, 4)
	_, _ = rand.Read(suffix)
	return "rt_contract_" + strconv.FormatInt(time.Now().UnixMilli(), 36) + "_" + hex.EncodeToString(suffix)
}

// cleanup runs close work without the request context, which ends with the DELETE request.
func cleanup(fn func(context.Context) error) func() error {
	return func() error {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		return fn(ctx)
	}
}

// postgresInstance stores rows in a fresh table of the test database (TLS off: the test
// server is local), dropped on close.
func postgresInstance(ctx context.Context, url string, init json.RawMessage) (conformance.Instance, error) {
	config, err := pgxpool.ParseConfig(url)
	if err != nil {
		return conformance.Instance{}, err
	}
	config.MaxConns = 2
	config.ConnConfig.TLSConfig, config.ConnConfig.Fallbacks = nil, nil
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return conformance.Instance{}, err
	}
	table := uniqueTable()
	closeAll := cleanup(func(ctx context.Context) error {
		defer pool.Close()
		_, err := pool.Exec(ctx, "DROP TABLE IF EXISTS "+table)
		return err
	})
	store, err := postgres.New(pool, table)
	if err == nil {
		err = seedRows(ctx, store, init)
	}
	if err != nil {
		_ = closeAll()
		return conformance.Instance{}, err
	}
	return storeInstance(store, closeAll), nil
}

// dynamoInstance stores rows in a fresh DynamoDB Local table, deleted on close. Credentials
// come from AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY ("local" when unset).
func dynamoInstance(ctx context.Context, endpoint string, init json.RawMessage) (conformance.Instance, error) {
	client := ddb.New(ddb.Options{
		Region:           "us-east-1",
		BaseEndpoint:     aws.String(endpoint),
		Credentials:      credentials.NewStaticCredentialsProvider(envOr("AWS_ACCESS_KEY_ID", "local"), envOr("AWS_SECRET_ACCESS_KEY", "local"), ""),
		RetryMaxAttempts: 3,
		HTTPClient:       &http.Client{Timeout: 8 * time.Second},
	})
	table := uniqueTable()
	_, err := client.CreateTable(ctx, &ddb.CreateTableInput{
		TableName:   aws.String(table),
		BillingMode: types.BillingModePayPerRequest,
		AttributeDefinitions: []types.AttributeDefinition{
			{AttributeName: aws.String("pk"), AttributeType: types.ScalarAttributeTypeS},
			{AttributeName: aws.String("sk"), AttributeType: types.ScalarAttributeTypeS},
		},
		KeySchema: []types.KeySchemaElement{
			{AttributeName: aws.String("pk"), KeyType: types.KeyTypeHash},
			{AttributeName: aws.String("sk"), KeyType: types.KeyTypeRange},
		},
	})
	if err != nil {
		return conformance.Instance{}, err
	}
	closeAll := cleanup(func(ctx context.Context) error {
		_, err := client.DeleteTable(ctx, &ddb.DeleteTableInput{TableName: aws.String(table)})
		return err
	})
	store, err := dynamodb.New(client, table)
	if err == nil {
		err = seedRows(ctx, store, init)
	}
	if err != nil {
		_ = closeAll()
		return conformance.Instance{}, err
	}
	return storeInstance(store, closeAll), nil
}

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

// seedRows stores init.rows with version-guarded creates.
func seedRows(ctx context.Context, store nosql.Store, init json.RawMessage) error {
	var config struct {
		Rows []nosql.Row `json:"rows"`
	}
	if err := json.Unmarshal(init, &config); err != nil {
		return fmt.Errorf("init: %w", err)
	}
	writes := make([]nosql.Write, len(config.Rows))
	for i, row := range config.Rows {
		writes[i] = nosql.Write{Row: row}
	}
	return store.Transact(ctx, writes)
}

// storeInstance exposes the nosql contract methods of a store.
func storeInstance(store nosql.Store, closeFn func() error) conformance.Instance {
	return conformance.Instance{
		Close: closeFn,
		Methods: map[string]conformance.Method{
			// get(pk, sk) → row | null
			"get": func(ctx context.Context, args []json.RawMessage) (any, error) {
				var pk, sk string
				if err := decodeArgs(args, &pk, &sk); err != nil {
					return nil, err
				}
				return store.Get(ctx, pk, sk)
			},
			// transact(writes) → null
			"transact": func(ctx context.Context, args []json.RawMessage) (any, error) {
				var writes []nosql.Write
				if err := decodeArgs(args, &writes); err != nil {
					return nil, err
				}
				return nil, store.Transact(ctx, writes)
			},
			// list(pk, cursor?) → {items, cursor?}
			"list": func(ctx context.Context, args []json.RawMessage) (any, error) {
				var pk, cursor string
				if err := decodeArgs(args, &pk, &cursor); err != nil {
					return nil, err
				}
				return store.List(ctx, pk, cursor)
			},
		},
	}
}
