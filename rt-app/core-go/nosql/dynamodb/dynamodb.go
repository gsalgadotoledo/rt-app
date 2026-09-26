// Package dynamodb is the nosql.Store contract on Amazon DynamoDB (aws-sdk-go-v2), with the
// same item layout, conditions and cursors as the TypeScript @gsalgadotoledo/rt-app-dynamodb
// store: items {pk, sk, version, data, ttl?} in a table keyed by pk (HASH) and sk (RANGE).
//
// Writes are one TransactWriteItems call guarded by conditions, reads are strongly consistent
// and DynamoDB orders sort keys by UTF-8 bytes (Unicode code point order), like every store.
package dynamodb

import (
	"context"
	"errors"
	"slices"
	"strconv"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	ddb "github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"rt.local/core-go/apperr"
	"rt.local/core-go/nosql"
)

// API is the part of the DynamoDB client the store uses; *dynamodb.Client implements it.
type API interface {
	GetItem(ctx context.Context, in *ddb.GetItemInput, opts ...func(*ddb.Options)) (*ddb.GetItemOutput, error)
	Query(ctx context.Context, in *ddb.QueryInput, opts ...func(*ddb.Options)) (*ddb.QueryOutput, error)
	TransactWriteItems(ctx context.Context, in *ddb.TransactWriteItemsInput, opts ...func(*ddb.Options)) (*ddb.TransactWriteItemsOutput, error)
}

// Store is a nosql.Store on one DynamoDB table. It is safe for concurrent use.
type Store struct {
	client API
	table  string
}

var _ nosql.Store = (*Store)(nil)

// New returns a store on table (required).
func New(client API, table string) (*Store, error) {
	if table == "" {
		return nil, errors.New("TABLE_NAME is required")
	}
	return &Store{client: client, table: table}, nil
}

