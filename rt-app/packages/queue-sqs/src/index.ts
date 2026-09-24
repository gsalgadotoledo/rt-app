import {
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import {
  validateMessage,
  FailureTokens,
  validateFailureLimit,
  type FailedMessage,
  type QueueAdapter,
  type QueueMessage,
  type Delivery,
} from "@gsalgadotoledo/rt-app-queue";

/** Standard SQS queues. Explicit DLQ URL; permissions and resources are provisioned separately. */
export class SQSQueue implements QueueAdapter {
  private failureTokens?: FailureTokens;
  private used = new Map<string, number>();
  private retrying = new Set<string>();
  readonly capabilities = {
    delayedRetry: true,
    leaseRenewal: true,
    durable: true,
    failedAdmin: false,
  };
  constructor(
    private client: Pick<SQSClient, "send">,
    private url: string,
    private deadLetterUrl: string,
    private visibilitySeconds = 60,
    adminSecret?: string,
  ) {
    if (adminSecret) {
      this.failureTokens = new FailureTokens(
        adminSecret,
        url + "|" + deadLetterUrl,
      );
      this.capabilities.failedAdmin = true;
    }
    for (const value of [url, deadLetterUrl])
      if (!value.startsWith("https://") || value.endsWith(".fifo"))
        throw new TypeError("Expected standard HTTPS SQS queue URL");
    if (
      url === deadLetterUrl ||
      !Number.isInteger(visibilitySeconds) ||
      visibilitySeconds < 1 ||
      visibilitySeconds > 43200
    )
      throw new TypeError("Invalid SQS configuration");
  }

  /** Explicit DLQ inspection reserves at most 10 messages for 60 seconds; no message is deleted. */
  async inspectFailures(limit: number): Promise<FailedMessage[]> {
    validateFailureLimit(limit);
    if (!this.failureTokens)
      throw new Error("Configure a shared queue admin secret first");
    const result = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.deadLetterUrl,
        MaxNumberOfMessages: limit,
        WaitTimeSeconds: 0,
        VisibilityTimeout: 60,
      }),
    );
    return (result.Messages ?? []).map((raw) => {
      const expires = Date.now() + 55000;
      let message: QueueMessage | null = null;
      try {
        message = validateMessage(JSON.parse(raw.Body ?? "null"));
      } catch {
        /* Poison data remains in the DLQ. */
      }
      return {
        id: message?.id ?? raw.MessageId ?? "invalid",
        message,
        retryable: !!message && !!raw.ReceiptHandle,
        token: this.failureTokens!.seal(
          { receipt: raw.ReceiptHandle, message },
          expires,
        ),
        expiresAt: new Date(expires).toISOString(),
      };
    });
  }

  /** Confirm publish before deleting the DLQ copy. Ambiguous network failures may duplicate delivery. */
  async retryFailure(token: string) {
    if (!this.failureTokens)
      throw new Error("Configure a shared queue admin secret first");
    const value = this.failureTokens.open(token) as {
      receipt: string;
      message: QueueMessage;
    };
    if (!value.receipt) throw new Error("Message cannot be retried");
    const message = validateMessage(value.message);
    for (const [key, expires] of this.used)
      if (expires <= Date.now()) this.used.delete(key);
    if (this.used.has(token) || this.retrying.has(token))
      throw new Error("Retry already requested; refresh the list");
    this.retrying.add(token);
    try {
      await this.publish(message);
      // Do not repeat a confirmed send on this instance if deleting the DLQ copy fails.
      this.used.set(token, Date.now() + 60000);
      await this.client.send(
        new DeleteMessageCommand({
          QueueUrl: this.deadLetterUrl,
          ReceiptHandle: value.receipt,
        }),
      );
    } finally {
      this.retrying.delete(token);
    }
  }

  async publish(message: QueueMessage) {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.url,
        MessageBody: JSON.stringify(validateMessage(message)),
      }),
    );
  }

  async receive(limit: number, signal?: AbortSignal): Promise<Delivery[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10)
      throw new TypeError("Invalid receive limit");
    const result = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.url,
        MaxNumberOfMessages: limit,
        WaitTimeSeconds: 20,
        VisibilityTimeout: this.visibilitySeconds,
        MessageSystemAttributeNames: ["ApproximateReceiveCount"],
      }),
      { abortSignal: signal },
    );
    const deliveries: Delivery[] = [];
    for (const raw of result.Messages ?? []) {
      if (!raw.ReceiptHandle) throw new Error("Missing SQS receipt");
      const receipt = raw.ReceiptHandle;
      const ack = async () => {
        await this.client.send(
          new DeleteMessageCommand({
            QueueUrl: this.url,
            ReceiptHandle: receipt,
          }),
        );
      };
      const deadLetter = async () => {
        // Publish before deleting: ambiguous failures may duplicate DLQ entries, never silently lose work.
        await this.client.send(
          new SendMessageCommand({
            QueueUrl: this.deadLetterUrl,
            MessageBody: raw.Body ?? "null",
          }),
        );
        await ack();
      };
      let message: QueueMessage;
      try {
        message = validateMessage(JSON.parse(raw.Body ?? "null"));
      } catch {
        await deadLetter();
        continue;
      }
      const visibility = async (seconds: number) => {
        if (!Number.isInteger(seconds) || seconds < 0 || seconds > 43200)
          throw new TypeError("Invalid SQS visibility");
        await this.client.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: this.url,
            ReceiptHandle: receipt,
            VisibilityTimeout: seconds,
          }),
        );
      };
      deliveries.push({
        message,
        attempts: Math.max(
          1,
          Number(raw.Attributes?.ApproximateReceiveCount) || 1,
        ),
        ack,
        retry: visibility,
        extend: visibility,
        deadLetter,
      });
    }
    return deliveries;
  }
}
