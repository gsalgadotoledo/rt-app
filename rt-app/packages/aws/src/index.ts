import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import {
  SecretsManagerClient,
  PutSecretValueCommand,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import {
  SQSClient,
  CreateQueueCommand,
  GetQueueUrlCommand,
} from "@aws-sdk/client-sqs";
import { DynamoDBClient, CreateTableCommand } from "@aws-sdk/client-dynamodb";
import {
  type InfraDriver,
  type AwsSettings,
  type Credentials,
  type ResourceSpec,
} from "@gsalgadotoledo/rt-app-infra";
import { HttpError } from "@gsalgadotoledo/rt-app-contracts";
export class AwsInfraDriver implements InfraDriver {
  readonly simulation = false;
  // Vault always uses the execution role, never the submitted credentials.
  private vault = new SecretsManagerClient({
    maxAttempts: 2,
    requestHandler: { requestTimeout: 5000 },
  });
  constructor(private credentialSecretArn?: string) {}
  async saveCredentials(credentials: Credentials) {
    if (!this.credentialSecretArn)
      throw new HttpError(
        503,
        "The deployment has not configured the AWS credential store",
      );
    const response = await this.vault.send(
      new PutSecretValueCommand({
        SecretId: this.credentialSecretArn,
        SecretString: JSON.stringify(credentials),
      }),
    );
    if (!response.VersionId) throw new Error("Missing secret version");
    return response.VersionId;
  }
  private async config(settings: AwsSettings) {
    let credentials: Credentials | undefined;
    if (settings.mode === "keys") {
      if (!this.credentialSecretArn || !settings.secretVersion)
        throw new HttpError(503, "Credentials are not configured");
      const secret = await this.vault.send(
        new GetSecretValueCommand({
          SecretId: this.credentialSecretArn,
          VersionId: settings.secretVersion,
        }),
      );
      credentials = JSON.parse(secret.SecretString ?? "{}");
      if (!credentials?.accessKeyId || !credentials.secretAccessKey)
        throw new Error("Invalid stored credentials");
    }
    return {
      region: settings.region,
      credentials,
      maxAttempts: 1,
      requestHandler: { connectionTimeout: 1500, requestTimeout: 6000 },
    };
  }
  async identity(settings: AwsSettings) {
    const client = new STSClient(await this.config(settings));
    try {
      const r = await client.send(new GetCallerIdentityCommand({}));
      if (!r.Account || !r.Arn) throw new Error("Missing AWS identity");
      if (r.Arn.endsWith(":root"))
        throw new HttpError(400, "Root credentials are not allowed");
      return { account: r.Account, arn: r.Arn };
    } finally {
      client.destroy();
    }
  }
  async create(settings: AwsSettings, spec: ResourceSpec, planId: string) {
    const config = await this.config(settings);
    if (spec.kind === "queue") {
      const client = new SQSClient(config);
      try {
        try {
          await client.send(new GetQueueUrlCommand({ QueueName: spec.name }));
          throw new HttpError(409, "The queue already exists; use another name");
        } catch (e: any) {
          if (
            ![
              "QueueDoesNotExist",
              "AWS.SimpleQueueService.NonExistentQueue",
            ].includes(e.name)
          )
            throw e;
        }
        const r = await client.send(
          new CreateQueueCommand({
            QueueName: spec.name,
            Attributes: { SqsManagedSseEnabled: "true" },
            tags: { "rt-app:managed": "true", "rt-app:plan": planId },
          }),
        );
        if (!r.QueueUrl) throw new Error("Missing queue URL");
        return { id: r.QueueUrl, status: "available" };
      } finally {
        client.destroy();
      }
    }
    const client = new DynamoDBClient(config);
    try {
      const r = await client.send(
        new CreateTableCommand({
          TableName: spec.name,
          BillingMode: "PAY_PER_REQUEST",
          AttributeDefinitions: [
            { AttributeName: "pk", AttributeType: "S" },
            { AttributeName: "sk", AttributeType: "S" },
          ],
          KeySchema: [
            { AttributeName: "pk", KeyType: "HASH" },
            { AttributeName: "sk", KeyType: "RANGE" },
          ],
          SSESpecification: { Enabled: true },
          Tags: [
            { Key: "rt-app:managed", Value: "true" },
            { Key: "rt-app:plan", Value: planId },
          ],
        }),
      );
      return {
        id: r.TableDescription?.TableArn ?? spec.name,
        status: r.TableDescription?.TableStatus ?? "CREATING",
      };
    } finally {
      client.destroy();
    }
  }
}

export { AwsMonitor } from "./monitor.js";
