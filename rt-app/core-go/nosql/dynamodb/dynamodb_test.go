package dynamodb

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	ddb "github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"rt.local/core-go/apperr"
	"rt.local/core-go/nosql"
	"rt.local/core-go/nosql/nosqltest"
)

// fake records requests and answers with canned outputs.
type fake struct {
	transact []*ddb.TransactWriteItemsInput
	queries  []*ddb.QueryInput
	query    *ddb.QueryOutput
	err      error
}

func (f *fake) GetItem(context.Context, *ddb.GetItemInput, ...func(*ddb.Options)) (*ddb.GetItemOutput, error) {
	return &ddb.GetItemOutput{}, f.err
}

func (f *fake) Query(_ context.Context, in *ddb.QueryInput, _ ...func(*ddb.Options)) (*ddb.QueryOutput, error) {
	f.queries = append(f.queries, in)
	return f.query, f.err
}

func (f *fake) TransactWriteItems(_ context.Context, in *ddb.TransactWriteItemsInput, _ ...func(*ddb.Options)) (*ddb.TransactWriteItemsOutput, error) {
	f.transact = append(f.transact, in)
	return &ddb.TransactWriteItemsOutput{}, f.err
}

func TestNewNeedsATable(t *testing.T) {
	if _, err := New(&fake{}, ""); err == nil || err.Error() != "TABLE_NAME is required" {
		t.Fatal(err)
	}
}

