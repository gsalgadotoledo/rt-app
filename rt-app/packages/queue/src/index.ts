import { HttpError, type Feature } from "@gsalgadotoledo/rt-app-contracts";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { canonical } from "@gsalgadotoledo/rt-app-cache";

export interface QueueMessage {
  id: string;
  type: string;
  payload: unknown;
  createdAt: string;
  traceId?: string;
}
export interface Delivery {
  message: QueueMessage;
  attempts: number;
  ack(): Promise<void>;
  retry(delaySeconds: number): Promise<void>;
  deadLetter(): Promise<void>;
  /** Renew long work explicitly. Unsupported brokers reject rather than pretend. */
  extend(seconds: number): Promise<void>;
}
export interface FailedMessage {
  token: string;
  id: string;
  message: QueueMessage | null;
  retryable: boolean;
  expiresAt?: string;
}

export interface QueueAdapter {
  readonly capabilities: {
    delayedRetry: boolean;
    leaseRenewal: boolean;
    durable: boolean;
    failedAdmin?: boolean;
  };
  inspectFailures?(limit: number): Promise<FailedMessage[]>;
  retryFailure?(token: string): Promise<void>;
  publish(message: QueueMessage): Promise<void>;
  receive(limit: number, signal?: AbortSignal): Promise<Delivery[]>;
}

/** JSON-only envelopes, stable logical IDs and bounded payloads across transports. */
export function validateMessage(message: QueueMessage): QueueMessage {
  if (
    !message ||
    typeof message.id !== "string" ||
    !message.id.trim() ||
    message.id.length > 200 ||
    typeof message.type !== "string" ||
    !message.type.trim() ||
    message.type.length > 120 ||
    typeof message.createdAt !== "string" ||
    !Number.isFinite(Date.parse(message.createdAt)) ||
    (message.traceId !== undefined &&
      (typeof message.traceId !== "string" || message.traceId.length > 200))
  )
    throw new TypeError("Invalid queue message");
  const serialized = canonical(message as any);
  if (Buffer.byteLength(serialized) > 240000)
    throw new TypeError("Queue message exceeds 240 KB");
  return JSON.parse(serialized);
}

export interface WorkerOptions {
  concurrency?: number;
  maxAttempts?: number;
  baseDelaySeconds?: number;
  maxDelaySeconds?: number;
  idleMs?: number;
}

/** At-least-once delivery. Handlers own business idempotency; enqueue acceptance is not completion. */
export class Queue {
  private working = false;
  constructor(readonly adapter: QueueAdapter) {}

  /** Return the logical message ID. Reuse a supplied ID on retries; brokers can still duplicate it. */
  async send(
    type: string,
    payload: unknown,
    options: { id?: string; traceId?: string } = {},
  ) {
    const message = validateMessage({
      id: options.id ?? randomUUID(),
      type,
      payload,
      createdAt: new Date().toISOString(),
      ...(options.traceId ? { traceId: options.traceId } : {}),
    });
    await this.adapter.publish(message);
    return message.id;
  }

  /** Pull only as many messages as can execute; acknowledge strictly after successful work. */
  async workOnce(
    handler: (delivery: Delivery) => Promise<void>,
    options: WorkerOptions = {},
    signal?: AbortSignal,
  ) {
    const concurrency = options.concurrency ?? 4,
      maxAttempts = options.maxAttempts ?? 5,
      base = options.baseDelaySeconds ?? 1,
      max = options.maxDelaySeconds ?? 60;
    if (
      !Number.isInteger(concurrency) ||
      concurrency < 1 ||
      concurrency > 10 ||
      !Number.isInteger(maxAttempts) ||
      maxAttempts < 1 ||
      ![base, max].every((n) => Number.isInteger(n) && n >= 0 && n <= 43200) ||
      base > max
    )
      throw new TypeError("Invalid worker limits");
    if (this.working) throw new Error("Worker already receiving");
    signal?.throwIfAborted();
    this.working = true;
    try {
      const deliveries = await this.adapter.receive(concurrency, signal);
      const outcomes = await Promise.allSettled(
        deliveries.map(async (delivery) => {
          try {
            await handler(delivery);
          } catch {
            if (delivery.attempts >= maxAttempts) await delivery.deadLetter();
            else
              await delivery.retry(
                this.adapter.capabilities.delayedRetry
                  ? Math.floor(
                      Math.random() *
                        (Math.min(
                          max,
                          base * 2 ** Math.min(delivery.attempts - 1, 20),
                        ) +
                          1),
                    )
                  : 0,
              );
            return;
          }
          // If acknowledgement fails, do not immediately retry a successful side effect.
          await delivery.ack();
        }),
      );
      const failures = outcomes.filter(
        (x) => x.status === "rejected",
      ) as PromiseRejectedResult[];
      if (failures.length)
        throw new AggregateError(
          failures.map((x) => x.reason),
          "Queue settlement failed",
        );
      return deliveries.length;
    } finally {
      this.working = false;
    }
  }

