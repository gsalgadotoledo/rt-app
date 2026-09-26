package nosql_test

import (
	"testing"

	"rt.local/core-go/nosql"
	"rt.local/core-go/nosql/nosqltest"
)

func TestMemoryStoreSuite(t *testing.T) {
	nosqltest.Run(t, func(*testing.T) nosql.Store { return nosql.NewMemoryStore() })
}
