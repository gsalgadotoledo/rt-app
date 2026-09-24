# Decisions, queues and distributed Features

Implementation plan (2026-09-23): keep three independent contracts, ship optional providers, exercise failures with fake clients, then run the complete build and coverage gate. No cloud resources, paid model calls or package publication are part of this implementation.

## Choice

`choice` evaluates context plus a question and closed options. `choice-jev` uses the official TypeSafe System One API. `choice-transformers` accepts an existing Transformers.js zero-shot pipeline for an open model. The latter is an NLI classifier, not a Jev clone; its scores are explicitly uncalibrated and require review by default. AnyJev is an interesting Python alternative, but no AnyJev runtime is installed or claimed as implemented here.

```ts
import { Choice } from '@gsalgadotoledo/rt-app-choice';
import { JevProvider } from '@gsalgadotoledo/rt-app-choice-jev';
const choices = new Choice(new JevProvider(process.env.TYPESAFE_API_KEY!));
const result = await choices.decide({
  context: 'My invoice was charged twice',
  question: 'Which team should handle this?',
  options: [{id:'billing',description:'Invoices and payments'},{id:'technical'}],
});
// result.selected, probabilities, confidence, model, semantics, requiresReview
// Only act if result.accepted and ordinary application authorization allows the action.
```

Use `createApplication({ ...options, choiceProvider })` to expose `app.choice` and register POST `/choice/decide`. This requires an explicit `choice.decide` grant; admin CLI/MCP discovers its tool metadata. No provider means no new endpoint and no model startup/download. Provider output is validated, with no fabricated probabilities or silent fallback. A high score is not guaranteed accuracy. Test calibration on your own labeled data; provider confidence is kept separate from the winner's probability. The current primitive is Choice; Score/Noul are not implemented yet.

```ts
import { pipeline } from '@huggingface/transformers';
import { TransformersChoiceProvider } from '@gsalgadotoledo/rt-app-choice-transformers';
const classifier = await pipeline('zero-shot-classification', 'Xenova/mobilebert-uncased-mnli');
const local = new Choice(new TransformersChoiceProvider(
  async (text, labels, options) => classifier(text, labels, options),
  'Xenova/mobilebert-uncased-mnli',
));
```

The application installs Transformers.js and owns model download/cache/lifecycle. The adapter does not bundle weights. It checks cancellation before and after inference; this does not interrupt a running native inference kernel.

## Queue

```ts
import { Queue, MemoryQueue } from '@gsalgadotoledo/rt-app-queue';
const queue = new Queue(new MemoryQueue());
await queue.send('invoice.created', {invoiceId:'inv-123'}, {id:'invoice/inv-123/v1'});
await queue.workOnce(async delivery => {
  await processInvoice(delivery.message.payload);
}, {concurrency:4, maxAttempts:5});
// Long-lived worker: queue.run(handler, options, abortController.signal).
```

Pass `queueAdapter` to `createApplication` for `app.queue`. This is opt-in: production never silently falls back to an in-memory queue. Workers run in their own process and are not started by request handling. Queue messages are JSON, at most 240 KB. Stable message IDs identify logical work, but do not guarantee broker deduplication. Reuse business idempotency keys at the side-effect boundary. Do not wrap every handler failure in automatic idempotency success: ambiguous external effects must be reconciled.

| Adapter | Durability | Retry | Failed messages |
|---|---|---|---|
| MemoryQueue | Process-local only | Visibility + delay | Bounded local diagnostic list |
| SQSQueue | Standard SQS | Visibility + jitter backoff | Explicit configured DLQ |
| RabbitQueue | Requires durable quorum queue | Immediate requeue | Broker DLX/DLQ |

SQS:
```ts
import { SQSClient } from '@aws-sdk/client-sqs';
import { SQSQueue } from '@gsalgadotoledo/rt-app-queue-sqs';
const adapter = new SQSQueue(new SQSClient({}), queueUrl, deadLetterUrl, 60);
```

SQS uses long polling and manual delete after success. Configure IAM SendMessage/ReceiveMessage/DeleteMessage/ChangeMessageVisibility and a broker redrive policy. FIFO is deliberately rejected: it requires a separate ordering/grouping contract. When manually moving to the DLQ, publish precedes delete; an ambiguous acknowledgement can duplicate the DLQ item. Malformed envelopes are quarantined. This adapter is for pull workers; a native Lambda SQS event-source mapping needs its own partial-batch handler, not an infinite polling loop inside Lambda.

RabbitMQ:
```ts
import amqp from 'amqplib';
import { createRabbitQueue } from '@gsalgadotoledo/rt-app-queue-rabbitmq';
const connection = await amqp.connect(process.env.AMQP_URL!);
const channel = await connection.createConfirmChannel();
const adapter = await createRabbitQueue(channel, 'jobs', 'jobs.failed');
// Close channel/connection after the worker drains.
```

The explicit helper declares durable quorum queues and a dead-letter route. For managed topology, construct RabbitQueue with a dedicated confirm channel and preconfigured quorum queue instead. Delivery attempts use x-delivery-count; classic queues do not satisfy this retry-count contract. Configure broker delivery limits and reliable dead-letter policies. basic.get bounds outstanding work but trades throughput for simplicity; it is not a streaming prefetch consumer. Unsupported delayed retries/lease renewal reject. Publishing is serialized; concurrent publication gets a busy error instead of unbounded buffering.