  /** Register owner-only DLQ controls. Inspection is POST because brokers may reserve messages. */
  feature(): Feature {
    const supported = this.adapter.capabilities.failedAdmin === true;
    return {
      id: "queue",
      migrations: [],
      admin: {
        id: "queue",
        title: "Queue",
        resource: "queue.read",
        path: "/queue/status",
        component: "queue",
        ownerOnly: true,
        fields: [],
        actions: [],
      },
      endpoints: [
        {
          method: "GET",
          path: "/queue/status",
          resource: "queue.read",
          access: "owner",
          handle: async () => ({
            supported,
            capabilities: this.adapter.capabilities,
          }),
        },
        {
          method: "POST",
          path: "/queue/failed/inspect",
          resource: "queue.inspect",
          access: "owner",
          handle: async (c) => {
            if (!supported || !this.adapter.inspectFailures)
              throw new HttpError(
                501,
                "Failed-message inspection is not configured",
              );
            const limit = (c.request.body as { limit?: number })?.limit ?? 10;
            if (!Number.isInteger(limit) || limit < 1 || limit > 10)
              throw new HttpError(400, "Limit must be between 1 and 10");
            return { items: await this.adapter.inspectFailures(limit) };
          },
        },
        {
          method: "POST",
          path: "/queue/failed/retry",
          resource: "queue.retry",
          access: "owner",
          handle: async (c) => {
            if (!supported || !this.adapter.retryFailure)
              throw new HttpError(
                501,
                "Failed-message retry is not configured",
              );
            const token = (c.request.body as { token?: string })?.token;
            if (typeof token !== "string" || !token || token.length > 400000)
              throw new HttpError(400, "Invalid retry token");
            await this.adapter.retryFailure(token);
            return { queued: true };
          },
        },
      ],
    };
  }

  /** Abort stops new pulls; current work drains. Broker failures surface to the supervisor. */
  async run(
    handler: (delivery: Delivery) => Promise<void>,
    options: WorkerOptions = {},
    signal: AbortSignal,
  ) {
    const idleMs = options.idleMs ?? 250;
    if (!Number.isFinite(idleMs) || idleMs < 1)
      throw new TypeError("Invalid poll interval");
    while (!signal.aborted) {
      try {
        if (!(await this.workOnce(handler, options, signal)))
          await sleep(idleMs, undefined, { signal });
      } catch (error) {
        if (signal.aborted) return;
        throw error;
      }
    }
  }
}

/** Bounded ephemeral adapter for development; no durability claim across process restarts. */
export class MemoryQueue implements QueueAdapter {
  readonly capabilities = {
    delayedRetry: true,
    leaseRenewal: true,
    durable: false,
    failedAdmin: true,
  };
  private entries: Array<{
    message: QueueMessage;
    attempts: number;
    available: number;
    receipt?: string;
  }> = [];
  private failed: Array<{ token: string; message: QueueMessage }> = [];
  constructor(
    private capacity = 1000,
    private leaseSeconds = 30,
    private clock = Date.now,
  ) {
    if (
      !Number.isInteger(capacity) ||
      capacity < 1 ||
      !Number.isInteger(leaseSeconds) ||
      leaseSeconds < 1
    )
      throw new TypeError("Invalid memory queue limits");
  }

  async publish(message: QueueMessage) {
    if (this.entries.length >= this.capacity)
      throw new Error("Queue capacity exceeded");
    this.entries.push({
      message: validateMessage(message),
      attempts: 0,
      available: this.clock(),
    });
  }

  async receive(limit: number, signal?: AbortSignal): Promise<Delivery[]> {
    signal?.throwIfAborted();
    if (!Number.isInteger(limit) || limit < 1 || limit > 10)
      throw new TypeError("Invalid receive limit");
    return this.entries
      .filter((e) => e.available <= this.clock())
      .slice(0, limit)
      .map((entry) => {
        const receipt = randomUUID();
        entry.receipt = receipt;
        entry.attempts++;
        entry.available = this.clock() + this.leaseSeconds * 1000;
        const check = () => {
          if (
            entry.receipt !== receipt ||
            !this.entries.includes(entry) ||
            entry.available <= this.clock()
          )
            throw new Error("Stale queue receipt");
        };
        const delay = (seconds: number) => {
          if (!Number.isInteger(seconds) || seconds < 0 || seconds > 43200)
            throw new TypeError("Invalid visibility delay");
        };
        return {
          message: structuredClone(entry.message),
          attempts: entry.attempts,
          ack: async () => {
            check();
            this.entries.splice(this.entries.indexOf(entry), 1);
          },
          retry: async (seconds) => {
            check();
            delay(seconds);
            entry.receipt = undefined;
            entry.available = this.clock() + seconds * 1000;
          },
          extend: async (seconds) => {
            check();
            delay(seconds);
            entry.available = this.clock() + seconds * 1000;
          },
          deadLetter: async () => {
            check();
            if (this.failed.length >= this.capacity)
              throw new Error("Dead-letter capacity exceeded");
            this.failed.push({ token: randomUUID(), message: entry.message });
            this.entries.splice(this.entries.indexOf(entry), 1);
          },
        };
      });
  }

  /** Local inspection is a non-destructive bounded snapshot. */
  async inspectFailures(limit: number): Promise<FailedMessage[]> {
    validateFailureLimit(limit);
    return this.failed
      .slice(0, limit)
      .map((e) => ({
        token: e.token,
        id: e.message.id,
        message: structuredClone(e.message),
        retryable: true,
      }));
  }

  /** Atomically move a local failed message back to pending; a reused token cannot enqueue twice. */
  async retryFailure(token: string) {
    const index = this.failed.findIndex((e) => e.token === token);
    if (index < 0)
      throw new HttpError(
        409,
        "Message is no longer available; refresh the list",
      );
    if (this.entries.length >= this.capacity)
      throw new HttpError(409, "Queue capacity exceeded");
    this.entries.push({
      message: this.failed[index].message,
      attempts: 0,
      available: this.clock(),
    });
    this.failed.splice(index, 1);
  }

  /** Diagnostic copies only; production dead letters belong to the broker's configured DLQ. */
  deadLetters() {
    return structuredClone(this.failed.map((e) => e.message));
  }
}

/** Keep broker inspection bounded and predictable. */
export function validateFailureLimit(limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10)
    throw new HttpError(400, "Limit must be between 1 and 10");
}
export * from "./failure-token.js";
