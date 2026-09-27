// Package dynamocache is the cache on an existing DynamoDB table (port of
// @gsalgadotoledo/rt-app-cache-dynamodb): a cache.NoSQL over a dynamodb.Store. The table needs
// pk/sk string keys and TTL enabled on the "ttl" attribute; nothing creates infrastructure.
package dynamocache

import (
	"rt.local/core-go/cache"
	"rt.local/core-go/nosql/dynamodb"
)

// New returns a cache on table through client; an empty namespace means "default".
//
//	c, err := dynamocache.New(ddb.NewFromConfig(cfg), os.Getenv("CACHE_TABLE"), "default")
func New(client dynamodb.API, table, namespace string, opts ...cache.Option) (*cache.NoSQL, error) {
	store, err := dynamodb.New(client, table)
	if err != nil {
		return nil, err
	}
	return cache.NewNoSQL(store, namespace, opts...), nil
}