Workers limit in-flight work (1–10), retry failed handlers up to maxAttempts, and acknowledge only success. Abort stops new pulls and drains active work. Lease-based adapters require handlers to finish within visibility or call delivery.extend(seconds) periodically; expiry permits duplicates. Ack failures surface without blindly rerunning a completed side effect. Broker/network errors surface to the supervisor. No exactly-once delivery claim, automatic outbox, cross-service transaction or automatic topology deployment.

## Microservices

```ts
import { createMicroservice, SessionAuthenticator } from '@gsalgadotoledo/rt-app-microservices';
const service = createMicroservice({
  features: [inventory.feature()],
  authenticate: new SessionAuthenticator(tokens, id => users.getCurrentActor(id)),
  observe: metric => app.observer.recordRequest({
    method:'POST', url:metric.route, status:metric.status, durationMs:metric.durationMs,
  }),
});
// Express/Lambda adapter maps HTTP to the existing contracts.Request:
const response = await service.handle(request);
```

`users.getCurrentActor` above is an application-provided authoritative lookup, not a new Users API method. SessionAuthenticator verifies the existing JWT signature/issuer/audience and checks current active/tokenVersion through that resolver. For distributed asymmetric tokens use SignedJwtAuthenticator or remoteJwtAuthenticator with a fixed HTTPS JWKS URL, issuer, audience and trusted claim-to-actor resolver. Never choose keys from untrusted JWT jku values. Do not share HMAC signing secrets with every service when independent verification keys are available. JWKS key rotation is handled by jose; revocation/current permissions remain the resolver's responsibility.

The host preserves guest/authenticated/owner/permission and explicitGrant policies. Metered endpoints fail closed unless invokeMetered is provided to reserve and settle against the authoritative subscription service. It generates correlation IDs and emits route-level telemetry without trusting forwarded user-ID headers. Framework HTTP Request normalization/body limits remain the transport adapter's responsibility. Migrations are run separately before serving.

`remoteFeature(feature, 'https://service.example')` replaces handlers with remote HTTP calls and keeps route ACL/tool metadata. Only Authorization is forwarded, never cookies or caller-provided actor headers. Remote services independently verify tokens. Configure an accepted audience or token exchange; the proxy does not mint broader tokens. There are no automatic mutation retries. This is HTTP Feature hosting/proxying, not a deployed server or gRPC implementation.

## Verified references

- [Jev official API](https://docs.typesafe.ai/api), [Choice semantics](https://docs.typesafe.ai/primitives/choice), [confidence](https://docs.typesafe.ai/confidence).
- [AnyJev research implementation](https://github.com/nokia-applied-research/AnyJev).
- [Transformers.js zero-shot pipeline](https://huggingface.co/docs/transformers.js/api/pipelines).
- [SQS visibility / at-least-once](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html).
- [RabbitMQ confirmations](https://www.rabbitmq.com/docs/confirms), [amqplib API](https://amqp-node.github.io/amqplib/channel_api.html).
- [gRPC](https://grpc.io/docs/what-is-grpc/) is RPC transport, not a durable queue adapter.

## Admin: failed messages

A configured `queueAdapter` registers the Queue module (`queue` must be enabled if you supply an explicit modules list). The admin provides **Load up to 10 messages → Review & retry → Confirm retry**. These routes are owner-only; ordinary users cannot inspect payloads or redrive messages. The UI never polls or automatically retries. Sending back to the queue is not proof that the worker completed it.

- MemoryQueue: atomic move from the in-memory failed list into the pending list, preserving the ID. Capacity failures leave the failed message intact. Local state disappears on restart.
- SQSQueue: configure a stable, server-only secret of at least 32 characters as the fifth constructor argument: `new SQSQueue(client, queueUrl, dlqUrl, 60, process.env.QUEUE_ADMIN_SECRET)`. All API instances must share it. Inspection receives a bounded DLQ batch with 60-second visibility. Sealed receipts expire after 55 seconds and can be retried across API instances. IAM needs ReceiveMessage/DeleteMessage on the DLQ and SendMessage on the source queue. Confirmed send precedes DLQ deletion. Network ambiguity or cross-instance repeated requests can still duplicate delivery; consumers must deduplicate the original logical message ID.
- RabbitQueue: `createRabbitQueue(channel, source, dlq)` enables inspection, or pass the DLQ as the third constructor argument. Inspections hold up to 10 unacked deliveries for 60 seconds; unused messages are requeued. Retry needs the same long-lived API instance/channel. A restarted/other instance rejects its stale reservation; load again after expiry. Use session affinity with multiple Rabbit API instances. Do not deploy this reservation implementation on short-lived Lambda invocations. Confirmed republish precedes ack; failures preserve/requeue the DLQ delivery.

`GET /queue/status` reports support; `POST /queue/failed/inspect` accepts `{limit:10}`; `POST /queue/failed/retry` accepts the returned `{token}`. The admin uses their existing `/admin/app` copies. Inspection is POST because broker reservation is a side effect. Batches are not exhaustive pagination: reserved messages may be absent, and an empty response does not prove that a broker DLQ is empty. Invalid envelopes remain quarantined and cannot be manually republished by this UI. No destructive purge button is exposed.
