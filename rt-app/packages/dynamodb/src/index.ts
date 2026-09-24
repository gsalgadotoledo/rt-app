import { requiredCapabilities } from "@gsalgadotoledo/rt-app-nosql";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  Conflict,
  HttpError,
  type Row,
  type Store,
  type Write,
} from "@gsalgadotoledo/rt-app-contracts";
export class DynamoStore implements Store {
  readonly provider = "dynamodb";
  readonly capabilities = requiredCapabilities;
  private client: DynamoDBDocumentClient;
  constructor(
    private table: string,
    options: { region?: string; endpoint?: string } = {},
  ) {
    if (!table) throw new Error("TABLE_NAME is required");
    this.client = DynamoDBDocumentClient.from(
      new DynamoDBClient({
        ...options,
        maxAttempts: 3,
        requestHandler: { connectionTimeout: 2000, requestTimeout: 8000 },
      }),
      { marshallOptions: { removeUndefinedValues: true } },
    );
  }
  /** Read one row; absence returns undefined. Durable reads use ConsistentRead. */
  async get(pk: string, sk: string) {
    return (
      await this.client.send(
        new GetCommand({
          TableName: this.table,
          Key: { pk, sk },
          ConsistentRead: true,
        }),
      )
    ).Item as Row | undefined;
  }
  /** Apply all version-guarded writes atomically; conflicts never commit a partial transaction. */
  async transact(writes: Write[]) {
    if (!writes.length) return;
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: writes.map((w) => {
            const condition =
              w.expected === null
                ? { ConditionExpression: "attribute_not_exists(pk)" }
                : {
                    ConditionExpression: "#v = :v",
                    ExpressionAttributeNames: { "#v": "version" },
                    ExpressionAttributeValues: { ":v": w.expected },
                  };
            return w.delete
              ? {
                  Delete: {
                    TableName: this.table,
                    Key: { pk: w.row.pk, sk: w.row.sk },
                    ...condition,
                  },
                }
              : { Put: { TableName: this.table, Item: w.row, ...condition } };
          }),
        }),
      );
    } catch (error: any) {
      if (
        error.name === "TransactionCanceledException" &&
        error.CancellationReasons?.some((r: any) =>
          ["ConditionalCheckFailed", "TransactionConflict"].includes(r.Code),
        )
      )
        throw new Conflict();
      throw error;
    }
  }
  /** Return up to 50 rows and a cursor bound to this partition; reject cross-partition cursors. */
  async list(pk: string, cursor?: string) {
    let key: { pk: string; sk: string } | undefined;
    if (cursor) {
      try {
        key = JSON.parse(Buffer.from(cursor, "base64url").toString());
        if (key?.pk !== pk || typeof key?.sk !== "string") throw 0;
      } catch {
        throw new HttpError(400, "Invalid cursor");
      }
    }
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": pk },
        Limit: 50,
        ExclusiveStartKey: key,
        ConsistentRead: true,
      }),
    );
    return {
      items: (result.Items ?? []) as Row[],
      cursor: result.LastEvaluatedKey
        ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString(
            "base64url",
          )
        : undefined,
    };
  }
}
/** Development/test adapter only. It is NOT a durable production database. */
export class MemoryStore implements Store {
  readonly provider = "memory";
  readonly capabilities = requiredCapabilities;
  private rows = new Map<string, Row>();
  /** Read one row; absence returns undefined. Durable reads use ConsistentRead. */
  async get(pk: string, sk: string) {
    return structuredClone(this.rows.get(JSON.stringify([pk, sk])));
  }
  /** Apply all version-guarded writes atomically; conflicts never commit a partial transaction. */
  async transact(writes: Write[]) {
    const keys = new Set<string>();
    for (const w of writes) {
      const key = JSON.stringify([w.row.pk, w.row.sk]);
      if (keys.has(key)) throw new Error("Duplicate transaction key");
      keys.add(key);
      const old = this.rows.get(key);
      if (w.expected === null ? !!old : old?.version !== w.expected)
        throw new Conflict();
    }
    for (const w of writes) {
      const key = JSON.stringify([w.row.pk, w.row.sk]);
      if (w.delete) this.rows.delete(key);
      else this.rows.set(key, structuredClone(w.row));
    }
  }
  /** Return up to 50 rows and a cursor bound to this partition; reject cross-partition cursors. */
  async list(pk: string, cursor?: string) {
    let after = "";
    if (cursor) {
      try {
        const key = JSON.parse(Buffer.from(cursor, "base64url").toString());
        if (key.pk !== pk || typeof key.sk !== "string") throw 0;
        after = key.sk;
      } catch {
        throw new HttpError(400, "Invalid cursor");
      }
    }
    const all = [...this.rows.values()]
      .filter((r) => r.pk === pk && r.sk > after)
      .sort((a, b) => (a.sk < b.sk ? -1 : 1));
    const items = all.slice(0, 50);
    return {
      items: structuredClone(items),
      cursor:
        all.length > 50
          ? Buffer.from(JSON.stringify({ pk, sk: items.at(-1)!.sk })).toString(
              "base64url",
            )
          : undefined,
    };
  }
}
