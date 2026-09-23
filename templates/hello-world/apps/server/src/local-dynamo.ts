import {
  DynamoDBClient,
  CreateTableCommand,
  DescribeTableCommand,
} from "@aws-sdk/client-dynamodb";
import { DynamoStore } from "@gsalgadotoledo/rt-app-dynamodb";
export async function localDynamo() {
  const endpoint = process.env.DYNAMODB_ENDPOINT ?? "http://127.0.0.1:8000";
  if (!["127.0.0.1", "localhost"].includes(new URL(endpoint).hostname))
    throw new Error("Local mode only accepts a loopback DynamoDB endpoint");
  process.env.AWS_ACCESS_KEY_ID = "localdemo";
  process.env.AWS_SECRET_ACCESS_KEY = "localdemo";
  process.env.AWS_REGION = "us-east-1";
  const table = process.env.TABLE_NAME ?? "rt-app-local",
    client = new DynamoDBClient({ endpoint, region: "us-east-1" });
  try {
    await client.send(new DescribeTableCommand({ TableName: table }));
  } catch (error: any) {
    if (error.name !== "ResourceNotFoundException") throw error;
    await client.send(
      new CreateTableCommand({
        TableName: table,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" },
        ],
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
      }),
    );
  } finally {
    client.destroy();
  }
  return new DynamoStore(table, { endpoint, region: "us-east-1" });
}
