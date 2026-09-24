import { randomUUID } from "node:crypto";
import type { ConfirmChannel } from "amqplib";
import {
  validateMessage,
  validateFailureLimit,
  type FailedMessage,
  type QueueAdapter,
  type QueueMessage,
  type Delivery,
} from "@gsalgadotoledo/rt-app-queue";

/** Dedicated confirm channel and pre-provisioned quorum queue with a dead-letter policy required. */
export class RabbitQueue implements QueueAdapter {
  readonly capabilities = {
    delayedRetry: false,
    leaseRenewal: false,
    durable: true,
    failedAdmin: false,
  };
  private publishing = false;
  private inspections = new Map<
    string,
    {
      raw: any;
      item: FailedMessage;
      timer: ReturnType<typeof setTimeout>;
      busy: boolean;
    }
  >();
  private inspecting = false;
  constructor(
    private channel: ConfirmChannel,
    private queue: string,
    private deadLetterQueue?: string,
  ) {
    this.capabilities.failedAdmin = !!deadLetterQueue;
    if (deadLetterQueue === queue)
      throw new TypeError("Source and DLQ must differ");
    if (!queue.trim()) throw new TypeError("Queue name required");
  }

  /** Reserve a bounded batch on this channel. Unused deliveries return to the DLQ after 60 seconds. */
  async inspectFailures(limit: number): Promise<FailedMessage[]> {
    validateFailureLimit(limit);
    if (!this.deadLetterQueue)
      throw new Error("Configure a dead-letter queue first");
    if (this.inspecting) throw new Error("Inspection already running");
    this.inspecting = true;
    try {
      // Reuse outstanding reservations instead of consuming another batch on every refresh.
      if (this.inspections.size)
        return [...this.inspections.values()]
          .slice(0, limit)
          .map((e) => structuredClone(e.item));
      for (let i = 0; i < limit; i++) {
        const raw = await this.channel.get(this.deadLetterQueue, {
          noAck: false,
        });
        if (!raw) break;
        let message: QueueMessage | null = null;
        try {
          message = validateMessage(JSON.parse(raw.content.toString("utf8")));
        } catch {
          /* Keep poison messages quarantined. */
        }
        const token = randomUUID();
        const item = {
          token,
          id: message?.id ?? "invalid",
          message,
          retryable: !!message,
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        };
        const timer = setTimeout(() => {
          const entry = this.inspections.get(token);
          if (entry && !entry.busy) {
            this.inspections.delete(token);
            try {
              this.channel.nack(raw, false, true);
            } catch {
              /* A closed channel requeues unacked messages. */
            }
          }
        }, 60000);
        timer.unref();
        this.inspections.set(token, { raw, item, timer, busy: false });
      }
      return [...this.inspections.values()].map((e) => structuredClone(e.item));
    } finally {
      this.inspecting = false;
    }
  }

  /** Confirm republish before acknowledging the reserved DLQ delivery; preserve its logical ID. */
  async retryFailure(token: string) {
    const entry = this.inspections.get(token);
    if (!entry || entry.busy)
      throw new Error(
        "Reservation expired or retry already requested; load messages again",
      );
    if (!entry.item.message)
      throw new Error("Invalid messages cannot be retried");
    entry.busy = true;
    clearTimeout(entry.timer);
    try {
      await this.publish(entry.item.message);
      this.channel.ack(entry.raw);
    } catch (error) {
      try {
        this.channel.nack(entry.raw, false, true);
      } catch {
        /* Connection closure requeues it. */
      }
      throw error;
    } finally {
      this.inspections.delete(token);
    }
  }

  /** Serialize publications for bounded buffering; callers retry explicit backpressure upstream. */
  async publish(message: QueueMessage) {
    if (this.publishing) throw new Error("Rabbit publisher busy");
    const body = Buffer.from(JSON.stringify(validateMessage(message)));
    this.publishing = true;
    try {
      await new Promise<void>((resolve, reject) => {
        this.channel.sendToQueue(
          this.queue,
          body,
          {
            persistent: true,
            messageId: message.id,
            contentType: "application/json",
          },
          (error) =>
            error ? reject(new Error("Rabbit publish rejected")) : resolve(),
        );
      });
    } finally {
      this.publishing = false;
    }
  }

  /** Pull bounded batches using basic.get; no unbounded push-consumer buffer. */
  async receive(limit: number, signal?: AbortSignal): Promise<Delivery[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10)
      throw new TypeError("Invalid receive limit");
    const deliveries: Delivery[] = [];
    try {
      for (let i = 0; i < limit; i++) {
        signal?.throwIfAborted();
        const raw = await this.channel.get(this.queue, { noAck: false });
        if (!raw) break;
        let message: QueueMessage;
        try {
          message = validateMessage(JSON.parse(raw.content.toString("utf8")));
        } catch {
          this.channel.nack(raw, false, false);
          continue;
        }
        let settled = false;
        const settle = (operation: () => void) => {
          if (settled) throw new Error("Delivery already settled");
          operation();
          settled = true;
        };
        const count = Number(raw.properties.headers?.["x-delivery-count"] ?? 0);
        deliveries.push({
          message,
          attempts: Number.isFinite(count) ? Math.max(1, count + 1) : 1,
          ack: async () => settle(() => this.channel.ack(raw)),
          retry: async (seconds) => {
            if (seconds !== 0)
              throw new Error("Delayed retries unsupported by Rabbit adapter");
            settle(() => this.channel.nack(raw, false, true));
          },
          deadLetter: async () =>
            settle(() => this.channel.nack(raw, false, false)),
          extend: async () => {
            throw new Error("Lease renewal unsupported by Rabbit adapter");
          },
        });
      }
    } catch (error) {
      await Promise.allSettled(deliveries.map((d) => d.retry(0)));
      throw error;
    }
    return deliveries;
  }
}

/** Provision a durable quorum queue plus DLQ; mismatched existing arguments fail instead of changing topology. */
export async function createRabbitQueue(
  channel: ConfirmChannel,
  queue: string,
  deadLetterQueue: string,
): Promise<RabbitQueue> {
  if (!queue.trim() || !deadLetterQueue.trim() || queue === deadLetterQueue)
    throw new TypeError("Distinct queue and DLQ names required");

  await channel.assertQueue(deadLetterQueue, {
    durable: true,
    arguments: { "x-queue-type": "quorum" },
  });
  await channel.assertQueue(queue, {
    durable: true,
    arguments: {
      "x-queue-type": "quorum",
      "x-dead-letter-exchange": "",
      "x-dead-letter-routing-key": deadLetterQueue,
    },
  });
  return new RabbitQueue(channel, queue, deadLetterQueue);
}