func TestTransactConditions(t *testing.T) {
	f := &fake{}
	store, _ := New(f, "t")
	ttl := int64(9)
	err := store.Transact(t.Context(), []nosql.Write{
		{Row: nosql.Row{PK: "A", SK: "new", Version: 1, Data: map[string]any{"n": 1.5}, TTL: &ttl}},
		{Row: nosql.Row{PK: "A", SK: "old", Version: 3, Data: map[string]any{}}, Expected: nosql.Expect(2)},
		{Row: nosql.Row{PK: "A", SK: "gone"}, Expected: nosql.Expect(4), Delete: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	items := f.transact[0].TransactItems
	if c := aws.ToString(items[0].Put.ConditionExpression); c != "attribute_not_exists(pk)" || items[0].Put.ExpressionAttributeValues != nil {
		t.Errorf("create condition = %s", c)
	}
	if n := items[0].Put.Item["ttl"].(*types.AttributeValueMemberN).Value; n != "9" {
		t.Errorf("ttl = %s", n)
	}
	if c, v := aws.ToString(items[1].Put.ConditionExpression), items[1].Put.ExpressionAttributeValues[":v"].(*types.AttributeValueMemberN).Value; c != "#v = :v" || v != "2" || items[1].Put.ExpressionAttributeNames["#v"] != "version" {
		t.Errorf("update condition = %s %s", c, v)
	}
	if d := items[2].Delete; d == nil || d.ExpressionAttributeValues[":v"].(*types.AttributeValueMemberN).Value != "4" || len(d.Key) != 2 {
		t.Errorf("delete = %+v", d)
	}
}

func TestTransactDuplicateKeyNeverCallsDynamoDB(t *testing.T) {
	f := &fake{}
	store, _ := New(f, "t")
	w := nosql.Write{Row: nosql.Row{PK: "A", SK: "x", Version: 1}}
	if err := store.Transact(t.Context(), []nosql.Write{w, w}); !errors.Is(err, nosql.ErrDuplicateKey) {
		t.Fatal(err)
	}
	if err := store.Transact(t.Context(), nil); err != nil || len(f.transact) != 0 {
		t.Fatalf("calls = %d, %v", len(f.transact), err)
	}
}

func TestTransactCancellationReasons(t *testing.T) {
	canceled := func(codes ...string) error {
		reasons := make([]types.CancellationReason, len(codes))
		for i, code := range codes {
			reasons[i].Code = aws.String(code)
		}
		return fmt.Errorf("wrapped: %w", &types.TransactionCanceledException{CancellationReasons: reasons})
	}
	for _, c := range []struct {
		err      error
		conflict bool
	}{
		{canceled("None", "ConditionalCheckFailed"), true},
		{canceled("TransactionConflict"), true},
		{canceled("ThrottlingError"), false},
		{errors.New("network"), false},
	} {
		store, _ := New(&fake{err: c.err}, "t")
		err := store.Transact(t.Context(), []nosql.Write{{Row: nosql.Row{PK: "A", SK: "x"}}})
		if got := apperr.IsConflict(err); got != c.conflict || err == nil {
			t.Errorf("%v: conflict = %v (%v)", c.err, got, err)
		}
	}
}

func items(n int) []map[string]types.AttributeValue {
	out := make([]map[string]types.AttributeValue, n)
	for i := range out {
		out[i], _ = toItem(nosql.Row{PK: "P", SK: fmt.Sprintf("k%02d", i), Version: 1, Data: map[string]any{}})
	}
	return out
}

func TestListPagesWithLimit51(t *testing.T) {
	key := key("P", "k50")
	for _, c := range []struct {
		name   string
		out    *ddb.QueryOutput
		items  int
		cursor string
	}{
		{"a 51st row exists", &ddb.QueryOutput{Items: items(51), LastEvaluatedKey: key}, 50, "k49"},
		{"exactly 50 rows", &ddb.QueryOutput{Items: items(50)}, 50, ""},
		{"stopped at the 1 MB limit", &ddb.QueryOutput{Items: items(20), LastEvaluatedKey: key}, 20, "k19"},
		{"empty", &ddb.QueryOutput{}, 0, ""},
	} {
		f := &fake{query: c.out}
		store, _ := New(f, "t")
		page, err := store.List(t.Context(), "P", "")
		if err != nil {
			t.Fatal(err)
		}
		want := ""
		if c.cursor != "" {
			want, _ = nosql.EncodeCursor("P", c.cursor)
		}
		if len(page.Items) != c.items || page.Items == nil || page.Cursor != want {
			t.Errorf("%s: %d items, cursor %q, want %d and %q", c.name, len(page.Items), page.Cursor, c.items, want)
		}
		q := f.queries[0]
		if aws.ToInt32(q.Limit) != 51 || !aws.ToBool(q.ConsistentRead) || q.ExclusiveStartKey != nil {
			t.Errorf("%s: query %+v", c.name, q)
		}
	}
	f := &fake{query: &ddb.QueryOutput{}}
	store, _ := New(f, "t")
	cursor, _ := nosql.EncodeCursor("P", "k49")
	if _, err := store.List(t.Context(), "P", cursor); err != nil || f.queries[0].ExclusiveStartKey["sk"].(*types.AttributeValueMemberS).Value != "k49" {
		t.Fatalf("ExclusiveStartKey: %v", err)
	}
	if _, err := store.List(t.Context(), "OTHER", cursor); err == nil || len(f.queries) != 1 {
		t.Fatal("a cursor from another partition must be rejected before querying")
	}
}

// TestStoreSuite runs against RT_APP_TEST_DYNAMODB_ENDPOINT (npm run contracts:stores starts
// DynamoDB Local).
func TestStoreSuite(t *testing.T) {
	endpoint := os.Getenv("RT_APP_TEST_DYNAMODB_ENDPOINT")
	if endpoint == "" {
		t.Skip("RT_APP_TEST_DYNAMODB_ENDPOINT is not set")
	}
	client := ddb.New(ddb.Options{
		Region:       "us-east-1",
		BaseEndpoint: aws.String(endpoint),
		Credentials:  credentials.NewStaticCredentialsProvider("local", "local", ""),
	})
	nosqltest.Run(t, func(t *testing.T) nosql.Store {
		suffix := make([]byte, 4)
		_, _ = rand.Read(suffix)
		table := "rt_gotest_" + hex.EncodeToString(suffix)
		_, err := client.CreateTable(t.Context(), &ddb.CreateTableInput{
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
			t.Fatal(err)
		}
		t.Cleanup(func() {
			_, _ = client.DeleteTable(context.Background(), &ddb.DeleteTableInput{TableName: aws.String(table)})
		})
		store, _ := New(client, table)
		return store
	})
}