// Get reads one row with ConsistentRead; a missing row returns (nil, nil).
func (s *Store) Get(ctx context.Context, pk, sk string) (*nosql.Row, error) {
	out, err := s.client.GetItem(ctx, &ddb.GetItemInput{
		TableName:      aws.String(s.table),
		Key:            key(pk, sk),
		ConsistentRead: aws.Bool(true),
	})
	if err != nil || out.Item == nil {
		return nil, err
	}
	row, err := fromItem(out.Item)
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// Transact applies all writes in one TransactWriteItems call. Expected nil means "must not
// exist" (attribute_not_exists(pk)); otherwise the stored version must equal it. A repeated
// key returns nosql.ErrDuplicateKey before calling DynamoDB (which would answer with a
// ValidationException); a cancellation for a failed condition or a conflicting transaction
// returns apperr.Conflict(). Nothing commits in either case.
func (s *Store) Transact(ctx context.Context, writes []nosql.Write) error {
	if len(writes) == 0 {
		return nil
	}
	if err := nosql.CheckKeys(writes); err != nil {
		return err
	}
	items := make([]types.TransactWriteItem, len(writes))
	for i, w := range writes {
		condition := aws.String("attribute_not_exists(pk)")
		var names map[string]string
		var values map[string]types.AttributeValue
		if w.Expected != nil {
			condition = aws.String("#v = :v")
			names = map[string]string{"#v": "version"}
			values = map[string]types.AttributeValue{":v": &types.AttributeValueMemberN{Value: strconv.Itoa(*w.Expected)}}
		}
		if w.Delete {
			items[i].Delete = &types.Delete{
				TableName:                 aws.String(s.table),
				Key:                       key(w.Row.PK, w.Row.SK),
				ConditionExpression:       condition,
				ExpressionAttributeNames:  names,
				ExpressionAttributeValues: values,
			}
			continue
		}
		item, err := toItem(w.Row)
		if err != nil {
			return err
		}
		items[i].Put = &types.Put{
			TableName:                 aws.String(s.table),
			Item:                      item,
			ConditionExpression:       condition,
			ExpressionAttributeNames:  names,
			ExpressionAttributeValues: values,
		}
	}
	_, err := s.client.TransactWriteItems(ctx, &ddb.TransactWriteItemsInput{TransactItems: items})
	if conflict(err) {
		return apperr.Conflict()
	}
	return err
}

// conflict reports a transaction canceled by a failed condition or a concurrent transaction.
func conflict(err error) bool {
	var canceled *types.TransactionCanceledException
	if !errors.As(err, &canceled) {
		return false
	}
	return slices.ContainsFunc(canceled.CancellationReasons, func(r types.CancellationReason) bool {
		code := aws.ToString(r.Code)
		return code == "ConditionalCheckFailed" || code == "TransactionConflict"
	})
}

// List returns up to nosql.PageSize rows of partition pk after the cursor, from a strongly
// consistent Query with Limit PageSize+1 and ExclusiveStartKey. The cursor (the format of
// every store, after the last returned row) is set only when more rows follow: a 51st row
// exists, or DynamoDB stopped early at its 1 MB page limit. An undecodable cursor, or one
// from another partition, returns 400 "Invalid cursor".
func (s *Store) List(ctx context.Context, pk, cursor string) (nosql.Page, error) {
	var start map[string]types.AttributeValue
	if cursor != "" {
		sk, err := nosql.DecodeCursor(pk, cursor)
		if err != nil {
			return nosql.Page{}, err
		}
		start = key(pk, sk)
	}
	out, err := s.client.Query(ctx, &ddb.QueryInput{
		TableName:                 aws.String(s.table),
		KeyConditionExpression:    aws.String("pk = :pk"),
		ExpressionAttributeValues: map[string]types.AttributeValue{":pk": &types.AttributeValueMemberS{Value: pk}},
		Limit:                     aws.Int32(nosql.PageSize + 1),
		ExclusiveStartKey:         start,
		ConsistentRead:            aws.Bool(true),
	})
	if err != nil {
		return nosql.Page{}, err
	}
	items := out.Items[:min(len(out.Items), nosql.PageSize)]
	page := nosql.Page{Items: make([]nosql.Row, 0, len(items))}
	for _, item := range items {
		row, err := fromItem(item)
		if err != nil {
			return nosql.Page{}, err
		}
		page.Items = append(page.Items, row)
	}
	more := len(out.Items) > nosql.PageSize || out.LastEvaluatedKey != nil && len(out.Items) < nosql.PageSize+1
	if more && len(page.Items) > 0 {
		last := page.Items[len(page.Items)-1]
		if page.Cursor, err = nosql.EncodeCursor(last.PK, last.SK); err != nil {
			return nosql.Page{}, err
		}
	}
	return page, nil
}

func key(pk, sk string) map[string]types.AttributeValue {
	return map[string]types.AttributeValue{
		"pk": &types.AttributeValueMemberS{Value: pk},
		"sk": &types.AttributeValueMemberS{Value: sk},
	}
}

// toItem stores a row as {pk, sk, version, data, ttl?}; a nil Data is left out.
func toItem(row nosql.Row) (map[string]types.AttributeValue, error) {
	item := key(row.PK, row.SK)
	item["version"] = &types.AttributeValueMemberN{Value: strconv.Itoa(row.Version)}
	if row.Data != nil {
		data, err := attributevalue.MarshalMap(row.Data)
		if err != nil {
			return nil, err
		}
		item["data"] = &types.AttributeValueMemberM{Value: data}
	}
	if row.TTL != nil {
		item["ttl"] = &types.AttributeValueMemberN{Value: strconv.FormatInt(*row.TTL, 10)}
	}
	return item, nil
}

// fromItem reads a stored item; numbers inside data decode as float64, like JavaScript.
func fromItem(item map[string]types.AttributeValue) (nosql.Row, error) {
	var stored struct {
		PK      string         `dynamodbav:"pk"`
		SK      string         `dynamodbav:"sk"`
		Version int            `dynamodbav:"version"`
		Data    map[string]any `dynamodbav:"data"`
		TTL     *int64         `dynamodbav:"ttl"`
	}
	if err := attributevalue.UnmarshalMap(item, &stored); err != nil {
		return nosql.Row{}, err
	}
	return nosql.Row{PK: stored.PK, SK: stored.SK, Version: stored.Version, Data: stored.Data, TTL: stored.TTL}, nil
}
